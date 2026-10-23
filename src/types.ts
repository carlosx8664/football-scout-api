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

export interface ArbBookOdds {
  home: number;
  draw: number;
  away: number;
}

export interface ArbOpportunity {
  home: string;
  away: string;
  tournament: string;
  /** Epoch milliseconds. */
  kickoff: number;
  sporty: ArbBookOdds;
  msport: ArbBookOdds;
  best: ArbBookOdds;
  profitPct: number;
}

/** Static snapshot written by the arbitrage scanner to `public/data/arbs.json`. */
export interface ArbsPayload {
  generatedAt: string;
  boostApplied: number;
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
