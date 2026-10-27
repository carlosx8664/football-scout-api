/**
 * POST /api/push/subscribe
 *
 * Body: { subscription: PushSubscriptionJSON }
 *
 * Stores one entry per device so `scripts/push-notify.js` can fan out arb alerts.
 * Re-subscribing from the same browser overwrites its own entry, so this is
 * idempotent and the client can call it on every load.
 */
import {
  SUBSCRIPTION_LIMIT,
  countSubscriptions,
  isUsableSubscription,
  kvOf,
  originOf,
  storageKey,
  subscriptionId,
} from "./_store.js";

function json(body, status = 200) {
  return Response.json(body, { status });
}

export async function onRequestPost({ request, env }) {
  const kv = kvOf(env);
  if (!kv) return json({ error: "FOOTBALL_DATA KV binding is not configured." }, 503);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Request body must be JSON." }, 400);
  }

  const { subscription } = payload ?? {};

  if (!isUsableSubscription(subscription)) {
    return json(
      { error: "A subscription needs an https endpoint and p256dh/auth keys." },
      400,
    );
  }

  const id = await subscriptionId(subscription.endpoint);
  const key = storageKey(id);

  // Re-subscribing replaces this device's own entry, so only new devices count
  // against the cap.
  const existing = await kv.get(key);
  if (!existing) {
    const count = await countSubscriptions(kv);
    if (count >= SUBSCRIPTION_LIMIT) {
      return json({ error: "Too many subscribed devices." }, 429);
    }
  }

  const record = {
    subscription: {
      endpoint: subscription.endpoint,
      // Keep exactly the fields the push service needs.
      keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    },
    origin: originOf(request),
    createdAt: new Date().toISOString(),
    userAgent: (request.headers.get("User-Agent") ?? "").slice(0, 200),
  };

  try {
    await kv.put(key, JSON.stringify(record));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: `KV write failed: ${message}` }, 502);
  }

  return json({ ok: true, id });
}
