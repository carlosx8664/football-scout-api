import { useEffect, useState } from "react";
import { computePlan, useBankroll } from "../lib/bankroll";
import { formatGhs } from "../lib/wallets";
import type { WalletsPayload } from "../types";
import "./BankrollPlan.css";

interface BankrollPlanProps {
  payload: WalletsPayload | null;
  simulation: boolean;
  /** Wipes the ledger and re-opens every wallet at `openingBalance`. */
  onStartAfresh: (openingBalance: number) => Promise<void>;
}

const Tip = ({ label, children }: { label: string; children: string }) => (
  <span className="bankroll-tip" tabIndex={0} title={children} aria-label={`${label}: ${children}`}>
    ⓘ
  </span>
);

/**
 * Bankroll planner: how much capital to keep across the bookies and how to move money without
 * looking automated. The bankroll/stake values are shared page-wide and persisted locally.
 */
const BankrollPlan = ({ payload, simulation, onStartAfresh }: BankrollPlanProps) => {
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
  const plan = computePlan(settings, wallets.length);
  const cash = payload?.liquidity.totalBalance ?? 0;

  const commit = (field: "bankroll" | "stake", raw: string) => {
    setDraft((current) => ({ ...current, [field]: raw }));
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return;
    setSettings({ ...settings, [field]: value });
  };

  // Opening balance: the plan's per-bookie target, snapped to a 50 GHS step.
  const openingBalance =
    wallets.length > 0
      ? Math.max(0, Math.round(plan.perWallet / 50) * 50)
      : Math.round(plan.perWallet / 50) * 50;

  const startAfresh = async () => {
    const confirmed = window.confirm(
      `Start afresh in ${simulation ? "simulation" : "real"} mode?\n\n` +
        "This deletes:\n" +
        "• every active bet\n" +
        "• the whole settled history\n" +
        "• every deposit/withdrawal record\n\n" +
        `Each of the ${wallets.length} wallets is then set to ${formatGhs(openingBalance)} ` +
        "and the page reloads from a clean slate. This cannot be undone.",
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
            Bankroll (GHS)
            <Tip label="Bankroll">
              Total capital you keep across the bookie wallets. Withdraw only profits — dipping
              into this is what triggers the low-balance top-ups.
            </Tip>
          </span>
          <input
            type="number"
            min="0"
            step="100"
            inputMode="numeric"
            value={draft.bankroll}
            onChange={(event) => commit("bankroll", event.target.value)}
          />
        </label>

        <label className="bankroll-field">
          <span>
            Stake per arb (GHS)
            <Tip label="Stake per arb">
              Total laid across both legs of one arb. A 1,000 GHS arb returns 15–30 GHS at the
              1.5–3% margins we look for.
            </Tip>
          </span>
          <input
            type="number"
            min="0"
            step="50"
            inputMode="numeric"
            value={draft.stake}
            onChange={(event) => commit("stake", event.target.value)}
          />
        </label>
      </div>

      <div className="bankroll-stats">
        <div className="bankroll-stat">
          <span>
            Target per bookie
            <Tip label="Target per bookie">
              Recommended balance in each wallet so any single leg can always be covered. Grows
              and shrinks as the wallet list changes.
            </Tip>
          </span>
          <strong>{formatGhs(plan.perWallet)}</strong>
          <span className="bankroll-stat-hint">
            {wallets.length || 0} wallet{wallets.length === 1 ? "" : "s"} in rotation
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Minimum float
            <Tip label="Minimum float">
              About four bets should be able to sit unsettled at once, because payouts take a day
              or two to land.
            </Tip>
          </span>
          <strong>{formatGhs(plan.minFloat)}</strong>
          <span className="bankroll-stat-hint">4 × stake per arb</span>
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
            {formatGhs(plan.dailyProfit[0])} – {formatGhs(plan.dailyProfit[1])}
          </strong>
          <span className="bankroll-stat-hint">
            {plan.arbsPerDay[0]}–{plan.arbsPerDay[1]} arbs a day
          </span>
        </div>

        <div className="bankroll-stat">
          <span>
            Cash in wallets
            <Tip label="Cash in wallets">
              Live from the wallets table. Pending stakes are already debited, so this is money
              you can deploy right now.
            </Tip>
          </span>
          <strong>{formatGhs(cash)}</strong>
          <span className="bankroll-stat-hint">
            {plan.bankroll > 0 ? `${Math.round((cash / plan.bankroll) * 100)}% of plan` : "—"}
          </span>
        </div>
      </div>

      {plan.underfunded && (
        <p className="bankroll-warning" role="alert">
          ⚠️ Bankroll is below 4× your per-arb stake: a {formatGhs(plan.stake)} arb needs roughly{" "}
          {formatGhs(plan.minFloat)} floating so a slow payout does not stall the next bet.
        </p>
      )}

      <div className="bankroll-danger">
        <div>
          <strong>Start afresh</strong>
          <p>
            Clears active bets, settled history and cash-flow rows for the{" "}
            {simulation ? "simulation" : "real"} ledger, then sets all {wallets.length} wallets to{" "}
            {formatGhs(openingBalance)}.
          </p>
        </div>
        <button
          type="button"
          className="bankroll-refresh"
          onClick={() => void startAfresh()}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Start afresh"}
        </button>
      </div>

      {refreshError && <p className="bankroll-warning">{refreshError}</p>}
    </section>
  );
};

export default BankrollPlan;
