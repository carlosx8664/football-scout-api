/**
 * Push subscription storage, shared by the subscribe/unsubscribe endpoints.
 *
 * One KV entry per device (`push-sub:<fingerprint>`) instead of a single JSON
 * array, so a subscribe or unsubscribe never has to read-modify-write a list and
 * two devices signing up at once cannot clobber each other. The sender
 * (scripts/push-notify.js) enumerates the prefix and prunes entries the push
 * service reports as gone.
 */

const KV_BINDING = "FOOTBALL_DATA";

export const PUSH_KEY_PREFIX = "push-sub:";
/** Device cap, so a public deployment cannot be used to fill the namespace. */
export const SUBSCRIPTION_LIMIT = 25;

export function kvOf(env) {
  return env?.[KV_BINDING] ?? null;
}

/** Short, stable fingerprint of an endpoint (the endpoint itself is too long for a key). */
export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 24);
}

export function storageKey(id) {
  return `${PUSH_KEY_PREFIX}${id}`;
}

/** A subscription is only useful if it has an endpoint and both encryption keys. */
export function isUsableSubscription(subscription) {
  if (!subscription || typeof subscription !== "object") return false;

  const { endpoint, keys } = subscription;
  if (typeof endpoint !== "string" || !/^https:\/\//i.test(endpoint)) return false;
  if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;

  return true;
}

/** Origin the user subscribed from, so notification URLs match the domain they actually use. */
export function originOf(request) {
  try {
    return new URL(request.headers.get("Origin") ?? request.url).origin;
  } catch {
    return null;
  }
}

export async function countSubscriptions(kv) {
  const listed = await kv.list({ prefix: PUSH_KEY_PREFIX, limit: SUBSCRIPTION_LIMIT + 1 });
  return listed.keys.length;
}
