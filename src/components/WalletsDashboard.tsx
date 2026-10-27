import { useCallback, useEffect, useState } from "react";
import { useNotifications } from "../lib/notifications";
import { useSimulation } from "../lib/simulation";
import { fetchWallets, formatGhs } from "../lib/wallets";
import type { CancelBetResult, SettleBetResult, WalletsPayload } from "../types";
import ActiveBetsLedger from "./ActiveBetsLedger";
import HistoryLedger from "./HistoryLedger";
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
        />
        <HistoryLedger simulation={enabled} refreshToken={refreshToken} />
      </div>
      <aside className="right-sidebar wallets-aside">
        <ActiveBetsLedger
          simulation={enabled}
          refreshToken={refreshToken}
          onSettled={handleSettled}
          onCancelled={handleCancelled}
        />
      </aside>
      {toast && <Toast message={toast} />}
    </>
  );
};

export default WalletsDashboard;
