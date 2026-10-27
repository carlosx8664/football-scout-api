import { createContext, useContext } from "react";

export const BANKROLL_STORAGE_KEY = "oddtor:bankroll-plan";

export const DEFAULT_BANKROLL = 5_000;

/**
 * How much of the bankroll goes on one arb. The stake is derived from this instead of being
 * typed in, so the bankroll and the stake can never drift apart.
 */
export const RISK_PROFILES = [
  { key: "conservative", label: "Conservative", pct: 1 },
  { key: "balanced", label: "Balanced", pct: 2 },
  { key: "confident", label: "Confident", pct: 3 },
  { key: "aggressive", label: "Aggressive", pct: 5 },
] as const;

export type RiskProfileKey = (typeof RISK_PROFILES)[number]["key"];

export const DEFAULT_RISK_PROFILE: RiskProfileKey = "balanced";

/** Both legs of one arb must be covered, so the float is 2× the stake. */
export const FLOAT_MULTIPLE = 2;
/** Deposits in round steps look human; precise amounts look automated. */
export const BLEND_STEP = 50;
/** Share of the bankroll each bookie should hold when everything is balanced. */
export const BOOKIE_SHARE_PCT = 25;

/**
 * Nearest round step to `amount`, for telling the user what to actually key into a bookie app.
 * The plan keeps the exact target (1,666.67); this is only what to deposit so it blends in.
 * e.g. 1,666.67 -> 1,650, 833.33 -> 850.
 */
export function blendInAmount(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.max(BLEND_STEP, Math.round(amount / BLEND_STEP) * BLEND_STEP);
}

export interface BankrollSettings {
  /** Total capital you keep across the bookie wallets. */
  bankroll: number;
  riskProfile: RiskProfileKey;
}

export interface BankrollPlan {
  bankroll: number;
  riskProfile: RiskProfileKey;
  riskLabel: string;
  /** Percentage of the bankroll staked on one arb. */
  riskPct: number;
  /** Derived from bankroll × riskPct — never entered directly. */
  stake: number;
  /** How many arbs the bankroll can fund at once. */
  concurrency: number;
  /** Float needed to place both legs of one arb without running dry. */
  minFloat: number;
  /** Target balance per bookie wallet. */
  perWallet: number;
  /** Arbs per day the plan is designed for. */
  arbsPerDay: [number, number];
  /** Realistic daily profit at 1.5–3% margin. */
  dailyProfit: [number, number];
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** The profile for `key`, falling back to the default when storage holds something unknown. */
export function riskProfileOf(key: RiskProfileKey) {
  return (
    RISK_PROFILES.find((profile) => profile.key === key) ??
    RISK_PROFILES.find((profile) => profile.key === DEFAULT_RISK_PROFILE) ??
    RISK_PROFILES[0]
  );
}

/**
 * @param walletCount wallets in rotation; only affects `perWallet`.
 */
export function computePlan(settings: BankrollSettings, walletCount = 1): BankrollPlan {
  const bankroll = Math.max(0, settings.bankroll);
  const profile = riskProfileOf(settings.riskProfile);
  const stake = round2((bankroll * profile.pct) / 100);
  const wallets = Math.max(1, walletCount);

  return {
    bankroll,
    riskProfile: profile.key,
    riskLabel: profile.label,
    riskPct: profile.pct,
    stake,
    concurrency: stake > 0 ? Math.floor(bankroll / stake) : 0,
    minFloat: round2(stake * FLOAT_MULTIPLE),
    perWallet: bankroll / wallets,
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

const isRiskProfileKey = (value: unknown): value is RiskProfileKey =>
  RISK_PROFILES.some((profile) => profile.key === value);

/** Maps a legacy stored `stake` onto the nearest profile, so old plans survive the upgrade. */
function closestRiskProfile(stake: number, bankroll: number): RiskProfileKey {
  if (!(stake > 0) || !(bankroll > 0)) return DEFAULT_RISK_PROFILE;

  const pct = (stake / bankroll) * 100;
  return RISK_PROFILES.reduce((best, profile) =>
    Math.abs(profile.pct - pct) < Math.abs(best.pct - pct) ? profile : best,
  ).key;
}

export function readStoredBankroll(): BankrollSettings {
  const fallback: BankrollSettings = {
    bankroll: DEFAULT_BANKROLL,
    riskProfile: DEFAULT_RISK_PROFILE,
  };

  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(BANKROLL_STORAGE_KEY);
    if (!raw) return fallback;

    // `stake` is read too: plans saved before the risk-profile change stored it directly.
    const parsed = JSON.parse(raw) as Partial<BankrollSettings> & { stake?: number };

    const bankroll = Number(parsed.bankroll);
    const safeBankroll = Number.isFinite(bankroll) && bankroll > 0 ? bankroll : DEFAULT_BANKROLL;

    const riskProfile = isRiskProfileKey(parsed.riskProfile)
      ? parsed.riskProfile
      : closestRiskProfile(Number(parsed.stake), safeBankroll);

    return { bankroll: safeBankroll, riskProfile };
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
