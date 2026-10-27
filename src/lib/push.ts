/**
 * Web Push plumbing for arb alerts.
 *
 * Enabling alerts registers `public/sw.js`, asks Chrome for notification
 * permission, creates a `PushSubscription` and hands it to
 * `POST /api/push/subscribe`. From then on `scripts/push-notify.js` can wake the
 * phone; tapping the notification opens `/arbs?arb=<key>` and the arbs page
 * scrolls to that card.
 */

const SW_URL = "/sw.js";
const KEY_ENDPOINT = "/api/push/key";
const SUBSCRIBE_ENDPOINT = "/api/push/subscribe";
const UNSUBSCRIBE_ENDPOINT = "/api/push/unsubscribe";

export type PushStatus = "unsupported" | "blocked" | "off" | "on";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);

  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function fetchVapidKey(): Promise<string> {
  const response = await fetch(KEY_ENDPOINT, { cache: "no-store" });
  const payload = (await response.json().catch(() => null)) as
    | { publicKey?: string; error?: string }
    | null;

  if (!response.ok || !payload?.publicKey) {
    throw new Error(payload?.error ?? "Push is not configured on the server.");
  }

  return payload.publicKey;
}

async function registeredWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  return registration;
}

/** The browser's current subscription, or null. Never prompts for permission. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  // Reading the registration must not create one, or a mere visit would register the worker.
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

/** What the enable/disable control should show. */
export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted") return "off";

  const subscription = await currentSubscription().catch(() => null);
  return subscription ? "on" : "off";
}

/**
 * Requests permission, subscribes, and registers the subscription with the
 * server. Throws with a user-facing message when the user declines or the
 * server refuses.
 */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error("This browser does not support push notifications.");

  // Must be called from the click handler: Chrome rejects prompts that are not user-initiated.
  const permission = await Notification.requestPermission();
  if (permission === "denied") {
    throw new Error("Notifications are blocked for this site in Chrome settings.");
  }
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const [registration, publicKey] = await Promise.all([registeredWorker(), fetchVapidKey()]);

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Every push must result in a visible notification; browsers require this flag.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  const response = await fetch(SUBSCRIBE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });

  if (!response.ok) {
    // Do not leave a subscription behind that the server will never use.
    await subscription.unsubscribe().catch(() => {});
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Server refused the subscription (HTTP ${response.status}).`);
  }
}

/** Unsubscribes locally and on the server. Safe to call when already off. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;

  const { endpoint } = subscription;

  try {
    await fetch(UNSUBSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // The local unsubscribe below is what actually stops notifications; a failed
    // server call only leaves a stale entry that the sender prunes when the push
    // service reports the endpoint as gone.
  }

  await subscription.unsubscribe();
}
