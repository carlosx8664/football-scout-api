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

export interface BookPrice {
  /** Bookmaker name -> decimal price. Only books quoting this outcome appear. */
  books: Record<string, number>;
  best: number | null;
  bookmaker: string | null;
}

export interface BookOdds {
  home: BookPrice;
  draw: BookPrice;
  away: BookPrice;
}

export interface Match {
  fixture: { id: number; date: string };
  league: League;
  teams: { home: Team; away: Team };
  goals?: { home: number | null; away: number | null };
  odds: Odd[] | null;
  /** Per-bookmaker prices behind the best price shown in `odds`. */
  book_odds?: BookOdds | null;
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

/** One leg of a tracked arb, with the prices it traded at over time. */
export interface ArbHistoryLeg {
  bookmaker: string;
  outcome: string;
  stake?: number | null;
  /** First price seen for this leg. */
  openOdds: number;
  /** Price on the most recent run (always a pre-kickoff price). */
  lastOdds: number;
  /** Last price before kickoff, frozen once the match started. */
  finalOdds?: number | null;
}

/** An arb the scanner has seen at any point, kept after kickoff for the Past Arbs table. */
export interface ArbHistoryRecord {
  key: string;
  eventId?: string | null;
  home: string;
  away: string;
  tournament?: string | null;
  /** Epoch milliseconds. */
  kickoff: number;
  market: string;
  note?: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Profit % when the arb was first detected. */
  openProfitPct: number;
  /** Best profit % ever seen for this arb. */
  peakProfitPct: number;
  /** Most recent profit %. */
  profitPct: number;
  /** Profit % at the last pre-kickoff price, set once the match starts. */
  finalProfitPct?: number | null;
  legs: ArbHistoryLeg[];
}

/** Static snapshot written by the arbitrage scanner to `public/arbs.json`. */
export interface ArbsPayload {
  generatedAt?: string;
  /** 1 = real odds; anything else means the file was generated in --boost test mode. */
  boostApplied?: number;
  boostTarget?: string | null;
  arbs: ArbOpportunity[];
  /** Every arb tracked recently, including ones whose match has already started. */
  history?: ArbHistoryRecord[];
}

/**
 * Payload served by `/api/matches` (KV) or `/matches.json`, produced by
 * `scripts/build-match-feed.js`.
 */
export interface SnapshotData {
  status: "success";
  date: string;
  generated_at?: string;
  match_count: number;
  matches: Match[];
}