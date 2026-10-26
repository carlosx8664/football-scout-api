import { useEffect, useState } from "react";
import { formatGhs } from "../lib/wallets";
import type { Wallet, WalletsPayload } from "../types";
import "./RebalancingHints.css";

/** Keep every bookie inside this share of the portfolio. */
const LOW_PCT = 15;
const HIGH_PCT = 40;
/** Target share a top-up aims for, and the smallest transfer worth suggesting. */
const TARGET_PCT = 25;
const MIN_TOPUP_GHS = 20;
/** Deposits are rounded up to this, so suggestions read like a human transfer. */
const ROUND_TO_GHS = 50;
/** The daily funding summary only shows inside this local-time window. */
const MORNING_START_HOUR = 8;
const MORNING_END_HOUR = 10;
const SPECIAL_BOOKIE = "BetBoro";

interface RebalancingHintsProps {
  payload: WalletsPayload | null;
  error: string | null;
  loading: boolean;
  simulation: boolean;
}

interface Hint {
  tone: "good" | "bad";
  message: string;
  detail?: string;
}

/**
 * Stakes are debited at log time, so `balance` alone is cash on hand. The bankroll is cash plus
 * money still at risk — otherwise a large pending arb would shrink the portfolio and trigger
 * false withdrawal warnings.
 */
function buildHints(wallets: Wallet[], staked: number): { bankroll: number; hints: Hint[] } {
  const cash = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
  const bankroll = cash + staked;
  const hints: Hint[] = [];

  if (bankroll > 0) {
    for (const wallet of wallets) {
      const share = (wallet.balance / bankroll) * 100;
      if (share < LOW_PCT) {
        // The transfer that brings this bookie back to the 25% operational baseline, rounded up
        // to the next 50 GHS so it looks like a real deposit rather than a computed number.
        const needed = (TARGET_PCT / 100) * bankroll - wallet.balance;
        const deposit = Math.ceil(needed / ROUND_TO_GHS) * ROUND_TO_GHS;

        if (needed > MIN_TOPUP_GHS) {
          hints.push({
            tone: "good",
            message:
              `🟢 Top up ${wallet.name} with ${formatGhs(deposit)} to reach ` +
              `${TARGET_PCT}% capacity.`,
            detail: `Deposit ${formatGhs(deposit)} (Round number for human behavior).`,
          });
        }
      } else if (share > HIGH_PCT) {
        hints.push({ tone: "bad", message: `🔴 Withdraw from ${wallet.name} to protect funds.` });
      }
    }
  }

  // BetBoro pays out slowly once the balance builds up, so any positive balance is flagged.
  const betboro = wallets.find(
    (wallet) => wallet.name.toLowerCase() === SPECIAL_BOOKIE.toLowerCase(),
  );
  if (betboro && betboro.balance > 0) {
    hints.push({
      tone: "bad",
      message:
        "🚨 BetBoro Warning: Withdraw profits immediately to avoid slow withdrawal limits.",
    });
  }

  return { bankroll, hints };
}

/** Capital rebalancing hints: per-bookie share of the portfolio plus top-up/withdraw advice. */
const RebalancingHints = ({ payload, error, loading, simulation }: RebalancingHintsProps) => {
  const wallets = payload?.wallets ?? [];
  const staked = payload?.liquidity.staked ?? 0;
  const { bankroll, hints } = buildHints(wallets, staked);
  const shareOf = (balance: number) => (bankroll > 0 ? (balance / bankroll) * 100 : 0);

  // Ticks once a minute so the morning window opens and closes without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const hour = new Date(now).getHours();
  const isMorning = hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
  const lowBookies = wallets
    .filter((wallet) => shareOf(wallet.balance) < LOW_PCT)
    .map((wallet) => wallet.name);
  const lowLabel =
    lowBookies.length <= 1
      ? (lowBookies[0] ?? "")
      : `${lowBookies.slice(0, -1).join(", ")} and ${lowBookies[lowBookies.length - 1]}`;

  return (
    <section className="rebalance-panel">
      <header className="rebalance-header">
        <div>
          <h2>Rebalancing Hints</h2>
          <p className="rebalance-subtitle">
            Keep each bookie between {LOW_PCT}% and {HIGH_PCT}% of the{" "}
            {simulation ? "simulation" : "real"} portfolio ({formatGhs(bankroll)} — cash plus
            stakes in play). Top-ups aim for {TARGET_PCT}%.
          </p>
        </div>
      </header>

      {error && <p className="rebalance-error">{error}</p>}

      {isMorning && lowBookies.length > 0 && (
        <p className="rebalance-morning" role="status">
          Morning Check: You may want to top up {lowLabel} before today&apos;s matches start.
        </p>
      )}

      {loading ? (
        <p className="rebalance-empty">Loading wallet split…</p>
      ) : !payload ? null : wallets.length === 0 ? (
        <p className="rebalance-empty">No wallets to rebalance yet.</p>
      ) : (
        <>
          <ul className="rebalance-split">
            {wallets.map((wallet) => {
              const share = shareOf(wallet.balance);
              return (
                <li className="rebalance-row" key={wallet.id}>
                  <span className="rebalance-bookie">{wallet.name}</span>
                  <span className="rebalance-share">{share.toFixed(1)}%</span>
                  <span className="rebalance-bar">
                    <span
                      className={`rebalance-bar-fill${
                        share < LOW_PCT ? " low" : share > HIGH_PCT ? " high" : ""
                      }`}
                      style={{ width: `${Math.min(share, 100)}%` }}
                    />
                  </span>
                  <span className="rebalance-balance">{formatGhs(wallet.balance)}</span>
                </li>
              );
            })}
          </ul>

          {hints.length > 0 ? (
            <ul className="rebalance-hints">
              {hints.map((hint) => (
                <li className={`rebalance-hint ${hint.tone}`} key={hint.message}>
                  {hint.message}
                  {hint.detail && <span className="rebalance-hint-detail">{hint.detail}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="rebalance-empty">
              {bankroll > 0
                ? `All bookies are inside the ${LOW_PCT}–${HIGH_PCT}% band. No action needed.`
                : "No capital in the wallets yet — top one up to start rebalancing."}
            </p>
          )}
        </>
      )}
    </section>
  );
};

export default RebalancingHints;
