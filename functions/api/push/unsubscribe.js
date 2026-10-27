/**
 * POST /api/push/unsubscribe
 *
 * Body: { endpoint: string }
 *
 * Removes this device's push subscription. Called right after the browser drops
 * its own subscription, so the sender stops trying this endpoint.
 */
import { kvOf, storageKey, subscriptionId } from "./_store.js";

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

  const endpoint = payload?.endpoint;
  if (typeof endpoint !== "string" || !endpoint) {
    return json({ error: "An endpoint is required." }, 400);
  }

  try {
    await kv.delete(storageKey(await subscriptionId(endpoint)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: `KV delete failed: ${message}` }, 502);
  }

  return json({ ok: true });
}
