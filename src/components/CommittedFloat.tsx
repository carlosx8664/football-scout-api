import { useEffect, useState } from "react";
import {
  fetchCommittedFloat,
  type CommittedFloat as CommittedFloatPayload,
} from "../lib/committedFloat";
import { formatAmount, formatAmountWhole } from "../lib/wallets";
import "./CommittedFloat.css";

interface CommittedFloatProps {
  simulation: boolean;
  /** Bumped by the parent after a bet is logged, settled or cancelled. */
  refreshToken?: number;
}

const REFRESH_MS = 60_000;

/** "2026-11-23" → "Mon 23 Nov", without dragging in a date library. */
function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Where the bankroll is parked and when it frees up.
 *
 * Stakes leave the wallet the moment a bet is logged, so the wallet balance is only the free part.
 * On a two-bookie, five-leg budget that free number decides whether today's arb can be taken at
 * all, and the release schedule says what comes back to fund the next one.
 */
const CommittedFloat = ({ simulation, refreshToken = 0 }: CommittedFloatProps) => {
  const [payload, setPayload] = useState<CommittedFloatPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        setPayload(await fetchCommittedFloat(simulation, controller.signal));
        setError(null);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
          setPayload(null);
        }
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [simulation, refreshToken]);

  if (error) {
    return (
      <section className="committed-float">
        <header className="committed-float-header">
          <div>
            <h2>💧 Committed Float</h2>
          </div>
        </header>
        <p className="committed-float-empty">{error}</p>
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="committed-float">
        <header className="committed-float-header">
          <div>
            <h2>💧 Committed Float</h2>
          </div>
        </header>
        <p className="committed-float-empty">Loading…</p>
      </section>
    );
  }

  const { totals, bookies, schedule } = payload;
  const free = bookies.filter((bookie) => bookie.free > 0);

  return (
    <section className="committed-float">
      <header className="committed-float-header">
        <div>
          <h2>💧 Committed Float</h2>
          <p className="committed-float-subtitle">
            Stakes leave the wallet when a bet is logged. Free cash is what you can bet with now;
            committed is what comes back after each kickoff.
          </p>
        </div>
      </header>

      <div className="committed-float-summary">
        <div className="committed-float-tile">
          <span className="committed-float-label">Free now</span>
          <span className="committed-float-value">{formatAmount(totals.free)}</span>
        </div>
        <div className="committed-float-tile">
          <span className="committed-float-label">Committed</span>
          <span className="committed-float-value">{formatAmount(totals.committed)}</span>
        </div>
        <div className="committed-float-tile">
          <span className="committed-float-label">Account total</span>
          <span className="committed-float-value">{formatAmount(totals.exposure)}</span>
        </div>
        <div className="committed-float-tile">
          <span className="committed-float-label">Biggest safe leg</span>
          <span className="committed-float-value">{formatAmountWhole(totals.freeFloor)}</span>
          <span className="committed-float-hint">smallest funded balance</span>
        </div>
      </div>

      {free.length === 0 ? (
        <p className="committed-float-empty">No funded bookie in this mode.</p>
      ) : (
        <div className="committed-float-table-wrap">
          <table className="committed-float-table">
            <thead>
              <tr>
                <th>Bookie</th>
                <th>Free</th>
                <th>Committed</th>
                <th>Settles today</th>
                <th>Total held</th>
              </tr>
            </thead>
            <tbody>
              {bookies.map((bookie) => (
                <tr key={bookie.name}>
                  <td className="committed-float-name">{bookie.name}</td>
                  <td>{formatAmount(bookie.free)}</td>
                  <td>
                    {formatAmount(bookie.committed)}
                    {bookie.bets > 0 ? (
                      <span className="committed-float-muted"> · {bookie.bets} leg(s)</span>
                    ) : null}
                  </td>
                  <td className={bookie.today > 0 ? undefined : "committed-float-muted"}>
                    {bookie.today > 0 ? formatAmount(bookie.today) : "—"}
                  </td>
                  <td>{formatAmount(bookie.exposure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="committed-float-schedule">
        <h3>Coming back</h3>
        {schedule.length === 0 ? (
          <p className="committed-float-empty">
            Nothing in play — the whole bankroll is free to bet with.
          </p>
        ) : (
          <ul>
            {schedule.map((bucket) => (
              <li key={bucket.date}>
                <span className="committed-float-day">
                  {bucket.date === payload.today ? "Today" : formatDay(bucket.date)}
                </span>
                <span className="committed-float-amount">{formatAmount(bucket.amount)}</span>
                <span className="committed-float-legs">{bucket.legs} leg(s)</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
};

export default CommittedFloat;
