import { useEffect, useState } from "react";
import { fetchActiveBets, settleBet } from "../lib/bets";
import { formatGhs } from "../lib/wallets";
import type { ActiveBetRecord, ActiveBetsPayload, SettleBetResult } from "../types";
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

  const settle = async (bet: ActiveBetRecord, winner: "a" | "b") => {
    const settled = await settleBet(bet.id, winner, simulation);
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
            debited when the bet was logged; settling pays the winning bookie and moves the
            result to history.
          </p>
        </div>
        <span className="active-bets-count">
          {bets.length} {bets.length === 1 ? "bet" : "bets"}
        </span>
      </header>

      {error && <p className="active-bets-error">{error}</p>}

      {loading ? (
        <p className="active-bets-empty">Loading active bets…</p>
      ) : !payload ? null : bets.length === 0 ? (
        <p className="active-bets-empty">
          No active bets. Tick an arb on the <a href="/arbs">Arbs</a> page to log one.
        </p>
      ) : (
        <div className="active-bets-table-wrap">
          <table className="active-bets-table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Legs</th>
                <th scope="col">Stakes</th>
                <th scope="col">Profit</th>
                <th scope="col">Settle</th>
              </tr>
            </thead>
            <tbody>
              {bets.map((bet) => (
                <tr key={bet.id}>
                  <td className="active-bets-event">
                    <span>{bet.eventName}</span>
                    {bet.createdAt && (
                      <span className="active-bets-when">
                        {new Date(bet.createdAt).toLocaleString("en-GB")}
                      </span>
                    )}
                  </td>

                  <td className="active-bets-legs">
                    {[bet.legA, bet.legB].map((leg) => (
                      <span className="active-bets-leg" key={`${leg.name}-${leg.odds}`}>
                        <strong>{leg.name}</strong> @ {leg.odds.toFixed(2)}
                      </span>
                    ))}
                  </td>

                  <td className="active-bets-stakes">
                    {[bet.legA, bet.legB].map((leg) => (
                      <span className="active-bets-leg" key={`${leg.name}-stake`}>
                        {formatGhs(leg.stake)}
                      </span>
                    ))}
                  </td>

                  <td
                    className={`active-bets-profit${bet.profitPercent < 0 ? " negative" : ""}`}
                  >
                    {bet.profitPercent.toFixed(2)}%
                  </td>

                  <td>
                    <button
                      type="button"
                      className="active-bets-settle"
                      onClick={() => setTarget(bet)}
                    >
                      Settle
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {target && (
        <SettleBetModal
          bet={target}
          simulation={simulation}
          onClose={() => setTarget(null)}
          onConfirm={(winner) => settle(target, winner)}
        />
      )}
    </section>
  );
};

export default ActiveBetsLedger;
