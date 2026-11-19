/**
 * Arb feed reader for the extension.
 *
 * The KV-backed `/api/arbs` is the only live source. `/arbs.json` is a build-time placeholder
 * that CI updates only inside the runner (to publish KV), so the deployed copy can be weeks old.
 * It is accepted only when it is recent and non-empty: a transient API miss must surface as
 * "feed unavailable" rather than a believable "0 arbs" snapshot.
 */

/** A single cold-edge or KV hiccup is the usual cause of a miss; retry before falling back. */
const RETRY_DELAYS_MS = [300, 1000];
/** Older than this and the static file is stale by definition. */
const STATIC_MAX_AGE_MS = 30 * 60_000;

function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJson(base, path, signal) {
  const response = await fetch(base + path, { cache: 'no-store', signal });
  if (!response.ok) {
    const error = new Error(`${path} → HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  if (!payload || typeof payload !== 'object') throw new Error(`${path} → invalid JSON`);
  return payload;
}

export async function fetchFeed(apiBase, signal) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('No dashboard URL configured.');

  let liveError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const payload = await fetchJson(base, '/api/arbs', signal);
      if (Array.isArray(payload.arbs)) return { ...payload, source: 'live' };
      liveError = new Error('/api/arbs → payload has no arbs array');
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      liveError = error;
    }

    if (attempt < RETRY_DELAYS_MS.length) await delay(RETRY_DELAYS_MS[attempt], signal);
  }

  let staticError = null;
  try {
    const payload = await fetchJson(base, '/arbs.json', signal);
    if (!Array.isArray(payload.arbs)) throw new Error('/arbs.json → payload has no arbs array');

    const generatedAt = Date.parse(String(payload.generatedAt ?? ''));
    const age = Date.now() - generatedAt;
    if (!Number.isFinite(generatedAt) || age > STATIC_MAX_AGE_MS || payload.arbs.length === 0) {
      throw new Error(
        `/arbs.json is a stale placeholder (${Number.isFinite(generatedAt) ? new Date(generatedAt).toISOString() : 'no generatedAt'}, ${payload.arbs.length} arbs)`,
      );
    }

    return { ...payload, source: 'static' };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    staticError = error;
  }

  console.warn(
    '[oddtor] arb feed unavailable:',
    liveError?.message || liveError,
    '| static:',
    staticError?.message || staticError,
  );
  throw new Error(`No live arb feed (${liveError?.message || 'unknown error'}).`);
}
