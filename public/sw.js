/**
 * Push notifications for arb alerts.
 *
 * The payload is built by `scripts/push-notify.js` and always carries
 * `data.url` (e.g. "/arbs?arb=<key>") plus `data.key` (the arb's identity).
 * Tapping a notification focuses an open dashboard tab and navigates it to that
 * URL, so the arbs page can scroll to and highlight the matching card.
 *
 * Plain JS on purpose: it is served as-is from `public/` and never goes through
 * the TypeScript build.
 */

const DEFAULT_URL = '/arbs';
const ICON = '/favicon.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};

  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A malformed or unencrypted payload must still produce a visible notification.
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'New arbitrage opportunity';
  const options = {
    body: payload.body || '',
    icon: payload.icon || ICON,
    badge: payload.badge || ICON,
    // Same tag replaces an earlier notification for the same arb instead of stacking.
    tag: payload.tag || undefined,
    renotify: Boolean(payload.tag),
    data: { url: payload.url || payload.data?.url || DEFAULT_URL },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const rawUrl = event.notification.data?.url || DEFAULT_URL;
  const target = new URL(rawUrl, self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );

      // An already-open dashboard just needs to be focused and steered at the arb.
      // `navigate` reloads that tab at the deep link, which works even when the tab
      // is uncontrolled; rebuilds of the app therefore need no special handling.
      if (existing) {
        await existing.focus();
        if (typeof existing.navigate === 'function') {
          try {
            return await existing.navigate(target);
          } catch {
            // Fall through to opening a fresh tab below.
          }
        }
      }

      return self.clients.openWindow(target);
    })(),
  );
});
