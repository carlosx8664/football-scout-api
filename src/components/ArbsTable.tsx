import { Fragment, useEffect, useState } from "react";
import type { ArbOpportunity, ArbsPayload } from "../types";
import "./ArbsTable.css";

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
  // `null` means "still loading"; an empty array means "loaded, nothing to show".
  const [arbs, setArbs] = useState<ArbOpportunity[] | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch("/arbs.json", { signal: controller.signal });
        if (!response.ok) {
          // Pages/dev servers answer a missing file with an HTML 404, so treat it as "no data".
          console.warn(`arbs.json unavailable (HTTP ${response.status}); showing empty state.`);
          setArbs([]);
          return;
        }

        const payload = (await response.json()) as ArbsPayload;
        setArbs(Array.isArray(payload?.arbs) ? payload.arbs : []);
        setGeneratedAt(payload?.generatedAt ?? null);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Could not read arbs.json; showing empty state.", error);
        setArbs([]);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  const rows = arbs ?? [];

  return (
    <section className="arbs-view">
      <h1 className="arbs-view-title">Arbitrage Scanner</h1>

      {arbs === null ? (
        <div className="arbs-state">Loading arbitrage opportunities…</div>
      ) : rows.length === 0 ? (
        <div className="arbs-state">No arbitrage opportunities found at this time.</div>
      ) : (
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
                {rows.map((arb, arbIndex) => {
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
                              <span className="arb-profit-value">
                                {arb.profitPct.toFixed(2)}%
                              </span>
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

          {generatedAt && (
            <p className="arbs-updated">
              Updated {new Date(generatedAt).toLocaleString("en-GB")}
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export default ArbsTable;
