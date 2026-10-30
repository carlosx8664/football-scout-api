import { useEffect, useState } from "react";
import {
  HIGH_RISK_PCT,
  MICRO_MUG_PCT,
  MIN_BOOKIES,
  WEEKEND_ANCHOR_PCT,
  computePlan,
  hasSplit,
  openingBalanceFor,
  selectedBookies,
  unallocatedFor,
  useBankroll,
} from "../lib/bankroll";
import { formatAmount } from "../lib/wallets";
import type { WalletsPayload } from "../types";
import "./BankrollPlan.css";

interface BankrollPlanProps {
  payload: WalletsPayload | null;
  simulation: boolean;
  /** Momo cash reserve: the plan leftover seeded by Start afresh, plus withdrawals, minus top-ups. */
  momo: number;
  /** Wipes the ledger and re-opens every wallet at `openingBalance`. */
  onStartAfresh: (openingBalance: number) => Promise<void>;
}

const Tip = ({ label, children }: { label: string; children: string }) => (
  <span className="bankroll-tip" tabIndex={0} title={children} aria-label={`${label}: ${children}`}>
    ⓘ
  </span>
);

/**
 * Bankroll planner: how much capital to keep across the bookies and how to split it across the
 * bookies selected in My Wallets. The values are shared page-wide and persisted locally.
 */
const BankrollPlan = ({ payload, simulation, momo, onStartAfresh }: BankrollPlanProps) => {
  const { settings, setSettings } = useBankroll();
  const [draft, setDraft] = useState({
    bankroll: String(settings.bankroll),
    stake: String(settings.stake),
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Keep the inputs in step when another panel changes the plan.
  useEffect(() => {
    setDraft({ bankroll: String(settings.bankroll), stake: String(settings.stake) });
  }, [settings.bankroll, settings.stake]);

  const wallets = payload?.wallets ?? [];
  // Only the bookies picked in My Wallets share the bankroll; fewer than two cannot fund an arb.
  const bookies = selectedBookies(settings);
  const splitReady = hasSplit(settings);
  const plan = computePlan(settings, Math.max(bookies.length, 1));
  const perWallet = splitReady ? plan.perWallet : 0;
  // Cash across the wallets follows the plan, so it repaints as the bankroll or selection changes.
  const cash = splitReady ? perWallet * bookies.length : (payload?.liquidity.totalBalance ?? 0);

  const commitField = (field: "bankroll" | "stake", raw: string) => {
    setDraft((current) => ({ ...current, [field]: raw }));
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;

    // NEW LOGIC: If the user changes the stake, automatically scale the bankroll.
    // We use a 5x multiplier so that the stake is always exactly 20% of the bankroll.
    if (field === "stake") {
      const calculatedBankroll = value * 5;
      setDraft((current) => ({ ...current, bankroll: String(calculatedBankroll) }));
      setSettings({ ...settings, bankroll: calculatedBankroll, stake: value });
    } else {
      // If they change the bankroll directly, just update the bankroll.
      setSettings({ ...settings, [field]: value });
    }
  };

  // Opening balance: the plan's per-bookie target rounded DOWN to a round 50, so the deposits
  // never exceed the bankroll. Whatever is left over stays as unallocated (mobile-money) cash.
  const openingBalance = openingBalanceFor(perWallet);
  const unallocated = unallocatedFor(plan.bankroll, perWallet, splitReady ? bookies.length : 0);

  const startAfresh = async () => {
    const confirmed = window.confirm(
      `Start afresh in ${simulation ? "simulation" : "real"} mode?\n\n` +
        "This deletes:\n" +
        "• every active bet\n" +
        "• the whole settled history\n" +
        "• every deposit/withdrawal record\n" +
        "• every mug bet\n\n" +
        `Then the ${bookies.length} selected bookie${bookies.length === 1 ? "" : "s"} ` +
        `${bookies.length === 1 ? "is" : "are"} set to ${formatAmount(openingBalance)} each` +
        (unallocated > 0 ? `, leaving ${formatAmount(unallocated)} as unallocated cash` : "") +
        ", every unselected bookie is set to 0, and the page reloads from a clean slate. " +
        "This cannot be undone.",
    );
    if (!confirmed) return;

    setRefreshing(true);
    setRefreshError(null);
    try {
      await onStartAfresh(openingBalance);
    } catch (err) {
      setRefreshError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="bankroll-panel">
      <header className="bankroll-header">
        <div>
          <h2>Bankroll Plan</h2>
          <p className="bankroll-subtitle">
            Size your float before the weekend. Applies to the{" "}
            {simulation ? "simulation" : "real"} ledger and every hint on this page.
          </p>
        </div>
        <span className="bankroll-badge">
          {plan.concurrency} concurrent {plan.concurrency === 1 ? "arb" : "arbs"}
        </span>
      </header>

      <div className="bankroll-inputs">
        <label className="bankroll-field">
          <span>
            Bankroll
            <Tip label="Bankroll">
              Total capital you keep across the bookie wallets, split across the bookies selected
              in My Wallets.
            </Tip>
          </span>
          <input
            type="number"
            min="0"
            step="100"
            inputMode="numeric"
            value={draft.bankroll}
            onChange={(event) => commitField("bankroll", event.target.value)}
          />
        </label>

        <label className="bankroll-field">
          <span>
            Stake per arb
            <Tip label="Stake per arb">
              {`What you are willing to lay across both legs of one arb. Everything below is sized from this: float, camouflage mug bets and the profit estimate. Flagged above ${HIGH_RISK_PCT}% of your bankroll.`}
            </Tip>
          </span>
          <input
            type="number"
            min="0"
            step="10"
            inputMode="decimal"
            value={draft.stake}
            onChange={(event) => commitField("stake", event.target.value)}
          />
        </label>
      </div>

      {plan.highRisk && (
        <p className="bankroll-risk" role="alert">
          ⚠️ High Risk: This stake size leaves very little room for error. Ensure you have enough
          float in your MoMo.
        </p>
      )}

      {!splitReady && (
        <p className="bankroll-risk" role="alert">
          Select at least {MIN_BOOKIES} bookies in My Wallets so the bankroll can be split across
          them.
        </p>
      )}

      <div className="bankroll-stats">
        <div className="bankroll-stat">
          <span>
            Stake per arb
            <Tip label="Stake per arb">
              {`${plan.riskPct.toFixed(1)}% of your bankroll, split across both legs of one arb. A ${formatAmount(plan.stake)} arb returns 15–30 at the 1.5–3% margins we look for.`}
            </Tip>
          </span>
          <strong>{formatAmount(plan.stake)}</strong>
          <span className="bankroll-stat-hint">
            {plan.riskPct.toFixed(1)}% of {formatAmount(plan.bankroll)}
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Target per bookie
          </span>
          <strong>{formatAmount(perWallet)}</strong>
          <span className="bankroll-stat-hint">
            {bookies.length || 0} bookie{bookies.length === 1 ? "" : "s"} selected
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Minimum float
            <Tip label="Minimum float">
              Enough to cover both legs of one arb, so a slow payout never leaves you unable to
              place the next fill.
            </Tip>
          </span>
          <strong>{formatAmount(plan.minFloat)}</strong>
          <span className="bankroll-stat-hint">2 × stake per arb</span>
        </div>

        <div className="bankroll-stat">
          <span>
            Daily
            <Tip label="Daily">
              {`Camouflage protocol: a small single most days keeps the account looking like a normal punter. ${MICRO_MUG_PCT}% of your stake.`}
            </Tip>
          </span>
          <strong>{formatAmount(plan.microMug)}</strong>
          <span className="bankroll-stat-hint">{MICRO_MUG_PCT}% of stake</span>
        </div>

        <div className="bankroll-stat">
          <span>
            Weekend anchor
            <Tip label="Weekend anchor">
              {`Camouflage protocol: the bigger Saturday bet on a televised match. ${WEEKEND_ANCHOR_PCT}% of your stake.`}
            </Tip>
          </span>
          <strong>{formatAmount(plan.weekendAnchor)}</strong>
          <span className="bankroll-stat-hint">{WEEKEND_ANCHOR_PCT}% of stake</span>
        </div>

        <div className="bankroll-stat">
          <span>
            Expected daily profit
            <Tip label="Expected daily profit">
              Assumes 2–5 arbs a day at 1.5–3% margin on your stake. The low end is the realistic
              one once a leg or two goes stale.
            </Tip>
          </span>
          <strong>
            {formatAmount(plan.dailyProfit[0])} – {formatAmount(plan.dailyProfit[1])}
          </strong>
          <span className="bankroll-stat-hint">
            {plan.arbsPerDay[0]}–{plan.arbsPerDay[1]} arbs a day
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Cash in wallets
            <Tip label="Cash in wallets">
              Planned cash across the selected bookies (target × bookies). Pending stakes are
              already debited, so this is money you can deploy right now.
            </Tip>
          </span>
          <strong>{formatAmount(cash)}</strong>
          <span className="bankroll-stat-hint">
            {plan.bankroll > 0 ? `${Math.round((cash / plan.bankroll) * 100)}% of plan` : "—"}
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Momo
          </span>
          <strong>{formatAmount(momo)}</strong>
          <span className="bankroll-stat-hint">cash reserve</span>
        </div>
      </div>

      {wallets.length > 0 && plan.minFloat > 0 && cash < plan.minFloat && (
        <p className="bankroll-warning" role="alert">
          ⚠️ The wallets hold {formatAmount(cash)}, below the {formatAmount(plan.minFloat)} minimum
          float. A {formatAmount(plan.stake)} arb needs both legs covered, so deposit before the next
          fill.
        </p>
      )}

      <div className="bankroll-danger">
        <div>
          <strong>Start afresh</strong>
          <p>
            Clears active bets, settled history, cash-flow rows and mug bets for the{" "}
            {simulation ? "simulation" : "real"} ledger, then sets the {bookies.length} selected{" "}
            bookie{bookies.length === 1 ? "" : "s"} to {formatAmount(openingBalance)} each
            {unallocated > 0 && ` and leaves ${formatAmount(unallocated)} unallocated`}. Unselected
            bookies are set to 0.
          </p>
        </div>
        <button
          type="button"
          className="bankroll-refresh"
          onClick={() => void startAfresh()}
          disabled={refreshing || !splitReady}
        >
          {refreshing ? "Refreshing…" : "Start afresh"}
        </button>
      </div>

      {refreshError && <p className="bankroll-warning">{refreshError}</p>}
    </section>
  );
};

export default BankrollPlan;