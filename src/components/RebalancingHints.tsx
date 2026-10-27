import { useEffect, useState } from "react";
import { MAX_TRANSFER, MIN_TRANSFER, TRANSFER_STEP, formatGhs } from "../lib/wallets";
import type { Wallet, WalletsPayload } from "../types";
import "./RebalancingHints.css";

/** Keep every bookie inside this share of the portfolio. */
const LOW_PCT = 15;
const HIGH_PCT = 40;
/** Target share a top-up aims for, and the smallest transfer worth suggesting. */
const TARGET_PCT = 25;
const MIN_TOPUP_GHS = 20;
/** The daily funding summary only shows inside this local-time window. */
const MORNING_START_HOUR = 8;
const MORNING_END_HOUR = 10;
const SPECIAL_BOOKIE = "BetBoro";

interface RebalancingHintsProps {
  payload: WalletsPayload | null;
  error: string | null;
  loading: boolean;
  simulation: boolean;
  /** Logs a deposit/withdrawal; rejects with a message when the API refuses it. */
  onTransfer: (walletId: string, kind: "deposit" | "withdrawal", amount: number) => Promise<void>;
}

interface HintAction {
  walletId: string;
  kind: "deposit" | "withdrawal";
  amount: number;
}

interface Hint {
  tone: "good" | "bad";
  message: string;
  detail?: string;
  action?: HintAction;
}

/** Round human-sized figures only: 50 GHS steps, 50–500 per movement. */
const snap = (kind: "deposit" | "withdrawal", raw: number): number | null => {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const rounded =
    kind === "withdrawal"
      ? Math.floor(raw / TRANSFER_STEP) * TRANSFER_STEP
      : Math.ceil(raw / TRANSFER_STEP) * TRANSFER_STEP;
  const clamped = Math.min(MAX_TRANSFER, Math.max(MIN_TRANSFER, rounded));
  return clamped >= MIN_TRANSFER ? clamped : null;
};

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
    const target = (TARGET_PCT / 100) * bankroll;

    for (const wallet of wallets) {
      const share = (wallet.balance / bankroll) * 100;

      if (share < LOW_PCT) {
        const needed = target - wallet.balance;
        const deposit = snap("deposit", needed);

        if (needed > MIN_TOPUP_GHS && deposit !== null) {
          hints.push({
            tone: "good",
            message:
              `🟢 Top up ${wallet.name} with ${formatGhs(deposit)} to reach ` +
              `${TARGET_PCT}% capacity.`,
            detail: `Deposit ${formatGhs(deposit)} (Round number for human behavior).`,
            action: { walletId: wallet.id, kind: "deposit", amount: deposit },
          });
        }
      } else if (share > HIGH_PCT) {
        // Protect funds by moving the excess back to 25%, in a single believable withdrawal.
        const excess = wallet.balance - target;
        const withdrawal = snap("withdrawal", excess);

        hints.push({
          tone: "bad",
          message: `🔴 Withdraw from ${wallet.name} to protect funds.`,
          detail:
            withdrawal !== null
              ? `Withdraw ${formatGhs(withdrawal)} to return to ${TARGET_PCT}% capacity.`
              : "Balance is above the safe band; withdraw when the amount is worth it.",
          action:
            withdrawal !== null
              ? { walletId: wallet.id, kind: "withdrawal", amount: withdrawal }
              : undefined,
        });
      }
    }
  }

  // BetBoro pays out slowly once the balance builds up, so any positive balance is flagged.
  const betboro = wallets.find(
    (wallet) => wallet.name.toLowerCase() === SPECIAL_BOOKIE.toLowerCase(),
  );
  if (betboro && betboro.balance > 0) {
    const withdrawal = snap("withdrawal", betboro.balance);
    hints.push({
      tone: "bad",
      message:
        "🚨 BetBoro Warning: Withdraw profits immediately to avoid slow withdrawal limits.",
      detail:
        withdrawal !== null
          ? `Withdraw ${formatGhs(withdrawal)} now (${TRANSFER_STEP} GHS steps look natural).`
          : undefined,
      action:
        withdrawal !== null
          ? { walletId: betboro.id, kind: "withdrawal", amount: withdrawal }
          : undefined,
    });
  }

  return { bankroll, hints };
}

/** Capital rebalancing hints: per-bookie share of the portfolio plus top-up/withdraw advice. */
const RebalancingHints = ({
  payload,
  error,
  loading,
  simulation,
  onTransfer,
}: RebalancingHintsProps) => {
  const wallets = payload?.wallets ?? [];
  const staked = payload?.liquidity.staked ?? 0;
  const { bankroll, hints } = buildHints(wallets, staked);
  const shareOf = (balance: number) => (bankroll > 0 ? (balance / bankroll) * 100 : 0);

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

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

  const run = async (hint: Hint) => {
    if (!hint.action) return;
    const { walletId, kind, amount } = hint.action;
    const key = `${walletId}:${kind}`;

    setBusyKey(key);
    setProblem(null);
    try {
      await onTransfer(walletId, kind, amount);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="rebalance-panel">
      <header className="rebalance-header">
        <div>
          <h2>Rebalancing Hints</h2>
          <p className="rebalance-subtitle">
            Keep each bookie between {LOW_PCT}% and {HIGH_PCT}% of the{" "}
            {simulation ? "simulation" : "real"} portfolio ({formatGhs(bankroll)} — cash plus
            stakes in play). Transfers move GHS {MIN_TRANSFER}–{MAX_TRANSFER} in {TRANSFER_STEP}{" "}
            steps, one per bookie every 10 minutes.
          </p>
        </div>
      </header>

      {error && <p className="rebalance-error">{error}</p>}
      {problem && <p className="rebalance-error">{problem}</p>}

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
                  {hint.action && (
                    <button
                      type="button"
                      className={`rebalance-action ${
                        hint.action.kind === "deposit" ? "deposit" : "withdraw"
                      }`}
                      onClick={() => void run(hint)}
                      disabled={busyKey === `${hint.action.walletId}:${hint.action.kind}`}
                    >
                      {busyKey === `${hint.action.walletId}:${hint.action.kind}`
                        ? "Recording…"
                        : `${hint.action.kind === "deposit" ? "Top up" : "Withdraw"} ${formatGhs(
                            hint.action.amount,
                          )}`}
                    </button>
                  )}
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