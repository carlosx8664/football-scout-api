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

// 1. Static file FIRST (for local testing), KV feed SECOND.
const ARBS_SOURCES = ["/arbs.json", "/api/arbs"];

/** Static file first, KV-backed second. Returns null when neither answers. */
export async function fetchArbsJson(signal?: AbortSignal): Promise<unknown | null> {
  for (const url of ARBS_SOURCES) {
    try {
      const response = await fetch(url, { cache: "no-store", signal });
      if (!response.ok) continue;
      const body = await response.json();
      
      // Diagnostic logging
      const count = Array.isArray(body) ? body.length : body?.arbs?.length ?? 0;
      console.log(`[arbs] ${url} → ${count} arbs`);
      
      // If the static file is empty, don't block the KV fallback.
      if (count === 0 && url === "/arbs.json") {
        console.warn("[arbs] Static file empty, trying KV");
        continue;
      }
      
      return body;
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn(`[arbs] ${url} failed`, error);
    }
  }
  return null;
}