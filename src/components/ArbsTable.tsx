import { Fragment, useEffect, useState } from "react";
import type { ArbOpportunity, ArbsPayload } from "../types";
import "./ArbsTable.css";

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

/**
 * Accepts `{ generatedAt, arbs: [...] }`, a bare array of opportunities, or a single
 * opportunity object so the page keeps working across feed versions.
 */
function normalize(raw: unknown): { arbs: ArbOpportunity[]; generatedAt: string | null } {
  if (Array.isArray(raw)) {
    return { arbs: raw as ArbOpportunity[], generatedAt: null };
  }

  if (raw && typeof raw === "object") {
    const payload = raw as Partial<ArbsPayload> & Partial<ArbOpportunity>;
    if (Array.isArray(payload.arbs)) {
      return { arbs: payload.arbs, generatedAt: payload.generatedAt ?? null };
    }
    if (Array.isArray(payload.legs)) {
      return { arbs: [payload as ArbOpportunity], generatedAt: null };
    }
  }

  return { arbs: [], generatedAt: null };
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

        const { arbs: opportunities, generatedAt: updatedAt } = normalize(
          await response.json(),
        );
        setArbs(opportunities);
        setGeneratedAt(updatedAt);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Could not read arbs.json; showing empty state.", error);
        setArbs([]);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  const rows = (arbs ?? []).filter((arb) =>
    (arb.legs ?? []).some((leg) => Number.isFinite(leg.odds)),
  );

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
                  const legs = (arb.legs ?? []).filter((leg) => Number.isFinite(leg.odds));
                  const kickoff = kickoffLabel(arb.kickoff);
                  const rowClass = arbIndex % 2 === 1 ? "arb-row-alt" : undefined;

                  return (
                    <Fragment key={`${arb.kickoff}-${arb.home}-${arb.away}`}>
                      {legs.map((leg, legIndex) => (
                        <tr className={rowClass} key={`${leg.bookmaker}-${leg.outcome}`}>
                          {legIndex === 0 && (
                            <td className="arb-profit" rowSpan={legs.length}>
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
                            <span className="arb-bookmaker-pill">{leg.bookmaker}</span>
                          </td>

                          {legIndex === 0 && (
                            <td className="arb-event" rowSpan={legs.length}>
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
                            <span className="arb-market-type">{arb.market}</span>
                            <span className="arb-market-outcome">{leg.outcome}</span>
                          </td>

                          <td className="arb-odds">
                            <span className="arb-odds-value">{leg.odds.toFixed(2)}</span>
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
