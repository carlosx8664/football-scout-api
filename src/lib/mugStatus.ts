import { localDayWindow } from "./bets";

export interface MugStatusBookie {
  name: string;
  balance: number;
  muggedToday: boolean;
}

export interface MugStatus {
  simulation: boolean;
  bookies: MugStatusBookie[];
  /** Funded bookies with no mug bet logged today. */
  owed: string[];
}

/**
 * Which funded bookies still owe today's camouflage mug bet. Advisory only: the arb log no longer
 * blocks on this, so a live arb can be grabbed first and the mug acca placed afterwards.
 */
export async function fetchMugStatus(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<MugStatus> {
  const { dayStart, dayEnd } = localDayWindow();
  const query = new URLSearchParams({
    simulation: simulation ? "1" : "0",
    from: dayStart,
    to: dayEnd,
  });
  const response = await fetch(`/api/mug-status?${query}`, { signal, cache: "no-store" });

  const payload = (await response.json().catch(() => null)) as
    | (MugStatus & { error?: string })
    | null;

  if (!response.ok || !payload?.bookies) {
    throw new Error(payload?.error ?? `Could not load mug status (HTTP ${response.status}).`);
  }

  return payload;
}
