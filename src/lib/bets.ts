import type {
  ActiveBetsPayload,
  LogArbInput,
  LogArbResult,
  SettleBetResult,
} from "../types";

export async function logArb(input: LogArbInput): Promise<LogArbResult> {
  const response = await fetch("/api/active-bets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => null)) as
    | (LogArbResult & { error?: string })
    | null;

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error ?? `Could not log the arb (HTTP ${response.status}).`);
  }

  return payload;
}

export async function fetchActiveBets(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<ActiveBetsPayload> {
  const response = await fetch(`/api/active-bets?simulation=${simulation ? 1 : 0}`, {
    signal,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (ActiveBetsPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.activeBets) {
    throw new Error(payload?.error ?? `Could not load active bets (HTTP ${response.status}).`);
  }

  return payload;
}

/** Settles one bet: pays the winning leg, records history and clears it from the ledger. */
export async function settleBet(
  id: string,
  winner: "a" | "b",
  simulation: boolean,
): Promise<SettleBetResult> {
  const response = await fetch(`/api/active-bets/${encodeURIComponent(id)}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ winner, simulation }),
  });

  const payload = (await response.json().catch(() => null)) as
    | (SettleBetResult & { error?: string })
    | null;

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error ?? `Could not settle the bet (HTTP ${response.status}).`);
  }

  return payload;
}
