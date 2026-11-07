import { useEffect, useState } from "react";
import { fetchTransfers, formatAmount } from "../lib/wallets";
import type { TransfersPayload, Wallet } from "../types";
import "./CashFlowPanel.css";

interface CashFlowPanelProps {
  simulation: boolean;
  /** Bumped after a transfer or settlement so the ledger refetches. */
  refreshToken: number;
  /** Lifetime totals already returned by GET /api/wallets, so the cards paint immediately. */
  summary: { count: number; deposited: number; withdrawn: number; net: number } | null;
  wallets: Wallet[];
  /** Bookies ticked in the Bankroll Plan: only these can give up profit. */
  planBookies: string[];
  /** Cash locked in unsettled bets, per bookie. */
  locked: Array<{ bookie: string; locked: number }>;
  /** SUM(net_profit) for the mode. */
  totalProfit: number;
  /** Profit already taken out, which comes off the withdrawable cap. */
  profitTaken: number;
  /** Cash across the wallets right now, before any take. */
  cashInWallets: number;
  /** Portfolio floor: the take may never drop the wallets below this. */
  bankroll: number;
  onWithdraw: (allocations: Array<{ walletId: string; amount: number }>) => Promise<void>;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Movements shown per page in the ledger list. */
const PAGE_SIZE = 8;

/** Deposit/withdrawal ledger: how much went in, how much came out, and the recent movements. */
const CashFlowPanel = ({
  simulation,
  refreshToken,
  summary,
  wallets,
  planBookies,
  locked,
  totalProfit,
  profitTaken,
  cashInWallets,
  bankroll,
  onWithdraw,
}: CashFlowPanelProps) => {
  const [result, setResult] = useState<{ key: string; payload: TransfersPayload } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

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

    // A fresh ledger starts on page 1, so a new movement is never hidden behind a pager.
    setPage(0);

    return () => controller.abort();
  }, [simulation, refreshToken, key]);

  const payload = result?.key === key ? result.payload : null;
  const error = problem?.key === key ? problem.message : null;
  const loading = payload === null && error === null;
  const totals = payload?.totals ?? summary;
  const transfers = payload?.transfers ?? [];
  const pageCount = Math.max(1, Math.ceil(transfers.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = transfers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Only the bookies the plan is split across can release profit, in plan order.
  const rows = planBookies
    .map((name) => wallets.find((wallet) => wallet.name.toLowerCase() === name.toLowerCase()))
    .filter((wallet): wallet is Wallet => Boolean(wallet))
    .map((wallet) => {
      const lockedAmount =
        locked.find((entry) => entry.bookie.toLowerCase() === wallet.name.toLowerCase())?.locked ??
        0;
      return {
        wallet,
        available: Math.max(0, Math.round((wallet.balance - lockedAmount) * 100) / 100),
      };
    });

  const amountFor = (walletId: string) => {
    const value = Math.round(Number((amounts[walletId] ?? "").replace(/,/g, "")) * 100) / 100;
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const requested = rows.reduce((sum, row) => sum + amountFor(row.wallet.id), 0);
  const total = Math.round(requested * 100) / 100;
  const portfolioAfter = Math.round((cashInWallets - total) * 100) / 100;
  // Profit already banked is not on offer again.
  const withdrawable = Math.max(0, Math.round((totalProfit - profitTaken) * 100) / 100);

  const overAvailable = rows.find((row) => amountFor(row.wallet.id) > row.available + 0.0001);
  const guardError = overAvailable
    ? `${overAvailable.wallet.name} can only release ${formatAmount(overAvailable.available)}.`
    : total > withdrawable + 0.0001
      ? `The total cannot exceed your available profit of ${formatAmount(withdrawable)}.`
      : portfolioAfter < bankroll
        ? `This would leave ${formatAmount(portfolioAfter)} in the wallets, below the ${formatAmount(bankroll)} bankroll.`
        : null;

  const closeModal = () => {
    setOpen(false);
    setAmounts({});
    setFormError(null);
  };

  const submit = async () => {
    const allocations = rows
      .map((row) => ({ walletId: row.wallet.id, amount: amountFor(row.wallet.id) }))
      .filter((entry) => entry.amount > 0);
    if (allocations.length === 0) {
      setFormError("Enter an amount for at least one bookie.");
      return;
    }
    if (guardError) {
      setFormError(guardError);
      return;
    }

    setBusy(true);
    setFormError(null);
    try {
      await onWithdraw(allocations);
      closeModal();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        </div>
      )}

      <div className="cashflow-actions">
        <button
          type="button"
          className="cashflow-cashout"
          onClick={() => {
            setAmounts({});
            setFormError(null);
            setOpen(true);
          }}
          disabled={withdrawable <= 0 || rows.length === 0}
          title={
            withdrawable <= 0
              ? "No profit to withdraw yet."
              : "Take profit out of the selected bookie wallets."
          }
        >
          Withdraw Weekly Profits
        </button>
        {withdrawable <= 0 && (
          <small className="cashflow-hint">
            Nothing to withdraw: available profit is {formatAmount(withdrawable)}.
          </small>
        )}
      </div>

      {open && (
        <div className="cashflow-modal-backdrop" role="presentation">
          <div
            className="cashflow-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profit-take-title"
          >
            <h3 id="profit-take-title">Withdraw Weekly Profits</h3>
            <p className="cashflow-modal-copy">
              Total profit available: <strong>{formatAmount(withdrawable)}</strong>. A bookie can
              only release cash that is not locked in an active bet.
            </p>

            <ul className="cashflow-take-list">
              {rows.map(({ wallet, available }) => (
                <li className="cashflow-take-row" key={wallet.id}>
                  <div className="cashflow-take-copy">
                    <strong>{wallet.name}</strong>
                    <span>Available to Withdraw: GHS {formatAmount(available)}</span>
                  </div>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amounts[wallet.id] ?? ""}
                    onChange={(event) =>
                      setAmounts((current) => ({ ...current, [wallet.id]: event.target.value }))
                    }
                  />
                </li>
              ))}
            </ul>

            <div className="cashflow-take-total">
              <span>Total withdrawal</span>
              <strong>{formatAmount(total)}</strong>
            </div>
            <p className="cashflow-modal-hint">
              Wallets after withdrawal: {formatAmount(portfolioAfter)} · Bankroll floor:{" "}
              {formatAmount(bankroll)}
            </p>

            {(formError ?? guardError) && (
              <p className="cashflow-error" role="alert">
                {formError ?? guardError}
              </p>
            )}

            <div className="cashflow-modal-actions">
              <button type="button" className="cashflow-cancel" onClick={closeModal}>
                Cancel
              </button>
              <button
                type="button"
                className="cashflow-cashout"
                onClick={() => void submit()}
                disabled={busy || total <= 0 || Boolean(guardError)}
              >
                {busy ? "Withdrawing…" : "Confirm withdrawal"}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="cashflow-empty">Loading cash flow…</p>
      ) : !payload ? null : transfers.length === 0 ? (
        <p className="cashflow-empty">
          No deposits or withdrawals yet. Use the “Top up” / “Withdraw” buttons in Rebalancing
          Hints, or set a balance directly in My Wallets.
        </p>
      ) : (
        <>
          <ul className="cashflow-list">
            {visible.map((transfer) => (
              <li className="cashflow-row" key={transfer.id}>
                <span className={`cashflow-kind ${transfer.kind} ${transfer.type}`}>
                  {transfer.type === "CAPITAL_INJECTION"
                    ? "Capital injection"
                    : transfer.type === "INITIAL_DEPOSIT"
                      ? "Initial deposit"
                      : transfer.type === "PROFIT_WITHDRAWAL"
                        ? "Profit withdrawal"
                        : transfer.type === "TRANSFER_TO_MOMO"
                          ? "To MOMO"
                          : transfer.type === "TRANSFER_TO_BOOKIE"
                            ? "To bookie"
                            : transfer.kind === "deposit"
                              ? "Deposit"
                              : "Withdrawal"}
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

          {pageCount > 1 && (
            <div className="cashflow-pager">
              <button
                type="button"
                onClick={() => setPage(safePage - 1)}
                disabled={safePage === 0}
              >
                Prev
              </button>
              <span>
                Page {safePage + 1} of {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage(safePage + 1)}
                disabled={safePage >= pageCount - 1}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};

export default CashFlowPanel;
