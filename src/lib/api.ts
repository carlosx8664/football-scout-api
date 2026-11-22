import type { ArbLeg, SnapshotData } from "../types";

/**
 * Books one arb's SportyBet legs and returns the share URL to open.
 * The ids come from `arbs.json` (`leg.sportybet`), captured by the scanner.
 */
export async function createArbShare(
  selections: NonNullable<ArbLeg["sportybet"]>[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch("/api/arbs/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selections }),
    signal,
  });

  const payload = (await response.json().catch(() => null)) as
    | { shareURL?: string; error?: string }
    | null;

  if (!response.ok || !payload?.shareURL) {
    throw new Error(
      payload?.error ?? `Could not build a SportyBet betslip (HTTP ${response.status}).`,
    );
  }

  return payload.shareURL;
}

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  // `no-store` keeps the browser's HTTP cache from answering with an older snapshot.
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotData> {
  // Freshness first: the Odds refresh workflow writes this to KV every 15 minutes.
  const feed =
    (await readJson<SnapshotData>("/api/matches", signal)) ??
    (await readJson<SnapshotData>("/matches.json", signal));

  if (!feed?.matches) {
    throw new Error("Could not load the match feed. Try refreshing in a minute.");
  }

  return feed;
}

/** A single cold-edge or KV hiccup is the usual cause of a miss; retry before falling back. */
const ARBS_RETRY_DELAYS_MS = [300, 1000];
/** Older than this and the static file is stale by definition. */
const ARBS_STATIC_MAX_AGE_MS = 30 * 60_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let timer = 0;
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * KV-backed arbitrage feed. `/arbs.json` is a build-time placeholder that CI updates only inside
 * the runner (to publish KV), so the deployed copy can be weeks old. It is accepted only when it
 * is recent and non-empty: a transient API miss must surface as "unavailable" rather than a
 * believable "0 arbs" snapshot.
 */
export async function fetchArbsJson(signal?: AbortSignal): Promise<unknown | null> {
  for (let attempt = 0; attempt <= ARBS_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch("/api/arbs", { cache: "no-store", signal });
      if (response.ok) {
        const payload = (await response.json().catch(() => null)) as { arbs?: unknown } | null;
        if (payload && typeof payload === "object" && Array.isArray(payload.arbs)) return payload;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt < ARBS_RETRY_DELAYS_MS.length) await delay(ARBS_RETRY_DELAYS_MS[attempt], signal);
  }

  try {
    const response = await fetch("/arbs.json", { cache: "no-store", signal });
    if (!response.ok) return null;
    const payload = (await response.json().catch(() => null)) as
      | { generatedAt?: unknown; arbs?: unknown }
      | null;
    if (!payload || !Array.isArray(payload.arbs) || payload.arbs.length === 0) return null;
    const generatedAt = Date.parse(String(payload.generatedAt ?? ""));
    if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > ARBS_STATIC_MAX_AGE_MS) {
      return null;
    }
    return payload;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}