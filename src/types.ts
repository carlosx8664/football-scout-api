export interface League {
  id: number;
  name: string;
  logo: string;
}

export interface Odd {
  value: string;
  odd: string;
}

export interface Team {
  name: string;
  logo: string;
}

export interface Match {
  fixture: { id: number; date: string };
  league: League;
  teams: { home: Team; away: Team };
  goals?: { home: number | null; away: number | null };
  odds: Odd[] | null;
  ai_analysis: string | null;
}

export interface ArbLeg {
  bookmaker: string;
  outcome: string;
  odds: number;
  /** Suggested stake for this leg (scripts/find-arbs.js, default total 100). */
  stake?: number;
}

export interface ArbOpportunity {
  /** Shared Sportradar id, e.g. "sr:match:72221344". */
  eventId?: string;
  home: string;
  away: string;
  tournament: string;
  /** Epoch milliseconds. */
  kickoff: number;
  market: string;
  profitPct: number;
  legs: ArbLeg[];
  /** Extra caveat, e.g. "Draw = both stakes refunded". */
  note?: string;
}

/** Static snapshot written by the arbitrage scanner to `public/arbs.json`. */
export interface ArbsPayload {
  generatedAt?: string;
  /** 1 = real odds; anything else means the file was generated in --boost test mode. */
  boostApplied?: number;
  boostTarget?: string | null;
  arbs: ArbOpportunity[];
}

/**
 * Payload produced by `scripts/sync.js` and served verbatim from Cloudflare KV.
 */
export interface SnapshotData {
  status: "success" | "pending";
  date: string;
  message?: string;
  generated_at?: string;
  quota_remaining?: string;
  quota_exhausted?: boolean;
  match_count: number;
  analysed_count?: number;
  matches: Match[];
}