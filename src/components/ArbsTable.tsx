import { Fragment, useEffect, useState } from "react";
import type { ArbLeg, ArbOpportunity, ArbsPayload } from "../types";
import "./ArbsTable.css";

interface ArbsTableProps {
  now: number;
}

const MARKET_LABELS: Record<string, string> = {
  asianhandicap: "Asian Handicap",
  btts: "Both Teams to Score",
  dnb: "Draw No Bet",
  doublechance: "Double Chance",
  doublechance1x: "Double Chance (1X)",
  doublechancex2: "Double Chance (X2)",
  doublechance12: "Double Chance (12)",
  totals: "Total Goals",
};

const OUTCOME_LABELS: Record<string, string> = {
  home: "Home",
  away: "Away",
  draw: "Draw",
  yes: "Yes",
  no: "No",
  "1x": "Home or Draw (1X)",
  x2: "Draw or Away (X2)",
  "12": "Home or Away (12)",
};

const LEGS_PER_MATCH = 2;

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

/** "25" -> "2.5", "05" -> "0.5", "105" -> "10.5" (the final digit is the fraction). */
function decimalLine(digits: string): string {
  if (digits.length < 2) return digits;
  return `${digits.slice(0, -1)}.${digits.slice(-1)}`;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatMarket(market: string): string {
  if (!market) return "—";
  const key = market.toLowerCase();
  if (MARKET_LABELS[key]) return MARKET_LABELS[key];

  const overUnder = /^overunder(\d+)$/.exec(key);
  if (overUnder) return `Over/Under ${decimalLine(overUnder[1])}`;

  return humanize(market);
}

function formatOutcome(outcome: string): string {
  if (!outcome) return "—";
  const key = outcome.toLowerCase();
  if (OUTCOME_LABELS[key]) return OUTCOME_LABELS[key];

  const over = /^over(\d+)$/.exec(key);
  if (over) return `Over ${decimalLine(over[1])}`;

  const under = /^under(\d+)$/.exec(key);
  if (under) return `Under ${decimalLine(under[1])}`;

  return humanize(outcome);
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

function legsFor(arb: ArbOpportunity): ArbLeg[] {
  return (arb.legs ?? []).filter((leg) => Number.isFinite(leg.odds)).slice(0, LEGS_PER_MATCH);
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

  // Only complete two-leg opportunities can fill the paired row layout.
  const rows = (arbs ?? []).filter((arb) => legsFor(arb).length === LEGS_PER_MATCH);

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
                  const legs = legsFor(arb);
                  const kickoff = kickoffLabel(arb.kickoff);
                  const rowClass = arbIndex % 2 === 1 ? "arb-row-alt" : undefined;

                  return (
                    <Fragment key={`${arb.kickoff}-${arb.home}-${arb.away}`}>
                      {legs.map((leg, legIndex) => (
                        <tr className={rowClass} key={`${leg.bookmaker}-${leg.outcome}`}>
                          {legIndex === 0 && (
                            <td className="arb-profit" rowSpan={LEGS_PER_MATCH}>
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
                            <td className="arb-event" rowSpan={LEGS_PER_MATCH}>
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
                            <span className="arb-market-type">
                              {formatMarket(arb.market ?? "")}
                            </span>
                            <span className="arb-market-outcome">
                              {formatOutcome(leg.outcome)}
                            </span>
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
