import { useCallback, useEffect, useState } from "react";
import {
  computePlan,
  hasSplit,
  openingBalanceFor,
  selectedBookies,
  unallocatedFor,
  useBankroll,
} from "../lib/bankroll";
import { useNotifications } from "../lib/notifications";
import { useSimulation } from "../lib/simulation";
import {
  cashOutWeeklyProfits,
  createTransfer,
  fetchWallets,
  formatAmount,
  refreshWallets,
} from "../lib/wallets";
import type { CancelBetResult, SettleBetResult, WalletsPayload } from "../types";
import ActiveBetsLedger from "./ActiveBetsLedger";
import BankrollPlan from "./BankrollPlan";
import CashFlowPanel from "./CashFlowPanel";
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
    setToast(`${label} settled: ${result} ${formatAmount(Math.abs(settled.netProfit))}.`);
  }, []);

  /**
   * The plan drives every wallet figure: the per-bookie split, the deposits it implies and the
   * Momo leftover. Recomputed on each render, so changing the bankroll or ticking a bookie
   * reprices My Wallets, Rebalancing Hints, Cash Flow and Momo together.
   */
  const plan = (() => {
    const bookies = selectedBookies(settings);
    const splitReady = hasSplit(settings);
    const perWallet = splitReady ? computePlan(settings, bookies.length).perWallet : 0;
    const leftover = splitReady
      ? unallocatedFor(settings.bankroll, perWallet, bookies.length)
      : 0;
    return {
      count: bookies.length,
      splitReady,
      perWallet,
      deposits: perWallet * bookies.length,
      // Momo: the plan leftover plus the cash that has actually moved in and out of the bookies.
      momo: (payload?.cashReserve ?? 0) + leftover,
    };
  })();
  const momoBalance = plan.momo;

  /** Deposit/withdrawal buttons in My Wallets. Rejects so the panel can show why. */
  const handleTransfer = useCallback(
    async (walletId: string, kind: "deposit" | "withdrawal", amount: number) => {
      const next = await createTransfer(walletId, kind, amount, enabled, momoBalance);
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      const bookie = next.wallets.find((wallet) => wallet.id === walletId)?.name ?? "wallet";
      setToast(
        `${kind === "deposit" ? "Topped up" : "Withdrew"} ${formatAmount(amount)} ` +
          `${kind === "deposit" ? "to" : "from"} ${bookie}.`,
      );
    },
    [applyPayload, enabled, momoBalance],
  );

  /** Start afresh: wipe this mode's ledger and re-open every selected wallet at one balance. */
  const handleStartAfresh = useCallback(
    async (openingBalance: number) => {
      // Only the selected bookies are funded; everything else in the ledger is zeroed.
      const next = await refreshWallets(
        enabled,
        openingBalance,
        "mode",
        selectedBookies(settings),
      );
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      setToast(
        `Fresh start: ${selectedBookies(settings).length} selected wallets reset to ${formatAmount(openingBalance)} each.`,
      );
    },
    [applyPayload, enabled, settings],
  );

  /** Per-bookie base the weekly sweep leaves behind: the plan's rounded opening deposit. */
  const baseTarget = (() => {
    if (!hasSplit(settings)) return 0;
    const bookies = selectedBookies(settings).length;
    return openingBalanceFor(computePlan(settings, bookies).perWallet);
  })();

  /** Withdraw weekly profits from every bookie into the mobile-money wallet. */
  const handleCashOut = useCallback(async () => {
    if (!hasSplit(settings)) {
      setToast("Select at least two bookies in My Wallets before cashing out.");
      return;
    }

    const next = await cashOutWeeklyProfits(enabled, baseTarget);
    applyPayload(next);
    setRefreshToken((current) => current + 1);

    if (next.cashOut.total > 0) {
      setToast(`Cashed out ${formatAmount(next.cashOut.total)} from ${next.cashOut.bookies.length} bookies.`);
    } else {
      setToast(`No profits to withdraw above ${formatAmount(baseTarget)} per bookie.`);
    }
  }, [applyPayload, baseTarget, enabled, settings]);

  /** Mug-bet writes return the fresh wallet payload, so balances repaint immediately. */
  const handleMugBetChange = useCallback(
    (next: WalletsPayload) => {
      applyPayload(next);
      setRefreshToken((current) => current + 1);
    },
    [applyPayload],
  );

  const handleCancelled = useCallback((cancelled: CancelBetResult) => {
    // Refunded stakes change balances, liquidity and the rebalancing split alike.
    setRefreshToken((current) => current + 1);
    setToast(
      `Bet removed: ${formatAmount(cancelled.totalRefunded)} refunded to ` +
        `${cancelled.refunded.map((entry) => entry.bookie).join(" and ")}.`,
    );
  }, []);

  return (
    <>
      <div className="wallets-page">
        <BankrollPlan
          payload={payload}
          simulation={enabled}
          momo={momoBalance}
          onStartAfresh={handleStartAfresh}
        />
        <WalletsPanel
          payload={payload}
          error={error}
          loading={loading}
          simulation={enabled}
          momo={momoBalance}
          onTransfer={handleTransfer}
          onError={reportError}
        />
        <RebalancingHints payload={payload} error={error} loading={loading} />
      </div>
      <aside className="right-sidebar wallets-aside">
        <ActiveBetsLedger
          key={enabled ? "sim" : "real"}
          simulation={enabled}
          refreshToken={refreshToken}
          onSettled={handleSettled}
          onCancelled={handleCancelled}
        />
        <CashFlowPanel
          simulation={enabled}
          refreshToken={refreshToken}
          summary={payload?.cashFlow ?? null}
          planDeposits={plan.deposits}
          planCount={plan.count}
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
