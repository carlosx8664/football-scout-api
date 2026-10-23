import { Fragment, useEffect, useState } from "react";
import type { ArbLeg, ArbOpportunity, ArbsPayload } from "../types";
import "./ArbsTable.css";

interface ArbsTableProps {
  now: number;
}

interface Feed {
  arbs: ArbOpportunity[];
  generatedAt: string | null;
  /** 1 = real odds. Anything else means find-arbs.js was run in --boost test mode. */
  boost: number | null;
}

const EMPTY_FEED: Feed = { arbs: [], generatedAt: null, boost: null };

const LEGS_PER_MATCH = 2;
const REFRESH_MS = 5 * 60_000;
const STALE_AFTER_MS = 30 * 60_000;
const HIGH_PROFIT_PCT = 10;
const ROUNDING_STEPS = [5, 10, 15, 20];

/** Nearest multiple of `step`; a step of 0 leaves the stake untouched. */
function roundStake(value: number, step: number): number {
  if (step <= 0) return value;
  if (value <= 0) return 0;
  // Never round a live leg to zero: an unbacked side is not an arbitrage.
  return Math.max(step, Math.round(value / step) * step);
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

function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

/**
 * Reads the file written by find-arbs.js: `{ generatedAt, boostApplied, arbs: [...] }`.
 * A bare array of opportunities is accepted too.
 */
function normalize(raw: unknown): Feed {
  if (Array.isArray(raw)) {
    return { arbs: raw as ArbOpportunity[], generatedAt: null, boost: null };
  }

  if (raw && typeof raw === "object") {
    const payload = raw as Partial<ArbsPayload>;
    if (Array.isArray(payload.arbs)) {
      return {
        arbs: payload.arbs,
        generatedAt: typeof payload.generatedAt === "string" ? payload.generatedAt : null,
        boost: typeof payload.boostApplied === "number" ? payload.boostApplied : null,
      };
    }
  }

  return EMPTY_FEED;
}

function legsFor(arb: ArbOpportunity): ArbLeg[] {
  return (arb.legs ?? []).filter((leg) => Number.isFinite(leg.odds)).slice(0, LEGS_PER_MATCH);
}

function arbKey(arb: ArbOpportunity, legs: ArbLeg[]): string {
  const base = arb.eventId ?? `${arb.kickoff}-${arb.home}-${arb.away}`;
  const legPart = legs.map((leg) => `${leg.bookmaker}:${leg.outcome}`).join("|");
  return `${base}|${arb.market}|${legPart}`;
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
  // `null` means "still loading"; a feed with no arbs means "loaded, nothing to show".
  const [feed, setFeed] = useState<Feed | null>(null);
  const [totalStake, setTotalStake] = useState(100);
  const [rounding, setRounding] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch("/arbs.json", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          // Pages/dev servers answer a missing file with an HTML 404, so treat it as "no data".
          console.warn(`arbs.json unavailable (HTTP ${response.status}); showing empty state.`);
          setFeed((previous) => previous ?? EMPTY_FEED);
          return;
        }
        setFeed(normalize(await response.json()));
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Could not read arbs.json; showing empty state.", error);
        // A failed refresh keeps the last good data on screen.
        setFeed((previous) => previous ?? EMPTY_FEED);
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  // Only complete two-leg opportunities for games that have not started can be shown.
  const rows = (feed?.arbs ?? []).filter(
    (arb) =>
      Number.isFinite(arb.kickoff) &&
      Number.isFinite(arb.profitPct) &&
      arb.kickoff > now &&
      legsFor(arb).length === LEGS_PER_MATCH,
  );

  const isTestData = feed?.boost != null && Math.abs(feed.boost - 1) > 1e-9;
  const ageMs = feed?.generatedAt ? now - Date.parse(feed.generatedAt) : null;
  const isStale = ageMs !== null && Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS;

  return (
    <section className="arbs-view">
      <h1 className="arbs-view-title">Arbitrage Scanner</h1>

      {feed === null ? (
        <div className="arbs-state">Loading arbitrage opportunities…</div>
      ) : (
        <>
          {isTestData && (
            <div className="arbs-banner arbs-banner-test" role="alert">
              <strong>TEST DATA.</strong> MSport odds were multiplied by {feed.boost} when this
              file was generated. These are not real arbitrage opportunities.
            </div>
          )}

          {isStale && ageMs !== null && (
            <div className="arbs-banner arbs-banner-stale" role="status">
              This data is {formatAge(ageMs)} old. Odds move quickly, so these opportunities
              have probably gone.
            </div>
          )}

          {rows.length === 0 ? (
            <div className="arbs-state">No arbitrage opportunities found at this time.</div>
          ) : (
            <>
              <div className="arbs-stake-control">
                <label htmlFor="arbs-total-stake">Total Stake</label>
                <input
                  id="arbs-total-stake"
                  type="number"
                  min="0"
                  step="10"
                  inputMode="decimal"
                  value={totalStake}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setTotalStake(Number.isFinite(next) ? Math.max(0, next) : 0);
                  }}
                />

                <label htmlFor="arbs-rounding">Rounding</label>
                <select
                  id="arbs-rounding"
                  value={rounding}
                  onChange={(event) => setRounding(Number(event.target.value))}
                >
                  <option value={0}>None</option>
                  {ROUNDING_STEPS.map((step) => (
                    <option key={step} value={step}>
                      {step}
                    </option>
                  ))}
                </select>
              </div>

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
                      <th scope="col">Profit (GHS)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((arb, arbIndex) => {
                      const legs = legsFor(arb);
                      const kickoff = kickoffLabel(arb.kickoff);
                      const rowClass = arbIndex % 2 === 1 ? "arb-row-alt" : undefined;

                      const stakes = legs.map((leg) =>
                        typeof leg.stake === "number"
                          ? roundStake((leg.stake / 100) * totalStake, rounding)
                          : null,
                      );
                      // Rounding can nudge the legs above or below the requested total, so
                      // profit is measured against what would actually be laid out.
                      const outlay = stakes.reduce<number>(
                        (sum, stake) => sum + (stake ?? 0),
                        0,
                      );
                      const laidOut = outlay > 0 ? outlay : totalStake;

                      return (
                        <Fragment key={arbKey(arb, legs)}>
                          {legs.map((leg, legIndex) => {
                            const legStake = stakes[legIndex];
                            // Payout on this side minus the full outlay: what you keep if it wins.
                            const legProfit =
                              legStake === null ? null : legStake * leg.odds - laidOut;

                            return (
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
                                  {arb.profitPct > HIGH_PROFIT_PCT && (
                                    <span className="arb-profit-warn">Verify odds first</span>
                                  )}
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
                                  {arb.note && <span className="arb-note">{arb.note}</span>}
                                </td>
                              )}

                              <td className="arb-market">
                                <span className="arb-market-type">{arb.market || "—"}</span>
                                <span className="arb-market-outcome">{leg.outcome || "—"}</span>
                              </td>

                              <td className="arb-odds">
                                <span className="arb-odds-value">{leg.odds.toFixed(2)}</span>
                                <UpArrow />
                                {legStake !== null && (
                                  <span className="arb-stake">Stake {legStake.toFixed(2)}</span>
                                )}
                              </td>

                              <td
                                className={`arb-leg-profit${
                                  legProfit !== null && legProfit < 0 ? " negative" : ""
                                }`}
                              >
                                {legProfit === null
                                  ? "—"
                                  : `${legProfit >= 0 ? "+" : ""}${legProfit.toFixed(2)}`}
                              </td>
                            </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <p className="arbs-updated">
                {feed.generatedAt
                  ? `Updated ${new Date(feed.generatedAt).toLocaleString("en-GB")} · `
                  : ""}
                {rows.length} {rows.length === 1 ? "opportunity" : "opportunities"}
                {rounding > 0
                  ? ` · Stakes scaled from ${totalStake.toFixed(2)}, rounded to nearest ${rounding}`
                  : ` · Stakes scaled to ${totalStake.toFixed(2)} in total`}
              </p>
            </div>
            </>
          )}
        </>
      )}
    </section>
  );
};

export default ArbsTable;