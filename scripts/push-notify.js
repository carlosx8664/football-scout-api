// scripts/push-notify.js
// Fans new arbitrage opportunities out to every subscribed browser via the Web Push
// protocol, so a phone gets a notification that opens the matching arb card when tapped.
//
// Called by scripts/find-arbs.js (see sendPushAlert) with the arbs that already passed the
// alert gates. Subscriptions live in the FOOTBALL_DATA KV namespace, written by
// functions/api/push/subscribe.js, and are read here over the Cloudflare REST API because
// this runs in GitHub Actions rather than inside the Worker.
//
// Required environment:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY  `npm run push:keys` generates a pair.
//   VAPID_SUBJECT                         mailto:you@example.com (or an https URL)
//   CF_ACCOUNT_ID / CF_KV_NAMESPACE_ID / CF_API_TOKEN
//                                         KV read+write, to load and prune subscriptions.
//   SITE_ORIGIN                           fallback origin for links, e.g. https://oddtor.pages.dev
//
// The origin normally comes from the subscription itself, so the link matches whichever
// domain (pages.dev or a custom one) the user actually subscribed from.

import webpush from 'web-push';
import { arbDeepLinkKey } from '../shared/arb-key.js';

const CF_API = 'https://api.cloudflare.com/client/v4';
/** Must match PUSH_KEY_PREFIX in functions/api/push/_store.js. */
const PUSH_KEY_PREFIX = 'push-sub:';
/** A run that finds a wave of arbs should not lock up the phone with notifications. */
const MAX_PUSH_PER_RUN = Math.max(1, Number(process.env.PUSH_MAX_PER_RUN ?? '5') || 5);

const env = (name) => String(process.env[name] ?? '').trim();

export function pushConfigured() {
  return Boolean(
    env('VAPID_PUBLIC_KEY') &&
      env('VAPID_PRIVATE_KEY') &&
      env('VAPID_SUBJECT') &&
      env('CF_ACCOUNT_ID') &&
      env('CF_KV_NAMESPACE_ID') &&
      env('CF_API_TOKEN'),
  );
}

let vapidReady = false;

function configureVapid() {
  if (vapidReady) return;
  webpush.setVapidDetails(env('VAPID_SUBJECT'), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  // VAPID signing is per-process, so this only needs to happen once per run.
  vapidReady = true;
}

// ---------------------------------------------------------------------------
// KV access (Cloudflare REST, since this is not a Worker)
// ---------------------------------------------------------------------------

function kvUrl(suffix) {
  return (
    `${CF_API}/accounts/${env('CF_ACCOUNT_ID')}/storage/kv/namespaces/` +
    `${env('CF_KV_NAMESPACE_ID')}${suffix}`
  );
}

async function kvRequest(suffix, init = {}) {
  const res = await fetch(kvUrl(suffix), {
    ...init,
    headers: { Authorization: `Bearer ${env('CF_API_TOKEN')}`, ...(init.headers ?? {}) },
  });

  if (!res.ok) throw new Error(`KV ${suffix.split('?')[0]} -> HTTP ${res.status}`);
  return res;
}

/** Every stored subscription record, newest key order. Paginates on the KV cursor. */
async function loadSubscriptions() {
  const names = [];
  let cursor = null;

  for (let page = 0; page < 5; page += 1) {
    const query = new URLSearchParams({ prefix: PUSH_KEY_PREFIX, limit: '1000' });
    if (cursor) query.set('cursor', cursor);

    const payload = await (await kvRequest(`/keys?${query}`)).json();
    for (const entry of payload?.result ?? []) {
      if (entry?.name) names.push(entry.name);
    }

    cursor = payload?.result_info?.cursor ?? null;
    if (!cursor || (payload?.result ?? []).length === 0) break;
  }

  const records = [];
  for (const name of names) {
    try {
      const raw = await (await kvRequest(`/values/${encodeURIComponent(name)}`)).text();
      const parsed = JSON.parse(raw);
      if (parsed?.subscription?.endpoint) records.push({ name, ...parsed });
    } catch (error) {
      console.warn(`   ⚠️  Skipping unreadable subscription ${name}: ${error.message}`);
    }
  }

  return records;
}

async function deleteSubscription(name) {
  await kvRequest(`/values/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Notification content
// ---------------------------------------------------------------------------

/** Lower odds first: the hedge is the leg to place before the price moves. */
function orderedLegs(arb) {
  return [...(arb.legs ?? [])]
    .filter((leg) => Number.isFinite(Number(leg?.odds)))
    .sort((a, b) => Number(a.odds) - Number(b.odds));
}

/** Short enough to read on a lock screen; the full detail is one tap away. */
function notificationContent(arb) {
  const [hedge, sharp] = orderedLegs(arb);

  const legLine = [hedge, sharp]
    .filter(Boolean)
    .map((leg) => `${leg.bookmaker} ${leg.outcome} @ ${Number(leg.odds).toFixed(2)}`)
    .join(' · ');

  return {
    // Doubles as the notification `tag`, so a re-alert replaces the earlier ping.
    key: arbDeepLinkKey(arb),
    title: `🚨 ${Number(arb.profitPct).toFixed(2)}% arbitrage`,
    body: `${arb.home} vs ${arb.away}\n${legLine}`,
    icon: '/favicon.png',
    badge: '/favicon.png',
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Sends one push per (arb, device) pair.
 *
 * Each device's link is built from the origin it subscribed on, so the notification
 * opens the dashboard on the domain that browser actually uses.
 *
 * @param {Array<object>} arbs arbs that already passed the alert gates
 * @param {{ log?: (message: string) => void, origin?: string }} [options]
 * @returns {Promise<{ delivered: number, pruned: number, devices: number, deliveredArbs: Set<object> }>}
 */
export async function sendPushAlerts(arbs, options = {}) {
  const log = options.log ?? console.log;
  const fallbackOrigin = (options.origin ?? env('SITE_ORIGIN')).replace(/\/+$/, '');

  const result = { delivered: 0, pruned: 0, devices: 0, deliveredArbs: new Set() };

  if (!pushConfigured()) {
    log('🔕 Push: VAPID or KV credentials missing; skipping web push.');
    return result;
  }
  if (!arbs || arbs.length === 0) return result;

  configureVapid();

  let subscriptions;
  try {
    subscriptions = await loadSubscriptions();
  } catch (error) {
    log(`⚠️  Push: could not load subscriptions (${error.message}).`);
    return result;
  }

  result.devices = subscriptions.length;
  if (subscriptions.length === 0) {
    log('🔕 Push: no subscribed devices yet.');
    return result;
  }

  const queue = [...arbs]
    .sort((a, b) => Number(b.profitPct) - Number(a.profitPct))
    .slice(0, MAX_PUSH_PER_RUN);

  if (queue.length < arbs.length) {
    log(`🔕 Push: capped at ${MAX_PUSH_PER_RUN} notification(s) for this run.`);
  }

  // An endpoint that is gone stays gone: remember it so later arbs skip it.
  const dead = new Set();

  for (const arb of queue) {
    const content = notificationContent(arb);
    let sentForArb = 0;

    for (const record of subscriptions) {
      if (dead.has(record.name)) continue;

      const origin = (record.origin ?? fallbackOrigin).replace(/\/+$/, '');
      if (!origin) {
        log('   ⚠️  Push: no origin recorded for a subscription and SITE_ORIGIN is unset.');
        continue;
      }

      const body = JSON.stringify({
        title: content.title,
        body: content.body,
        icon: content.icon,
        badge: content.badge,
        tag: content.key,
        url: `${origin}/arbs?arb=${encodeURIComponent(content.key)}`,
      });

      try {
        await webpush.sendNotification(record.subscription, body);
        result.delivered += 1;
        sentForArb += 1;
        result.deliveredArbs.add(arb);
      } catch (error) {
        // 404/410 mean the browser dropped the subscription (uninstalled, data cleared).
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          dead.add(record.name);
          try {
            await deleteSubscription(record.name);
            result.pruned += 1;
          } catch (pruneError) {
            log(`   ⚠️  Push: could not prune ${record.name}: ${pruneError.message}`);
          }
          continue;
        }
        log(`   ⚠️  Push: delivery failed (${error?.statusCode ?? error?.message}).`);
      }
    }

    if (sentForArb > 0) {
      log(
        `📲 Push: ${arb.home} vs ${arb.away} (${Number(arb.profitPct).toFixed(2)}%) ` +
          `→ ${sentForArb} device(s).`,
      );
    }
  }

  if (result.pruned > 0) log(`🧹 Push: pruned ${result.pruned} expired subscription(s).`);

  return result;
}
