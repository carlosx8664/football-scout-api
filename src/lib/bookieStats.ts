import type { BookieStatsPayload } from "../types";

/** Per-bookie deposits, withdrawals, mug-bet cost and arb result for one mode. */
export async function fetchBookieStats(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<BookieStatsPayload> {
  const response = await fetch(
    `/api/wallets/bookie-stats?simulation=${simulation ? 1 : 0}`,
    { signal, cache: "no-store" },
  );

  const payload = (await response.json().catch(() => null)) as
    | (BookieStatsPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.bookies) {
    throw new Error(
      payload?.error ?? `Could not load bookie stats (HTTP ${response.status}).`,
    );
  }

  return payload;
}
