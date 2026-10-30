import { useEffect, useState } from "react";
import { fetchTransfers, formatAmount } from "../lib/wallets";
import type { TransfersPayload } from "../types";
import "./CashFlowPanel.css";

interface CashFlowPanelProps {
  simulation: boolean;
  /** Bumped after a transfer or settlement so the ledger refetches. */
  refreshToken: number;
  /** Lifetime totals already returned by GET /api/wallets, so the cards paint immediately. */
  summary: { count: number; deposited: number; withdrawn: number; net: number } | null;
  /** Opening deposits the current plan implies (per-bookie split × selected bookies). */
  planDeposits: number;
  /** Number of bookies the bankroll is split across, 0 when no split is possible yet. */
  planCount: number;
  /** Per-bookie balance the weekly sweep leaves behind; 0 disables the button. */
  baseTarget: number;
  onCashOut: () => Promise<void>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Deposit/withdrawal ledger: how much went in, how much came out, and the recent movements. */
const CashFlowPanel = ({
  simulation,
  refreshToken,
  summary,
  planDeposits,
  planCount,
  baseTarget,
  onCashOut,
}: CashFlowPanelProps) => {
  const [result, setResult] = useState<{ key: string; payload: TransfersPayload } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
  const [cashingOut, setCashingOut] = useState(false);

  const key = simulation ? "sim" : "real";

  useEffect(() => {
    const controller = new AbortController();

    fetchTransfers(simulation, controller.signal)
      .then((next) => {
        setResult({ key, payload: next });
        setProblem(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ key, message: err.message });
      });

    return () => controller.abort();
  }, [simulation, refreshToken, key]);

  const payload = result?.key === key ? result.payload : null;
  const error = problem?.key === key ? problem.message : null;
  const loading = payload === null && error === null;
  const totals = payload?.totals ?? summary;
  const transfers = payload?.transfers ?? [];

  return (
    <section className="cashflow-panel">
      <header className="cashflow-header">
        <div>
          <h2>Cash Flow</h2>
          <p className="cashflow-subtitle">
            Deposits and withdrawals in the {simulation ? "simulation" : "real"} ledger, kept in{" "}
            <code>wallet_transfers</code>.
          </p>
        </div>
        <span className="cashflow-count">
          {totals?.count ?? 0} {(totals?.count ?? 0) === 1 ? "movement" : "movements"}
        </span>
      </header>

      {error && <p className="cashflow-error">{error}</p>}

      {totals && (
        <div className="cashflow-stats">
          <div className="cashflow-stat">
            <span>Total deposited</span>
            <strong>{formatAmount(totals.deposited)}</strong>
          </div>
          <div className="cashflow-stat">
            <span>Total withdrawn</span>
            <strong>{formatAmount(totals.withdrawn)}</strong>
          </div>
          {planCount > 0 && (
            <div className="cashflow-stat plan">
              <span>Planned deposits</span>
              <strong>{formatAmount(planDeposits)}</strong>
              <span className="cashflow-stat-hint">
                {planCount} bookie{planCount === 1 ? "" : "s"} ×{" "}
                {formatAmount(planDeposits / planCount)}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="cashflow-actions">
        <button
          type="button"
          className="cashflow-cashout"
          onClick={async () => {
            setCashingOut(true);
            try {
              await onCashOut();
            } finally {
              setCashingOut(false);
            }
          }}
          disabled={cashingOut || baseTarget <= 0}
        >
          {cashingOut ? "Withdrawing…" : "Withdraw Weekly Profits"}
        </button>
      </div>

      {loading ? (
        <p className="cashflow-empty">Loading cash flow…</p>
      ) : !payload ? null : transfers.length === 0 ? (
        <p className="cashflow-empty">
          No deposits or withdrawals yet. Use the “Top up” / “Withdraw” buttons in Rebalancing
          Hints, or set a balance directly in My Wallets.
        </p>
      ) : (
        <ul className="cashflow-list">
          {transfers.map((transfer) => (
            <li className="cashflow-row" key={transfer.id}>
              <span className={`cashflow-kind ${transfer.kind}`}>
                {transfer.kind === "deposit" ? "Deposit" : "Withdrawal"}
              </span>
              <span className="cashflow-bookie">{transfer.bookie}</span>
              <span className="cashflow-amount">
                {transfer.kind === "deposit" ? "+" : "−"}
                {formatAmount(transfer.amount)}
              </span>
              <span className="cashflow-when">{when(transfer.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default CashFlowPanel;
