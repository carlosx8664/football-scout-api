import { useEffect, useState } from "react";
import { computePlan, useBankroll } from "../lib/bankroll";
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
 * Cash-only split for rebalancing. Bookies holding a bet placed inside the pending-settlement
 * window are marked so the gauge can show why they are excluded.
 */
function buildHints(
  wallets: Wallet[],
  perWalletTarget: number,
  pendingBookies: string[],
): { cash: number; hints: Hint[] } {
  const cash = wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
  const pending = new Set(pendingBookies.map((name) => name.toLowerCase()));
  const hints: Hint[] = [];

  if (cash > 0) {
    // Money targets come from the Bankroll Plan (bankroll / number of wallets) so the advice
    // matches the capital you say you are running, not just today uneven split.
    const target = perWalletTarget > 0 ? perWalletTarget : (TARGET_PCT / 100) * cash;

    for (const wallet of wallets) {
      if (pending.has(wallet.name.toLowerCase())) continue;

      const share = (wallet.balance / cash) * 100;

      if (share < LOW_PCT) {
        const needed = target - wallet.balance;
        const deposit = snap("deposit", needed);

        if (needed > MIN_TOPUP_GHS && deposit !== null) {
          hints.push({
            tone: "good",
            message:
              `🟢 Top up ${wallet.name} with ${formatGhs(deposit)} to reach ` +
              `${formatGhs(target)} capacity.`,
            detail:
              needed > MAX_TRANSFER
                ? `Deposit ${formatGhs(needed)} total (${formatGhs(deposit)} per movement, ` +
                  "round number for human behavior)."
                : `Deposit ${formatGhs(deposit)} (Round number for human behavior).`,
            action: { walletId: wallet.id, kind: "deposit", amount: deposit },
          });
        }
      } else if (share > HIGH_PCT) {
        // Protect funds by moving the excess back to the target, in believable steps.
        const excess = wallet.balance - target;
        const withdrawal = snap("withdrawal", excess);

        hints.push({
          tone: "bad",
          message: `🔴 Withdraw from ${wallet.name} to protect funds.`,
          detail:
            withdrawal !== null
              ? `Withdraw ${formatGhs(withdrawal)} to return to ${formatGhs(target)} capacity.`
              : "Balance is above the safe band; withdraw when the amount is worth it.",
          action:
            withdrawal !== null
              ? { walletId: wallet.id, kind: "withdrawal", amount: withdrawal }
              : undefined,
        });
      }
    }
  }

  // BetBoro pays out slowly once the balance builds up, so any positive balance is flagged,
  // unless that cash is currently funding a bet.
  const betboro = wallets.find(
    (wallet) => wallet.name.toLowerCase() === SPECIAL_BOOKIE.toLowerCase(),
  );
  if (betboro && betboro.balance > 0 && !pending.has(betboro.name.toLowerCase())) {
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

  return { cash, hints };
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
  const pendingBookies = payload?.pendingSettlement?.bookies ?? [];
  const { settings } = useBankroll();
  const plan = computePlan(settings, wallets.length);
  const { cash, hints } = buildHints(wallets, plan.perWallet, pendingBookies);
  const shareOf = (balance: number) => (cash > 0 ? (balance / cash) * 100 : 0);

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
    .filter(
      (wallet) =>
        !pendingBookies.some((name) => name.toLowerCase() === wallet.name.toLowerCase()) &&
        shareOf(wallet.balance) < LOW_PCT,
    )
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
            {simulation ? "simulation" : "real"} cash across the wallets ({formatGhs(cash)}).
            Stakes already in play are ignored, and bookies with a bet placed in the last{" "}
            {payload?.pendingSettlement?.windowHours ?? 4} hours are skipped until it settles.
            Targets follow the Bankroll Plan: {formatGhs(plan.perWallet)} per bookie.
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
              const isPending = pendingBookies.some(
                (name) => name.toLowerCase() === wallet.name.toLowerCase(),
              );
              // Gauge colours: red = underfunded, amber = over-concentrated, green = healthy.
              const band = isPending
                ? "pending"
                : share < LOW_PCT
                  ? "danger"
                  : share > HIGH_PCT
                    ? "caution"
                    : "healthy";
              return (
                <li
                  className={`rebalance-row${isPending ? " pending" : ""}`}
                  key={wallet.id}
                  title={
                    isPending
                      ? `${wallet.name} has a bet pending settlement — hints paused`
                      : undefined
                  }
                >
                  <span className="rebalance-bookie">
                    {wallet.name}
                    {isPending && <span className="rebalance-pending">in play</span>}
                  </span>
                  <span className={`rebalance-share ${band}`}>{share.toFixed(1)}%</span>
                  <span className="rebalance-bar">
                    <span
                      className={`rebalance-bar-fill ${band}`}
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
              {cash > 0
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