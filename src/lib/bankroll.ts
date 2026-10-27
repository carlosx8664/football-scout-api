import { createContext, useContext } from "react";

export const BANKROLL_STORAGE_KEY = "oddtor:bankroll-plan";

/** Defaults aimed at ~1,000 GHS per arb and 2–5 arbs a day. */
export const DEFAULT_BANKROLL = 5_000;
export const DEFAULT_STAKE = 1_000;
/** Float should cover several bets in flight, not one. */
export const FLOAT_MULTIPLE = 4;
/** Share of the bankroll each bookie should hold when everything is balanced. */
export const BOOKIE_SHARE_PCT = 25;

export interface BankrollSettings {
  /** Total capital you keep across the bookie wallets. */
  bankroll: number;
  /** Total stake you intend to place per arb (both legs). */
  stake: number;
}

export interface BankrollPlan {
  bankroll: number;
  stake: number;
  /** How many arbs can be in flight at once. */
  concurrency: number;
  /** Minimum float worth holding for this stake size (4 × stake). */
  minFloat: number;
  /** Target balance per bookie wallet. */
  perWallet: number;
  /** Arbs per day the plan is designed for. */
  arbsPerDay: [number, number];
  /** Realistic daily profit at 1.5–3% margin. */
  dailyProfit: [number, number];
  /** True when the bankroll cannot cover the recommended float. */
  underfunded: boolean;
}

export function computePlan(settings: BankrollSettings, walletCount: number): BankrollPlan {
  const bankroll = Math.max(0, settings.bankroll);
  const stake = Math.max(0, settings.stake);
  const wallets = Math.max(1, walletCount);

  return {
    bankroll,
    stake,
    concurrency: stake > 0 ? Math.floor(bankroll / stake) : 0,
    minFloat: stake * FLOAT_MULTIPLE,
    perWallet: bankroll / wallets,
    arbsPerDay: [2, 5],
    dailyProfit: [
      Math.round(stake * 0.015 * 2),
      Math.round(stake * 0.03 * 5),
    ],
    underfunded: stake > 0 && bankroll < stake * FLOAT_MULTIPLE,
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

export function readStoredBankroll(): BankrollSettings {
  if (typeof window === "undefined") {
    return { bankroll: DEFAULT_BANKROLL, stake: DEFAULT_STAKE };
  }

  try {
    const raw = window.localStorage.getItem(BANKROLL_STORAGE_KEY);
    if (!raw) return { bankroll: DEFAULT_BANKROLL, stake: DEFAULT_STAKE };

    const parsed = JSON.parse(raw) as Partial<BankrollSettings>;
    const bankroll = Number(parsed.bankroll);
    const stake = Number(parsed.stake);

    return {
      bankroll: Number.isFinite(bankroll) && bankroll > 0 ? bankroll : DEFAULT_BANKROLL,
      stake: Number.isFinite(stake) && stake > 0 ? stake : DEFAULT_STAKE,
    };
  } catch {
    return { bankroll: DEFAULT_BANKROLL, stake: DEFAULT_STAKE };
  }
}

export function storeBankroll(settings: BankrollSettings) {
  try {
    window.localStorage.setItem(BANKROLL_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode: the plan simply resets on reload.
  }
}
