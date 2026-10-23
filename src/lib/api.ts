import type { SnapshotData } from "../types";

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotData> {
  // Primary source: the feed built from the bookmaker snapshots (no API-Football calls).
  const feed = await readJson<SnapshotData>("/matches.json", signal);
  if (feed?.matches) return feed;

  // Fallback for deployments that have not generated the feed yet.
  const response = await fetch("/api/snapshot", { signal });
  const body = (await response.json().catch(() => null)) as
    | (SnapshotData & { error?: string })
    | null;

  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Request failed with HTTP ${response.status}`);
  }
  return body;
}
