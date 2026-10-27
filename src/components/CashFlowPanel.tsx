import { useEffect, useState } from "react";
import { MOMO_FEE_PCT, fetchTransfers, formatGhs } from "../lib/wallets";
import type { TransfersPayload } from "../types";
import "./CashFlowPanel.css";

interface CashFlowPanelProps {
  simulation: boolean;
  /** Bumped after a transfer or settlement so the ledger refetches. */
  refreshToken: number;
  /** Lifetime totals already returned by GET /api/wallets, so the cards paint immediately. */
  summary: { count: number; deposited: number; withdrawn: number; net: number } | null;
  /** Mobile-money balance: bankroll that is not sitting in a bookie account. */
  cashReserve: number;
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
  cashReserve,
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
            <code>wallet_transfers</code>.{" "}
            <span className="cashflow-fees">
              {MOMO_FEE_PCT}% MoMo fees (merchant line) — profits are not reduced by transaction
              fees.
            </span>
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
            <strong>{formatGhs(totals.deposited)}</strong>
          </div>
          <div className="cashflow-stat">
            <span>Total withdrawn</span>
            <strong>{formatGhs(totals.withdrawn)}</strong>
          </div>
          <div className={`cashflow-stat net${totals.net < 0 ? " negative" : ""}`}>
            <span>Net cash in</span>
            <strong>{formatGhs(totals.net)}</strong>
          </div>
          <div
            className="cashflow-stat reserve"
            title="Bankroll that stayed in mobile money instead of going into a bookie"
          >
            <span>Unallocated cash</span>
            <strong>{formatGhs(cashReserve)}</strong>
          </div>
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
          title={
            baseTarget > 0
              ? `Keep ${formatGhs(baseTarget)} in each bookie and withdraw the rest`
              : "Set a bankroll first so there is a base target to keep"
          }
        >
          {cashingOut ? "Withdrawing…" : "Withdraw Weekly Profits"}
        </button>
        <span className="cashflow-actions-hint">
          Keeps {formatGhs(baseTarget)} per bookie · sweeps the excess in 50s
        </span>
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
                {formatGhs(transfer.amount)}
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
