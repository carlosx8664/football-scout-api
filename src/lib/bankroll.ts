import { createContext, useContext } from "react";

export const BANKROLL_STORAGE_KEY = "oddtor:bankroll-plan";

export const DEFAULT_BANKROLL = 10_000;
/** Stake per arb is entered by hand; this is only what a fresh install starts at. */
export const DEFAULT_STAKE = 2_000;

/** Above this share of the bankroll, one arb is too big to recover from. */
export const HIGH_RISK_PCT = 20;
/** Camouflage protocol: 1.5% of stake ensures a 30 GHS mug bet on a 2,000 GHS arb. */
export const MICRO_MUG_PCT = 1.5;
export const WEEKEND_ANCHOR_PCT = 5;

/** Both legs of one arb must be covered, so the float is 2× the stake. */
export const FLOAT_MULTIPLE = 2;
/** Deposits in round steps look human; precise amounts look automated. */
export const BLEND_STEP = 50;
/**
 * Opening deposits are also round: each selected bookie's share of the bankroll is rounded to the
 * nearest 100, stepping back one step when rounding up would push the split past the bankroll.
 * The leftover becomes unallocated cash.
 */
export const OPENING_STEP = 100;
/** Share of the bankroll each bookie should hold when everything is balanced. */
export const BOOKIE_SHARE_PCT = 25;
/** One bookie per leg: a split only exists once at least two bookies are selected. */
export const MIN_BOOKIES = 2;

/**
 * Nearest round step to `amount`, for telling the user what to actually key into a bookie app.
 * The plan keeps the exact target (1,666.67); this is only what to deposit so it blends in.
 * e.g. 1,666.67 -> 1,650, 833.33 -> 850.
 */
export function blendInAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(BLEND_STEP, Math.round(amount / BLEND_STEP) * BLEND_STEP);
}

/**
 * Each selected bookie's share of the bankroll, always rounded DOWN to a whole 100 so the split
 * is decimal-free and can never exceed the bankroll: 10,000 across 6 bookies gives 1,600 each
 * (9,600 funded) and leaves 400 for Momo.
 */
export function splitPerWallet(bankroll: number, bookies: number): number {
  const count = Math.max(1, Math.floor(bookies) || 1);
  const share = Math.max(0, Number(bankroll) || 0) / count;
  if (!Number.isFinite(share) || share <= 0) return 0;
  return Math.max(0, Math.floor(share / OPENING_STEP) * OPENING_STEP);
}

/**
 * Per-bookie opening deposit: the rounded share, floored to a whole step so N deposits can never
 * exceed the bankroll. 10,000 across 6 bookies -> 1,600 each.
 */
export function openingBalanceFor(perWallet: number): number {
  if (!Number.isFinite(perWallet) || perWallet <= 0) return 0;
  return Math.max(0, Math.floor(perWallet / OPENING_STEP) * OPENING_STEP);
}

/** Bankroll that N round deposits leave behind — the mobile-money wallet. */
export function unallocatedFor(bankroll: number, perWallet: number, wallets: number): number {
  const safeBankroll = Math.max(0, Number(bankroll) || 0);
  const count = Math.max(0, wallets);
  return Math.max(0, Math.round((safeBankroll - openingBalanceFor(perWallet) * count) * 100) / 100);
}

export interface BankrollSettings {
  /** Total capital you keep across the bookie wallets. */
  bankroll: number;
  /** Total laid across both legs of one arb — entered by hand. */
  stake: number;
  /** Bookies picked in wallet management (by name); the bankroll splits across these only. */
  bookies: string[];
}

/** Bookies picked in wallet management. A fresh plan starts with none selected. */
export function selectedBookies(settings: BankrollSettings): string[] {
  return Array.isArray(settings.bookies) ? settings.bookies : [];
}

/** True once enough bookies are picked to split the bankroll across them. */
export function hasSplit(settings: BankrollSettings): boolean {
  return selectedBookies(settings).length >= MIN_BOOKIES;
}

export interface BankrollPlan {
  bankroll: number;
  /** The manual stake, echoed back after clamping. */
  stake: number;
  /** Stake as a share of the bankroll. */
  riskPct: number;
  /** True when one arb is more than HIGH_RISK_PCT of the bankroll. */
  highRisk: boolean;
  /** Camouflage protocol: a small single most days. */
  microMug: number;
  /** Camouflage protocol: the bigger weekend bet. */
  weekendAnchor: number;
  /** How many arbs the bankroll can fund at once. */
  concurrency: number;
  /** Float needed to place both legs of one arb without running dry. */
  minFloat: number;
  /** Target balance per bookie wallet, rounded to the nearest 100. */
  perWallet: number;
  /** Arbs per day the plan is designed for. */
  arbsPerDay: [number, number];
  /** Realistic daily profit at 1.5–3% margin. */
  dailyProfit: [number, number];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Everything the dashboard shows is derived from the two numbers the user actually owns: the
 * bankroll and the stake they are willing to put on one arb.
 *
 * @param walletCount wallets in rotation; only affects `perWallet`.
 */
export function computePlan(settings: BankrollSettings, walletCount = 1): BankrollPlan {
  const bankroll = Math.max(0, Number(settings.bankroll) || 0);
  const stake = Math.max(0, Number(settings.stake) || 0);
  const wallets = Math.max(1, walletCount);
  const riskPct = bankroll > 0 ? (stake / bankroll) * 100 : 0;

  return {
    bankroll,
    stake,
    riskPct,
    highRisk: bankroll > 0 && stake > (bankroll * HIGH_RISK_PCT) / 100,
    microMug: round2((stake * MICRO_MUG_PCT) / 100),
    weekendAnchor: round2((stake * WEEKEND_ANCHOR_PCT) / 100),
    concurrency: stake > 0 ? Math.floor(bankroll / stake) : 0,
    minFloat: round2(stake * FLOAT_MULTIPLE),
    perWallet: splitPerWallet(bankroll, wallets),
    arbsPerDay: [2, 5],
    dailyProfit: [
      Math.round(stake * 0.015 * 2),
      Math.round(stake * 0.03 * 5),
    ],
  };
}

export const BankrollContext = createContext<{
  settings: BankrollSettings;
  setSettings: (next: BankrollSettings) => void;
} | null>(null);

export function useBankroll() {
  const context = useContext(BankrollContext);
  if (!context) {
    throw new Error("useBankroll must be used inside <BankrollProvider>.");
  }
  return context;
}

/** Older plans stored a risk profile; map its percentage back onto a concrete stake. */
const LEGACY_PROFILE_PCT: Record<string, number> = {
  conservative: 1,
  balanced: 2,
  confident: 3,
  aggressive: 5,
};

export function readStoredBankroll(): BankrollSettings {
  const fallback: BankrollSettings = {
    bankroll: DEFAULT_BANKROLL,
    stake: DEFAULT_STAKE,
    bookies: [],
  };

  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(BANKROLL_STORAGE_KEY);
    if (!raw) return fallback;

    const parsed = JSON.parse(raw) as {
      bankroll?: number;
      stake?: number;
      riskProfile?: string;
      bookies?: unknown;
    };

    const bookies = Array.isArray(parsed.bookies)
      ? parsed.bookies.filter((bookie): bookie is string => typeof bookie === "string")
      : [];

    const bankroll = Number(parsed.bankroll);
    const safeBankroll = Number.isFinite(bankroll) && bankroll > 0 ? bankroll : DEFAULT_BANKROLL;

    const storedStake = Number(parsed.stake);
    if (Number.isFinite(storedStake) && storedStake > 0) {
      return { bankroll: safeBankroll, stake: storedStake, bookies };
    }

    // A plan saved while risk profiles existed: turn its percentage back into a stake.
    const pct = LEGACY_PROFILE_PCT[parsed.riskProfile ?? ""];
    if (pct) {
      return { bankroll: safeBankroll, stake: Math.round((safeBankroll * pct) / 100), bookies };
    }

    return { bankroll: safeBankroll, stake: DEFAULT_STAKE, bookies };
  } catch {
    return fallback;
  }
}

export function storeBankroll(settings: BankrollSettings) {
  try {
    window.localStorage.setItem(BANKROLL_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: the plan simply resets on reload.
  }
}