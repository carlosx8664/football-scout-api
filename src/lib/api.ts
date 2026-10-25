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
  const response = await fetch(url, { signal });
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

// 1. KV feed FIRST (live production), Static file SECOND (fallback).
const ARBS_SOURCES = ["/api/arbs", "/arbs.json"];

/** KV-backed arbitrage feed first, static file second. Returns null when neither answers. */
export async function fetchArbsJson(signal?: AbortSignal): Promise<unknown | null> {
  for (const url of ARBS_SOURCES) {
    try {
      const response = await fetch(url, { cache: "no-store", signal });
      if (!response.ok) continue;
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return null;
}