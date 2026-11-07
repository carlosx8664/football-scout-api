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
  createCapitalInjection,
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
  const { settings, setSettings } = useBankroll();
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
    const amount = formatAmount(Math.abs(settled.netProfit));
    if (settled.settlementType === "loss") {
      setToast(`Bet lost: ${amount} stake gone, no wallet change.`);
      return;
    }
    const label =
      settled.settlementType === "void"
        ? "Void"
        : settled.settlementType === "cashout"
          ? "Cash out"
          : "Win";
    const result = settled.netProfit >= 0 ? "profit" : "loss";
    setToast(`${label} settled: ${result} ${amount}.`);
  }, []);

  /**
   * The plan drives the per-bookie split and the deposits it implies. Momo is real cash only:
   * every withdrawal lands in the reserve and every top-up spends from it.
   */
  const plan = (() => {
    const bookies = selectedBookies(settings);
    const splitReady = hasSplit(settings);
    const perWallet = splitReady ? computePlan(settings, bookies.length).perWallet : 0;
    return {
      count: bookies.length,
      bookies,
      splitReady,
      perWallet,
      deposits: perWallet * bookies.length,
      momo: payload?.cashReserve ?? 0,
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

  const handleCapitalInjection = useCallback(
    async (amount: number) => {
      const next = await createCapitalInjection(amount, enabled);
      const bankroll = Math.round((settings.bankroll + amount) * 100) / 100;
      const stakeRatio = settings.bankroll > 0 ? settings.stake / settings.bankroll : 0;
      const stake = Math.round(bankroll * stakeRatio * 100) / 100;
      setSettings({ ...settings, bankroll, stake });
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      setToast(`Deposited ${formatAmount(amount)} to MOMO. Bankroll is now ${formatAmount(bankroll)}.`);
    },
    [applyPayload, enabled, setSettings, settings],
  );

  /** Reset: wipe this mode's ledger and re-open every selected wallet from a new bankroll. */
  const handleReset = useCallback(
    async (bankroll: number) => {
      const bookies = selectedBookies(settings);
      const splitReady = hasSplit(settings);
      const perWallet = splitReady
        ? computePlan({ ...settings, bankroll }, bookies.length).perWallet
        : 0;
      // Only the selected bookies are funded; everything else in the ledger is zeroed. Cash the
      // rounded deposits leave behind is seeded into the Momo reserve so it stays spendable.
      const unallocated = splitReady ? unallocatedFor(bankroll, perWallet, bookies.length) : 0;
      const stakeRatio = settings.bankroll > 0 ? settings.stake / settings.bankroll : 0.2;
      const stake = Math.round(bankroll * stakeRatio * 100) / 100;

      const next = await refreshWallets(
        enabled,
        openingBalanceFor(perWallet),
        "mode",
        bookies,
        unallocated,
      );
      setSettings({ ...settings, bankroll, stake });
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      setToast(
        `Reset: ${bookies.length} selected wallets opened at ${formatAmount(openingBalanceFor(perWallet))} each for a ${formatAmount(bankroll)} bankroll.`,
      );
    },
    [applyPayload, enabled, setSettings, settings],
  );

  /** Takes profit out of the chosen bookies; the API enforces the locked/profit/bankroll caps. */
  const handleProfitTake = useCallback(
    async (allocations: Array<{ walletId: string; amount: number }>) => {
      const next = await cashOutWeeklyProfits(enabled, allocations, settings.bankroll);
      applyPayload(next);
      setRefreshToken((current) => current + 1);
      setToast(
        `Took ${formatAmount(next.cashOut.total)} of profit out of ` +
          `${next.cashOut.bookies.length} bookie${next.cashOut.bookies.length === 1 ? "" : "s"}.`,
      );
    },
    [applyPayload, enabled, settings.bankroll],
  );

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
          locked={payload?.activity.started ?? false}
          onReset={handleReset}
          onDeposit={handleCapitalInjection}
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
          wallets={payload?.wallets ?? []}
          planBookies={plan.bookies}
          locked={payload?.locked ?? []}
          totalProfit={payload?.totalProfit ?? 0}
          profitTaken={payload?.profitTaken ?? 0}
          cashInWallets={payload?.liquidity.totalBalance ?? 0}
          bankroll={settings.bankroll}
          onWithdraw={handleProfitTake}
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
