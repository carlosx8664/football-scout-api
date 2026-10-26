import { useEffect, useState } from "react";
import { fetchActiveBets, settleBet } from "../lib/bets";
import { formatGhs } from "../lib/wallets";
import type {
  ActiveBetRecord,
  ActiveBetsPayload,
  SettleBetRequest,
  SettleBetResult,
} from "../types";
import SettleBetModal from "./SettleBetModal";
import "./ActiveBetsLedger.css";

interface ActiveBetsLedgerProps {
  simulation: boolean;
  /** Bumped by the dashboard after a settlement so the list and wallets refetch together. */
  refreshToken: number;
  onSettled: (result: SettleBetResult) => void;
}

const ActiveBetsLedger = ({ simulation, refreshToken, onSettled }: ActiveBetsLedgerProps) => {
  // Tagged with the mode that produced each response so a stale answer cannot be shown.
  const [result, setResult] = useState<{ simulation: boolean; payload: ActiveBetsPayload } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ simulation: boolean; message: string } | null>(null);
  const [target, setTarget] = useState<ActiveBetRecord | null>(null);
  const [localRefresh, setLocalRefresh] = useState(0);

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

  const settle = async (bet: ActiveBetRecord, request: SettleBetRequest) => {
    const settled = await settleBet(bet.id, request);
    setTarget(null);
    setLocalRefresh((current) => current + 1);
    onSettled(settled);
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
          No active bets. Tick an arb on the <a href="/arbs">Arbs</a> page to log one.
        </p>
      ) : (
        <ul className="active-bets-list">
          {bets.map((bet) => (
            <li className="active-bet-card" key={bet.id}>
              <div className="active-bet-top">
                <span className="active-bet-event">{bet.eventName}</span>
                <span
                  className={`active-bet-profit${bet.profitPercent < 0 ? " negative" : ""}`}
                >
                  {bet.profitPercent.toFixed(2)}%
                </span>
              </div>

              {bet.createdAt && (
                <span className="active-bet-when">
                  {new Date(bet.createdAt).toLocaleString("en-GB")}
                </span>
              )}

              <ul className="active-bet-legs">
                {[bet.legA, bet.legB].map((leg, index) => (
                  <li key={`${leg.name}-${index}`}>
                    <span className="active-bet-bookie">{leg.name}</span>
                    <span className="active-bet-leg-meta">
                      {leg.odds.toFixed(2)} · {formatGhs(leg.stake)}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="active-bet-footer">
                <span className="active-bet-stake">
                  Outlay {formatGhs(bet.legA.stake + bet.legB.stake)}
                </span>
                <button
                  type="button"
                  className="active-bets-settle"
                  onClick={() => setTarget(bet)}
                >
                  Settle
                </button>
              </div>
            </li>
          ))}
        </ul>
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