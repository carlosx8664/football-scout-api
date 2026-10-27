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

export interface BookIds {
  /** BetBoro region/competition/fixture ids used by `shared/deeplinks.js`. */
  betboro?: {
    regionId: string;
    competitionId: string;
    betBoroId: string;
  } | null;
}

export interface Match {
  fixture: { id: number; date: string };
  /** Sportradar id shared by every bookmaker, e.g. "sr:match:72478654". */
  sr_id?: string | null;
  /** Extra per-bookmaker ids for deep links that need more than the Sportradar id. */
  book_ids?: BookIds | null;
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
  /**
   * SportyBet booking ids, captured by `scripts/find-arbs.js`. Present on SportyBet legs only;
   * POST them to `/api/arbs/share` to get a share code.
   */
  sportybet?: {
    eventId: string;
    marketId: string;
    outcomeId: string;
    specifier: string;
  } | null;
  /** Deep link to the match/market on the bookmaker's site. */
  url?: string;
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
  /** Set if find-arbs.js flags the market for rule verification (e.g., Corners). */
  needsRuleReview?: boolean;
  warning?: string;
}

/** One leg of a tracked arb, with the prices it traded at over time. */
export interface ArbHistoryLeg {
  bookmaker: string;
  outcome: string;
  stake?: number | null;
  /** First price seen for this leg (null when the leg was first seen after kickoff). */
  openOdds?: number | null;
  /** Price on the most recent run (always a pre-kickoff price). */
  lastOdds: number;
  /** Last price before kickoff, frozen once the match started. */
  finalOdds?: number | null;
  /** Deep link to the match/market on the bookmaker's site (if added to history). */
  url?: string;
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
  /** Set if find-arbs.js flags the market for rule verification (e.g., Corners). */
  needsRuleReview?: boolean;
  warning?: string;
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

/* ------------------------------------------------------------------ *
 * Wallets + simulation mode (/api/wallets)
 * ------------------------------------------------------------------ */

/** One bookmaker wallet. `isSimulation` mirrors the `is_simulation` column. */
export interface Wallet {
  id: string;
  name: string;
  bookmaker: string;
  balance: number;
  currency: string;
  isSimulation: boolean;
  updatedAt: string | null;
}

/** Sum of wallet balances minus the stakes locked in active bets for the same mode. */
export interface LiquiditySummary {
  currency: string;
  /** Cash in the bookie wallets. Stakes are debited when a bet is logged. */
  totalBalance: number;
  /** Stakes still at risk in unsettled bets — already deducted from `totalBalance`. */
  staked: number;
  /** Deployable right now: equal to `totalBalance`, since pending stakes are already paid. */
  available: number;
}

/** Deposit/withdrawal totals for the current mode. */
export interface CashFlowSummary {
  count: number;
  deposited: number;
  withdrawn: number;
  net: number;
  bookies: number;
}

/** One deposit or withdrawal. */
export interface WalletTransfer {
  id: string;
  walletId: string;
  bookie: string;
  kind: "deposit" | "withdrawal";
  amount: number;
  createdAt: string;
}

export interface TransfersPayload {
  simulation: boolean;
  transfers: WalletTransfer[];
  totals: {
    count: number;
    deposited: number;
    withdrawn: number;
    net: number;
  };
}

export interface WalletsPayload {
  /** True when these rows came from `is_simulation = 1`. */
  simulation: boolean;
  currency: string;
  wallets: Wallet[];
  liquidity: LiquiditySummary;
  /** SUM(net_profit) over `history` for the same mode. */
  totalProfit: number;
  /** SUM(net_profit) settled today (UTC), used by the daily-goal alert. */
  dailyProfit: number;
  cashFlow: CashFlowSummary;
}

/* ------------------------------------------------------------------ *
 * Ledger (POST /api/active-bets) — one two-leg arb in `active_bets`
 * ------------------------------------------------------------------ */

export interface LogArbLegInput {
  name: string;
  odds: number;
  stake: number;
}

export interface LogArbInput {
  eventName: string;
  /** The `active_bets` table stores exactly two legs (bookie A and bookie B). */
  legs: [LogArbLegInput, LogArbLegInput];
  simulation: boolean;
}

export interface LogArbResult {
  id: string;
  eventName: string;
  /** Recomputed server-side from the saved stakes and prices. */
  profitPercent: number;
  totalStake: number;
  simulation: boolean;
  legs: LogArbLegInput[];
}

export interface ActiveBetLegRecord {
  name: string;
  odds: number;
  stake: number;
}

/** One unsettled row from `active_bets`. */
export interface ActiveBetRecord {
  id: string;
  eventName: string;
  legA: ActiveBetLegRecord;
  legB: ActiveBetLegRecord;
  profitPercent: number;
  createdAt: string | null;
  isSimulation: boolean;
}

export interface ActiveBetsPayload {
  simulation: boolean;
  activeBets: ActiveBetRecord[];
}

/** How a bet left the active ledger. */
export type SettlementOutcome = "win" | "void" | "cashout" | "cancelled";

export interface SettleBetRequest {
  simulation: boolean;
  outcome: SettlementOutcome;
  /** Normal win: the winning leg. Cash out: the bookie you cashed out on. */
  winner?: "a" | "b";
  /** Void only: which leg(s) were cancelled. */
  voided?: "a" | "b" | "both";
  /** Void with one leg cancelled: what happened to the live leg. */
  remaining?: "won" | "lost" | "cashed";
  /** Required for a cash out, or for a void whose live leg was cashed out. */
  cashOutAmount?: number;
}

export interface SettlementCredit {
  bookie: string;
  amount: number;
}

/** Result of DELETE /api/active-bets/:id — the bet was cancelled and both stakes refunded. */
export interface CancelBetResult {
  id: string;
  /** Zero-profit `history` row written to keep the audit trail. */
  historyId: string;
  eventName: string;
  simulation: boolean;
  refunded: SettlementCredit[];
  totalRefunded: number;
}

/** Result of POST /api/active-bets/:id/settle. */
export interface SettleBetResult {
  id: string;
  eventName: string;
  settlementType: SettlementOutcome;
  winningBookie: string | null;
  credits: SettlementCredit[];
  netProfit: number;
  simulation: boolean;
}

/* ------------------------------------------------------------------ *
 * History (GET /api/history)
 * ------------------------------------------------------------------ */

/** One settled arb from the `history` table. */
export interface HistoryEntry {
  id: string;
  eventName: string;
  winningBookie: string | null;
  /** Null only for rows settled before `history` stored leg details. */
  bookieAName: string | null;
  bookieBName: string | null;
  totalStake: number;
  netProfit: number;
  settledAt: string;
  /** `void` and `cashout` rows are badged in the History table. */
  settlementType: SettlementOutcome;
}

export interface HistoryTotals {
  /** Stakes currently tied up in `active_bets`. */
  activeOutlay: number;
  /** Stakes settled since Monday. */
  historyOutlay: number;
  outlayThisWeek: number;
}

export interface HistoryPayload {
  simulation: boolean;
  entries: HistoryEntry[];
  totals: HistoryTotals;
}

/* ------------------------------------------------------------------ *
 * Bet builder (POST /api/bet-builder/extract)
 * ------------------------------------------------------------------ */

/** One selection as transcribed from a betslip screenshot. */
export interface ExtractedLeg {
  rowIndex: number;
  /** Verbatim text of the row, useful when a match could not be resolved. */
  rawText?: string;
  home: string | null;
  away: string | null;
  leagueHint?: string | null;
  kickoffHint?: string | null;
  market: string;
  selection: string;
  odds: number | null;
}

/** Deep links for one fixture, on every local book. Null when that book's URL cannot be built. */
export interface BetslipLinks {
  sportybet: string | null;
  msport: string | null;
  betpawa: string | null;
  boltbet: string | null;
  betboro: string | null;
}

interface BetBuilderHit {
  leg: ExtractedLeg;
  match: Match;
  /** 0..1 overall score (team names + odds). */
  confidence: number;
  teamScore: number;
  oddsScore: number | null;
  /** True when the slip printed the teams in the opposite order to the feed. */
  flipped: boolean;
  links: BetslipLinks;
}

/** SportyBet booking payload for one leg; POSTed to /api/arbs/share to mint a slip link. */
export interface SportyBetBooking {
  eventId: string;
  marketId: string;
  outcomeId: string;
  specifier: string;
}

/** A leg resolved to exactly one fixture. */
export interface MatchedLeg extends BetBuilderHit {
  status: "matched";
  /** Present when this leg can be loaded into a SportyBet slip. */
  booking?: SportyBetBooking | null;
}

/** A possible fixture offered for a leg that could not be resolved automatically. */
export interface MatchedCandidate extends BetBuilderHit {
  status: "candidate";
}

export type UnresolvedReason =
  | "missing-teams"
  | "no-candidates"
  | "low-confidence"
  | "ambiguous";

export interface UnresolvedLeg {
  leg: ExtractedLeg;
  reason: UnresolvedReason;
  /** Up to three closest fixtures, best first. Empty when nothing plausible was found. */
  candidates: MatchedCandidate[];
}

export interface BetBuilderResponse {
  bookmaker: string | null;
  warnings: string[];
  matched: MatchedLeg[];
  unresolved: UnresolvedLeg[];
  /** SportyBet booking link that loads every mapped selection into the betslip. */
  sportybetAccaUrl?: string | null;
  sportybetAccaCode?: string | null;
  /** Why the betslip is missing legs, partial, or could not be built at all. */
  sportybetAccaWarning?: string | null;
  /** True when the extraction came from the KV cache. */
  cached?: boolean;
  stats?: {
    legs: number;
    matched: number;
    unresolved: number;
    fixtures: number;
    /** Selections SportyBet accepted for the share code. */
    bookable?: number;
  };
}