import type { SnapshotData } from "../types";

export async function fetchSnapshot(signal?: AbortSignal): Promise<SnapshotData> {
  const response = await fetch("/api/snapshot", { signal });
  const body = (await response.json().catch(() => null)) as
    | (SnapshotData & { error?: string })
    | null;

  if (!response.ok || !body) {
    throw new Error(body?.error ?? `Request failed with HTTP ${response.status}`);
  }
  return body;
}
