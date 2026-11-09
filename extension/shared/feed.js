/**
 * Arb feed reader for the extension. Mirrors the dashboard's own fallback chain:
 * the KV-backed `/api/arbs` first, the static `/arbs.json` second.
 */

export async function fetchFeed(apiBase, signal) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('No dashboard URL configured.');

  let lastError = null;
  for (const path of ['/api/arbs', '/arbs.json']) {
    try {
      const response = await fetch(base + path, { cache: 'no-store', signal });
      if (!response.ok) {
        lastError = new Error(`${path} → HTTP ${response.status}`);
        continue;
      }
      const payload = await response.json();
      if (Array.isArray(payload?.arbs)) return payload;
      lastError = new Error(`${path} → payload has no arbs array`);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      lastError = error;
    }
  }

  throw lastError ?? new Error('Could not reach the dashboard.');
}
