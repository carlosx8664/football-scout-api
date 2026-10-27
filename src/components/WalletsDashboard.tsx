import { useCallback, useEffect, useState } from "react";
import { computePlan, openingBalanceFor, useBankroll } from "../lib/bankroll";
import { startRecycleCooldown } from "../lib/cooldown";
import { useNotifications } from "../lib/notifications";
import { useSimulation } from "../lib/simulation";
import {
  cashOutWeeklyProfits,
  createTransfer,
  fetchWallets,
  formatGhs,
  recycleCapital,
  refreshWallets,
} from "../lib/wallets";
import type { CancelBetResult, SettleBetResult, WalletsPayload } from "../types";
import ActiveBetsLedger from "./ActiveBetsLedger";
import BankrollPlan from "./BankrollPlan";
import CashFlowPanel from "./CashFlowPanel";
import HistoryLedger from "./HistoryLedger";
import MoneyGuide from "./MoneyGuide";
import MugBetsPanel from "./MugBetsPanel";
import RebalancingHints from "./RebalancingHints";
import Toast from "./Toast";
import WalletsPanel from "./WalletsPanel";

/**
 * Wallets page body and the single owner of GET /api/wallets. The wallets panel and the
 * rebalancing hints both render from the same payload, so the page makes one request per mode
 * change, and a settlement refetches once for both.
 */
const WalletsDashboard = () => {
  const { enabled } = useSimulation();
  const { settings } = useBankroll();
  const { refresh: refreshNotifications } = useNotifications();
  const [refreshToken, setRefreshToken] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  // Tagged with the mode that produced it, so a stale answer is never shown as the current one.
  const [result, setResult] = useState<{ simulation: boolean; payload: WalletsPayload } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ simulation: boolean; message: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchWallets(enabled, controller.signal)
      .then((next) => {
        setResult({ simulation: enabled, payload: next });
        setProblem(null);
        refreshNotifications(next);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ simulation: enabled, message: err.message });
      });

    return () => controller.abort();
  }, [enabled, refreshToken, refreshNotifications]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const payload = result?.simulation === enabled ? result.payload : null;
  const error = problem?.simulation === enabled ? problem.message : null;
  const loading = payload === null && error === null;

  const applyPayload = useCallback(
    (next: WalletsPayload) => {
      // Writes answer with the payload's own mode, so a late PATCH cannot leak into the other.
      setResult({ simulation: next.simulation, payload: next });
      setProblem(null);
      refreshNotifications(next);
    },
    [refreshNotifications],
  );

  const reportError = useCallback((message: string | null, simulation: boolean) => {
    setProblem(message === null ? null : { simulation, message });
  }, []);

  const handleSettled = useCallback((settled: SettleBetResult) => {
    setRefreshToken((current) => current + 1);
    const label =
      settled.settlementType === "void"
        ? "Void"
        : settled.settlementType === "cashout"
          ? "Cash out"
          : "Win";
    const result = settled.netProfit >= 0 ? "profit" : "loss";
    setToast(`${label} settled: ${result} ${formatGhs(Math.abs(settled.netProfit))}.`);
  }, []);

  /** Deposit/withdrawal buttons in Rebalancing Hints. Rejects so the panel can show why. */
  const handleTransfer = useCallback(
    async (walletId: string, kind: "deposit" | "withdrawal", amount: number) => {
      const next = await createTransfer(walletId, kind, amount, enabled);
      applyPayload(next);
      const bookie = next.wallets.find((wallet) => wallet.id === walletId)?.name ?? "wallet";
      setToast(
        `${kind === "deposit" ? "Topped up" : "Withdrew"} ${formatGhs(amount)} ` +
          `${kind === "deposit" ? "to" : "from"} ${bookie}.`,
      );
    },
    [applyPayload, enabled],
  );

  /** Start afresh: wipe this mode's ledger and re-open every wallet at one balance. */
  const handleStartAfresh = useCallback(
    async (openingBalance: number) => {
      // The bankroll lets the server park the leftover as unallocated cash.
      const next = await refreshWallets(enabled, openingBalance, "mode", settings.bankroll);
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      setToast(`Fresh start: wallets reset to ${formatGhs(openingBalance)} each.`);
    },
    [applyPayload, enabled, settings.bankroll],
  );

  /** Per-bookie base the weekly sweep leaves behind: the plan's rounded opening deposit. */
  const baseTarget = (() => {
    const wallets = payload?.wallets.length ?? 0;
    if (wallets === 0) return 0;
    return openingBalanceFor(computePlan(settings, wallets).perWallet);
  })();

  /** Withdraw weekly profits from every bookie into the mobile-money wallet. */
  const handleCashOut = useCallback(async () => {
    const next = await cashOutWeeklyProfits(enabled, baseTarget);
    applyPayload(next);
    setRefreshToken((current) => current + 1);

    if (next.cashOut.total > 0) {
      setToast(`Cashed out ${formatGhs(next.cashOut.total)} from ${next.cashOut.bookies.length} bookies.`);
    } else {
      setToast(`No profits to withdraw above ${formatGhs(baseTarget)} per bookie.`);
    }
  }, [applyPayload, baseTarget, enabled]);

  /** Mug-bet writes return the fresh wallet payload, so balances repaint immediately. */
  const handleMugBetChange = useCallback(
    (next: WalletsPayload) => {
      applyPayload(next);
      setRefreshToken((current) => current + 1);
    },
    [applyPayload],
  );

  /** Merchant-MoMo capital move; starts the 15-minute cool-down before the next arb. */
  const handleRecycle = useCallback(
    async (fromWalletId: string, toWalletId: string, amount: number) => {
      const next = await recycleCapital(enabled, fromWalletId, toWalletId, amount);
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      startRecycleCooldown();
      setToast(
        `Recycled ${formatGhs(amount)}: ${next.recycle.from} → ${next.recycle.to}. ` +
          "Wait 15 minutes before the next arb.",
      );
    },
    [applyPayload, enabled],
  );

  const handleCancelled = useCallback((cancelled: CancelBetResult) => {
    // Refunded stakes change balances, liquidity and the rebalancing split alike.
    setRefreshToken((current) => current + 1);
    setToast(
      `Bet removed: ${formatGhs(cancelled.totalRefunded)} refunded to ` +
        `${cancelled.refunded.map((entry) => entry.bookie).join(" and ")}.`,
    );
  }, []);

  return (
    <>
      <div className="wallets-page">
        <BankrollPlan
          payload={payload}
          simulation={enabled}
          onStartAfresh={handleStartAfresh}
        />
        <WalletsPanel
          payload={payload}
          error={error}
          loading={loading}
          simulation={enabled}
          onPayload={applyPayload}
          onError={reportError}
        />
        <RebalancingHints
          payload={payload}
          error={error}
          loading={loading}
          simulation={enabled}
          onTransfer={handleTransfer}
          onRecycle={handleRecycle}
        />
        <HistoryLedger simulation={enabled} refreshToken={refreshToken} />
      </div>
      <aside className="right-sidebar wallets-aside">
        <ActiveBetsLedger
          key={enabled ? "sim" : "real"}
          simulation={enabled}
          refreshToken={refreshToken}
          onSettled={handleSettled}
          onCancelled={handleCancelled}
        />
        <MoneyGuide wallets={payload?.wallets ?? []} simulation={enabled} />
        <CashFlowPanel
          simulation={enabled}
          refreshToken={refreshToken}
          summary={payload?.cashFlow ?? null}
          cashReserve={payload?.cashReserve ?? 0}
          baseTarget={baseTarget}
          onCashOut={handleCashOut}
        />
        <MugBetsPanel
          simulation={enabled}
          refreshToken={refreshToken}
          wallets={payload?.wallets ?? []}
          onChanged={handleMugBetChange}
        />
      </aside>
      {toast && <Toast message={toast} />}
    </>
  );
};

export default WalletsDashboard;
