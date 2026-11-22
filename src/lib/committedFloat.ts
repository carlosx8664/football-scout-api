export interface CommittedFloatBookie {
  name: string;
  /** Cash in the wallet right now. */
  free: number;
  /** Stakes on unsettled bets, not in the wallet but not lost either. */
  committed: number;
  /** Committed on fixtures that kick off today, i.e. settling tonight. */
  today: number;
  bets: number;
  exposure: number;
}

export interface CommittedFloatBucket {
  date: string;
  amount: number;
  legs: number;
}

export interface CommittedFloat {
  simulation: boolean;
  today: string;
  bookies: CommittedFloatBookie[];
  totals: {
    free: number;
    committed: number;
    exposure: number;
    /** Smallest funded balance: the cap on the next arb's per-leg stake. */
    freeFloor: number;
  };
  schedule: CommittedFloatBucket[];
}

/** Where the float is parked and when it comes back, for the selected mode. */
export async function fetchCommittedFloat(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<CommittedFloat> {
  const response = await fetch(
    `/api/wallets/committed-float?simulation=${simulation ? 1 : 0}`,
    { signal, cache: "no-store" },
  );

  const payload = (await response.json().catch(() => null)) as
    | (CommittedFloat & { error?: string })
    | null;

  if (!response.ok || !payload?.totals) {
    throw new Error(payload?.error ?? `Could not load committed float (HTTP ${response.status}).`);
  }

  return payload;
}
