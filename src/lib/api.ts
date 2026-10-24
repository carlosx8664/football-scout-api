import type { SnapshotData } from "../types";

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
      const body = await response.json();
      
      const count = Array.isArray(body) ? body.length : body?.arbs?.length ?? 0;
      
      // If KV returns 0 arbs, it might just mean the live scan found nothing.
      // We accept this (return it) so the screen clears. 
      // (If you want it to fall back to static file when KV is empty, change `return body` to `continue`).
      return body;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return null;
}