import { Fragment, useEffect, useState } from "react";
import type { ArbOpportunity, ArbsPayload } from "../types";
import "./ArbsTable.css";

/** The scanner may write either location; both resolve to a file in `public/`. */
const ARBS_URLS = ["/arbs.json", "/data/arbs.json"];

const OUTCOMES = [
  { key: "home", label: "Home" },
  { key: "draw", label: "Draw" },
  { key: "away", label: "Away" },
] as const;

type OutcomeKey = (typeof OUTCOMES)[number]["key"];

interface ArbsTableProps {
  now: number;
}

function countdown(kickoff: number, now: number): string {
  const minutes = Math.round((kickoff - now) / 60_000);
  if (minutes <= 0) return "Started";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function kickoffLabel(kickoff: number) {
  const date = new Date(kickoff);
  return {
    date: date.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    time: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}

function bookmakerFor(arb: ArbOpportunity, outcome: OutcomeKey): string {
  return arb.msport[outcome] > arb.sporty[outcome] ? "MSport" : "SportyBet";
}

async function fetchArbs(signal: AbortSignal): Promise<ArbsPayload> {
  let lastError: Error | null = null;

  for (const url of ARBS_URLS) {
    try {
      const response = await fetch(url, { signal, cache: "no-store" });
      if (!response.ok) {
        lastError = new Error(`${url} responded with HTTP ${response.status}`);
        continue;
      }
      return (await response.json()) as ArbsPayload;
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Could not load the arbitrage feed.");
}

const ClockIcon = () => (
  <svg className="arb-clock" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path
      d="M8 4.4V8.2l2.6 1.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const UpArrow = () => (
  <svg className="arb-up" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M6 1.4 10.7 6.9H7.4v3.7H4.6V6.9H1.3L6 1.4Z" fill="currentColor" />
  </svg>
);

const ArbsTable = ({ now }: ArbsTableProps) => {
  const [payload, setPayload] = useState<ArbsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchArbs(controller.signal)
      .then((data) => {
        setPayload(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, []);

  if (loading) {
    return <div className="arbs-state">Loading arbitrage opportunities…</div>;
  }

  if (error) {
    return <div className="arbs-state arbs-state-error">Could not load arbs: {error}</div>;
  }

  const arbs = payload?.arbs ?? [];

  if (arbs.length === 0) {
    return <div className="arbs-state">No arbitrage opportunities found at this time.</div>;
  }

  return (
    <div className="arbs-panel">
      <div className="arbs-table-wrap">
        <table className="arbs-table">
          <thead>
            <tr>
              <th scope="col">Profit</th>
              <th scope="col">Bookmaker</th>
              <th scope="col">Event</th>
              <th scope="col">Market</th>
              <th scope="col">Odds</th>
            </tr>
          </thead>
          <tbody>
            {arbs.map((arb, arbIndex) => {
              const outcomes = OUTCOMES.filter((outcome) =>
                Number.isFinite(arb.best[outcome.key]),
              );
              if (outcomes.length === 0) return null;

              const kickoff = kickoffLabel(arb.kickoff);
              const rowClass = arbIndex % 2 === 1 ? "arb-row-alt" : undefined;

              return (
                <Fragment key={`${arb.kickoff}-${arb.home}-${arb.away}`}>
                  {outcomes.map((outcome, outcomeIndex) => (
                    <tr className={rowClass} key={outcome.key}>
                      {outcomeIndex === 0 && (
                        <td className="arb-profit" rowSpan={outcomes.length}>
                          <span className="arb-profit-value">{arb.profitPct.toFixed(2)}%</span>
                          <span className="arb-profit-time">
                            <ClockIcon />
                            {countdown(arb.kickoff, now)}
                          </span>
                        </td>
                      )}

                      <td className="arb-bookmaker">
                        <span className="arb-bookmaker-pill">
                          {bookmakerFor(arb, outcome.key)}
                        </span>
                      </td>

                      {outcomeIndex === 0 && (
                        <td className="arb-event" rowSpan={outcomes.length}>
                          <span className="arb-event-when">
                            {kickoff.date} · {kickoff.time}
                          </span>
                          <span className="arb-event-teams">
                            {arb.home} vs {arb.away}
                          </span>
                          <span className="arb-event-tournament">{arb.tournament}</span>
                        </td>
                      )}

                      <td className="arb-market">
                        <span className="arb-market-type">1X2</span>
                        <span className="arb-market-outcome">{outcome.label}</span>
                      </td>

                      <td className="arb-odds">
                        <span className="arb-odds-value">
                          {arb.best[outcome.key].toFixed(2)}
                        </span>
                        <UpArrow />
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {payload?.generatedAt && (
        <p className="arbs-updated">
          Updated {new Date(payload.generatedAt).toLocaleString("en-GB")}
        </p>
      )}
    </div>
  );
};

export default ArbsTable;
