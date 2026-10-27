import type { MugBet, MugBetsPayload, WalletsPayload } from "../types";

/** Result of a write: the fresh wallet payload plus the mug bet that changed. */
export interface MugBetWriteResult extends WalletsPayload {
  mugBet: MugBet;
}

async function readError(response: Response, fallback: string): Promise<never> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? `${fallback} (HTTP ${response.status}).`);
}

export async function fetchMugBets(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<MugBetsPayload> {
  const response = await fetch(`/api/mug-bets?simulation=${simulation ? 1 : 0}`, {
    signal,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (MugBetsPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.mugBets) {
    throw new Error(payload?.error ?? `Could not load mug bets (HTTP ${response.status}).`);
  }

  return payload;
}

export interface MugBetInput {
  bookie: string;
  eventName: string;
  stake: number;
  odds: number;
}

/** Logs a mug bet and debits the stake from that bookie. */
export async function createMugBet(
  input: MugBetInput,
  simulation: boolean,
): Promise<MugBetWriteResult> {
  const response = await fetch("/api/mug-bets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, simulation }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (MugBetWriteResult & { error?: string })
    | null;

  if (!response.ok || !payload?.wallets) {
    await readError(response, "Could not log the mug bet");
  }

  return payload as MugBetWriteResult;
}

/** Settles a mug bet. A win credits `stake × odds` back to the bookie; a loss changes nothing. */
export async function settleMugBet(
  id: string,
  won: boolean,
  simulation: boolean,
): Promise<MugBetWriteResult> {
  const response = await fetch(`/api/mug-bets/${encodeURIComponent(id)}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ won, simulation }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (MugBetWriteResult & { error?: string })
    | null;

  if (!response.ok || !payload?.wallets) {
    await readError(response, "Could not settle the mug bet");
  }

  return payload as MugBetWriteResult;
}
