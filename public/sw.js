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

/* --- App-shell caching (installable / instant reloads) -------------------- */

const CACHE_NAME = 'oddtor-shell-v1';
const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/favicon.png',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png',
];
const CACHEABLE = /\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|css|js|json)$/i;
const cachingAvailable = 'caches' in self;

function cachePut(request, response) {
  if (!response || response.status !== 200) return;
  caches.open(CACHE_NAME).then((cache) => cache.put(request, response)).catch(() => {});
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  if (!cachingAvailable) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // One missing icon must not fail the whole install.
      Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => {}))),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if (cachingAvailable) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!cachingAvailable || request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // API responses and dev-server module URLs must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/src/') || url.pathname.startsWith('/@')) return;

  if (request.mode === 'navigate') {
    // Network-first: fresh HTML when online, cached shell when offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          cachePut('/', response.clone());
          return response;
        })
        .catch(async () => (await caches.match('/')) || Response.error()),
    );
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return;

  // Stale-while-revalidate for static assets.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          cachePut(request, response.clone());
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
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
