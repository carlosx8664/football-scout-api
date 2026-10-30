import { useEffect, useState } from "react";
import { cancelBet, fetchActiveBets, settleBet } from "../lib/bets";
import { formatAmount } from "../lib/wallets";
import type {
  ActiveBetRecord,
  ActiveBetsPayload,
  CancelBetResult,
  SettleBetRequest,
  SettleBetResult,
} from "../types";
import SettleBetModal from "./SettleBetModal";
import "./ActiveBetsLedger.css";

/** Two cards per page keeps the sidebar readable once several arbs are live. */
const PAGE_SIZE = 2;

interface ActiveBetsLedgerProps {
  simulation: boolean;
  /** Bumped by the dashboard after a settlement so the list and wallets refetch together. */
  refreshToken: number;
  onSettled: (result: SettleBetResult) => void;
  /** Fired after a cancellation so wallets, hints and alerts refetch with the refunded stakes. */
  onCancelled: (result: CancelBetResult) => void;
}

const ActiveBetsLedger = ({
  simulation,
  refreshToken,
  onSettled,
  onCancelled,
}: ActiveBetsLedgerProps) => {
  // Tagged with the mode that produced each response so a stale answer cannot be shown.
  const [result, setResult] = useState<{ simulation: boolean; payload: ActiveBetsPayload } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ simulation: boolean; message: string } | null>(null);
  const [target, setTarget] = useState<ActiveBetRecord | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetchActiveBets(simulation, controller.signal)
      .then((next) => {
        setResult({ simulation, payload: next });
        setProblem(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ simulation, message: err.message });
      });

    return () => controller.abort();
  }, [simulation, refreshToken, localRefresh]);

  const payload = result?.simulation === simulation ? result.payload : null;
  const error = problem?.simulation === simulation ? problem.message : null;
  const loading = payload === null && error === null;
  const bets = payload?.activeBets ?? [];

  // Clamped during render, so settling/cancelling the last card on a page can never strand the
  // view on an empty page.
  const pageCount = Math.max(1, Math.ceil(bets.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = bets.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const settle = async (bet: ActiveBetRecord, request: SettleBetRequest) => {
    const settled = await settleBet(bet.id, request);
    setTarget(null);
    setLocalRefresh((current) => current + 1);
    onSettled(settled);
  };

  const cancel = async (bet: ActiveBetRecord) => {
    // A free bet's leg A was never debited, so only the hedge stake comes back.
    const total = bet.isFreeBet ? bet.legB.stake : bet.legA.stake + bet.legB.stake;
    const confirmed = window.confirm(
      `Remove ${bet.eventName}?\n\n${formatAmount(total)} will be refunded to ` +
        `${bet.isFreeBet ? bet.legB.name : `${bet.legA.name} and ${bet.legB.name}`}, and the bet ` +
        "will leave the ledger. " +
        "A zero-profit “Cancelled” entry is kept in History for your records.",
    );
    if (!confirmed) return;

    setCancellingId(bet.id);
    try {
      const cancelled = await cancelBet(bet.id, simulation);
      setProblem(null);
      setLocalRefresh((current) => current + 1);
      onCancelled(cancelled);
    } catch (err) {
      setProblem({ simulation, message: (err as Error).message });
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <section className="active-bets-panel">
      <header className="active-bets-header">
        <div>
          <h2>Active Bets</h2>
          <p className="active-bets-subtitle">
            Unsettled arbs in the {simulation ? "simulation" : "real"} ledger. Both stakes were
            debited when the bet was logged; settling records a win, void/refund or cash out.
          </p>
        </div>
        <span className="active-bets-count">{bets.length}</span>
      </header>

      {error && <p className="active-bets-error">{error}</p>}

      {loading ? (
        <p className="active-bets-empty">Loading active bets…</p>
      ) : !payload ? null : bets.length === 0 ? (
        <p className="active-bets-empty">
          No active bets. Tick an arb on the <a href="/arbs">Arbs</a> page, or log a mug bet, to
          start the ledger.
        </p>
      ) : (
        <>
          <ul className="active-bets-list">
            {visible.map((bet) => (
              <li className="active-bet-card" key={bet.id}>
                <div className="active-bet-top">
                  <span className="active-bet-event">{bet.eventName}</span>
                  {bet.kind === "arb" ? (
                    <span
                      className={`active-bet-profit${bet.profitPercent < 0 ? " negative" : ""}`}
                    >
                      {bet.profitPercent.toFixed(2)}%
                    </span>
                  ) : (
                    <span className={`active-bet-kind ${bet.kind}`}>
                      {bet.kind === "free" ? "Free bet" : "Muggy"}
                    </span>
                  )}
                </div>

                {bet.kickoff != null ? (
                  <span className="active-bet-when">
                    Kickoff {new Date(bet.kickoff).toLocaleString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                ) : (
                  bet.createdAt && (
                    <span className="active-bet-when">
                      Placed {new Date(bet.createdAt).toLocaleString("en-GB")}
                    </span>
                  )
                )}

                <ul className="active-bet-legs">
                  {[bet.legA, bet.legB]
                    // A muggy acca's second slot carries no stake, so it would just be noise.
                    .filter((leg, index) => leg.stake > 0 || bet.kind === "free" || index === 0)
                    .map((leg, index) => {
                      const role = bet.kind === "free" ? (index === 0 ? "Free bet" : "Hedge") : null;
                      return (
                        <li key={`${leg.name}-${index}`}>
                          <span className="active-bet-bookie">
                            {leg.name}
                            {leg.selection && (
                              <span className="active-bet-selection">({leg.selection})</span>
                            )}
                            {role && <span className={`active-bet-role ${bet.kind}`}>{role}</span>}
                          </span>
                          <span className="active-bet-leg-meta">
                            {leg.odds.toFixed(2)} · {formatAmount(leg.stake)}
                          </span>
                        </li>
                      );
                    })}
                </ul>

                <div className="active-bet-footer">
                  <span className="active-bet-stake">
                    Outlay{" "}
                    {formatAmount(
                      bet.isFreeBet ? bet.legB.stake : bet.legA.stake + bet.legB.stake,
                    )}
                  </span>
                  <span className="active-bet-actions">
                    <button
                      type="button"
                      className="active-bets-remove"
                      title="Remove this bet and refund both stakes"
                      onClick={() => void cancel(bet)}
                      disabled={cancellingId === bet.id}
                    >
                      {cancellingId === bet.id ? "Removing…" : "Remove"}
                    </button>
                    <button
                      type="button"
                      className="active-bets-settle"
                      onClick={() => setTarget(bet)}
                    >
                      Settle
                    </button>
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {pageCount > 1 && (
            <nav className="active-bets-pager" aria-label="Active bets pages">
              <button
                type="button"
                className="active-bets-page-btn"
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 0}
              >
                ← Prev
              </button>
              <span className="active-bets-page-label">
                Page {currentPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                className="active-bets-page-btn"
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
              >
                Next →
              </button>
            </nav>
          )}
        </>
      )}

      {target && (
        <SettleBetModal
          bet={target}
          simulation={simulation}
          onClose={() => setTarget(null)}
          onConfirm={(request) => settle(target, request)}
        />
      )}
    </section>
  );
};

export default ActiveBetsLedger;