import type {
  ActiveBetsPayload,
  CancelBetResult,
  LogArbInput,
  LogArbResult,
  SettleBetRequest,
  SettleBetResult,
} from "../types";

/**
 * UTC instants bounding the user's local calendar day. Sent with every log so the server's daily
 * mug-bet gate resets on the punter's own midnight instead of UTC's, and follows timezone changes.
 */
export function localDayWindow(now: Date = new Date()): { dayStart: string; dayEnd: string } {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  return {
    dayStart: new Date(year, month, day).toISOString(),
    dayEnd: new Date(year, month, day + 1).toISOString(),
  };
}

export async function logArb(input: LogArbInput): Promise<LogArbResult> {
  const response = await fetch("/api/active-bets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, ...localDayWindow() }),
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

/** Settles one bet: applies the credits, records history and clears it from the ledger. */
export async function settleBet(
  id: string,
  request: SettleBetRequest,
): Promise<SettleBetResult> {
  const response = await fetch(`/api/active-bets/${encodeURIComponent(id)}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const payload = (await response.json().catch(() => null)) as
    | (SettleBetResult & { error?: string })
    | null;

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error ?? `Could not settle the bet (HTTP ${response.status}).`);
  }

  return payload;
}

/** Cancels a bet: refunds both stakes to their bookies and removes it from the ledger. */
export async function cancelBet(id: string, simulation: boolean): Promise<CancelBetResult> {
  const response = await fetch(
    `/api/active-bets/${encodeURIComponent(id)}?simulation=${simulation ? 1 : 0}`,
    { method: "DELETE" },
  );

  const payload = (await response.json().catch(() => null)) as
    | (CancelBetResult & { error?: string })
    | null;

  if (!response.ok || !payload?.refunded) {
    throw new Error(payload?.error ?? `Could not cancel the bet (HTTP ${response.status}).`);
  }

  return payload;
}
