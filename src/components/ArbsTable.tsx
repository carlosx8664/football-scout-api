import { Fragment, useEffect, useRef, useState } from "react";
import { fetchArbsJson } from "../lib/api";
import ArbCalculator from "./ArbCalculator";
import { useNotifications } from "../lib/notifications";
import { useSimulation } from "../lib/simulation";
// Shared with scripts/push-notify.js so a notification tap finds the same card.
import { arbDeepLinkKey } from "../../shared/arb-key.js";
import type {
  ArbHistoryLeg,
  ArbHistoryRecord,
  ArbLeg,
  ArbOpportunity,
  ArbsPayload,
} from "../types";
import LogArbModal from "./LogArbModal";
import Toast from "./Toast";
import "./ArbLedger.css";
import "./ArbsTable.css";

interface ArbsTableProps {
  now: number;
}

interface Feed {
  arbs: ArbOpportunity[];
  /** Every arb the scanner has tracked recently, including started matches. */
  history: ArbHistoryRecord[];
  generatedAt: string | null;
  /** 1 = real odds. Anything else means find-arbs.js was run in --boost test mode. */
  boost: number | null;
}

const EMPTY_FEED: Feed = { arbs: [], history: [], generatedAt: null, boost: null };

const LEGS_PER_MATCH = 2;
const PAST_LIMIT = 50;
/** 90 minutes plus half-time and stoppage; used to label a kicked-off match. */
const MATCH_DURATION_MS = 120 * 60_000;
const REFRESH_MS = 5 * 60_000;
const STALE_AFTER_MS = 30 * 60_000;
const HIGH_PROFIT_PCT = 10;
const ROUNDING_STEPS = [5, 10, 20, 50, 100, 200];

/**
 * Rounds each leg to a multiple of `step` while keeping the pair within the requested total.
 * Each leg is considered at both its floor and ceil multiple; the combination that uses the
 * largest total wins, with best worst-case profit breaking ties, so coarse steps still deploy
 * the full stake instead of silently shrinking the book.
 */
function roundStakes(
  rawStakes: Array<number | null>,
  odds: number[],
  step: number,
  target: number,
): Array<number | null> {
  if (step <= 0) return rawStakes;

  const candidates = rawStakes.map((value) => {
    if (value === null) return [null];
    if (value <= 0) return [0];
    const floor = Math.max(step, Math.floor(value / step) * step);
    const ceil = Math.max(step, Math.ceil(value / step) * step);
    return floor === ceil ? [floor] : [floor, ceil];
  });

  const search: {
    best: { stakes: Array<number | null>; worst: number; total: number } | null;
  } = { best: null };

  const walk = (index: number, current: Array<number | null>) => {
    if (index === candidates.length) {
      const total = current.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      if (total > target) return;

      const worst = current.reduce<number>((lowest, value, position) => {
        if (value === null) return lowest;
        return Math.min(lowest, value * odds[position] - total);
      }, Number.POSITIVE_INFINITY);

      const currentBest = search.best;
      const better =
        currentBest === null ||
        total > currentBest.total + 1e-9 ||
        (Math.abs(total - currentBest.total) <= 1e-9 && worst > currentBest.worst + 1e-9);
      if (better) search.best = { stakes: [...current], worst, total };
      return;
    }

    for (const option of candidates[index]) {
      current.push(option);
      walk(index + 1, current);
      current.pop();
    }
  };

  walk(0, []);

  // Nothing fits the budget: fall back to the smallest multiples.
  return search.best ? search.best.stakes : candidates.map((options) => options[0]);
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

/** Playing / finished / not-started label for a tracked arb. */
function matchStatus(
  kickoff: number,
  now: number,
): { label: string; tone: "playing" | "finished" | "upcoming" } {
  if (now < kickoff) return { label: countdown(kickoff, now), tone: "upcoming" };
  if (now < kickoff + MATCH_DURATION_MS) return { label: "Playing", tone: "playing" };
  return { label: "Finished", tone: "finished" };
}

const fmtOdds = (value: number | null | undefined): string =>
  Number.isFinite(value) ? Number(value).toFixed(2) : "—";

/** Start of today (local): past arbs from earlier days are not shown. */
function pastCutoff(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** Open -> close price for a tracked leg, with the percentage move. */
function oddsDelta(leg: ArbHistoryLeg): { open: number; close: number; pct: number } | null {
  // Odds arrive from JSON, so coerce before comparing: a string "1.8" would otherwise
  // silently null out the delta and leave the Move column stuck.
  const open = Number(leg.openOdds);
  const close = Number(leg.finalOdds ?? leg.lastOdds);
  if (!Number.isFinite(open) || !Number.isFinite(close) || open <= 0) return null;

  const pct = ((close - open) / open) * 100;
  // Anything under 0.05% is noise (and would otherwise print as "+0.0%"/"-0.0%").
  return { open, close, pct: Math.abs(pct) < 0.05 ? 0 : pct };
}

/**
 * Reads the file written by find-arbs.js: `{ generatedAt, boostApplied, arbs: [...] }`.
 * A bare array of opportunities is accepted too.
 */
function normalize(raw: unknown): Feed {
  if (Array.isArray(raw)) {
    return { arbs: raw as ArbOpportunity[], history: [], generatedAt: null, boost: null };
  }

  if (raw && typeof raw === "object") {
    const payload = raw as Partial<ArbsPayload>;
    if (Array.isArray(payload.arbs)) {
      return {
        arbs: payload.arbs,
        history: Array.isArray(payload.history) ? payload.history : [],
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
  const [activeTab, setActiveTab] = useState<"live" | "past">("live");
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const { enabled: simulation } = useSimulation();
  const { refresh: refreshNotifications } = useNotifications();
  // Arb handed to the Log Arb modal, plus the keys already written to D1 in this session.
  const [logTarget, setLogTarget] = useState<{
    key: string;
    arb: ArbOpportunity;
    legs: ArbLeg[];
    stakes: Array<number | null>;
  } | null>(null);
  const [loggedKeys, setLoggedKeys] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);

  // A push notification deep-links to /arbs?arb=<key>. Read it once on mount, then highlight
  // that card for a few seconds so the user can see which arb the ping was about.
  const deepLinkTarget = useRef(new URLSearchParams(window.location.search).get("arb"));
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const deepLinkDone = useRef(false);

  useEffect(() => {
    const target = deepLinkTarget.current;
    if (!target || deepLinkDone.current || feed === null) return;
    deepLinkDone.current = true;

    // Drop the param straight away so a reload or a later refresh starts clean.
    window.history.replaceState({}, "", "/arbs");

    const card = [...document.querySelectorAll<HTMLElement>("[data-arb-key]")].find(
      (node) => node.dataset.arbKey === target,
    );

    if (!card) {
      setToast("That arbitrage opportunity is no longer available.");
      return;
    }

    setHighlightKey(target);
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [feed]);

  useEffect(() => {
    if (!highlightKey) return;
    const timer = setTimeout(() => setHighlightKey(null), 6000);
    return () => clearTimeout(timer);
  }, [highlightKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        // KV-backed feed first (fresh every 15 min), static file as fallback.
        const payload = await fetchArbsJson(controller.signal);
        if (!payload) {
          console.warn("No arbitrage feed available; showing empty state.");
          setFeed((previous) => previous ?? EMPTY_FEED);
          return;
        }
        setFeed(normalize(payload));
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

  // Only complete two-leg opportunities for games that have not started can be shown live.
  const liveRows = (feed?.arbs ?? []).filter(
    (arb) =>
      Number.isFinite(arb.kickoff) &&
      Number.isFinite(arb.profitPct) &&
      arb.kickoff > now &&
      legsFor(arb).length === LEGS_PER_MATCH,
  );

  // Anything already kicked off (or dropped out of the feed since) comes from history,
  // limited to today's fixtures only.
  const cutoff = pastCutoff(now);
  const pastRows = (feed?.history ?? [])
    .filter(
      (record) =>
        Number.isFinite(record.kickoff) &&
        record.kickoff >= cutoff &&
        record.kickoff <= now &&
        Array.isArray(record.legs) &&
        record.legs.length > 0,
    )
    .sort((a, b) => b.kickoff - a.kickoff)
    .slice(0, PAST_LIMIT);

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

          <div className="arbs-toolbar">
            <div className="arbs-tabs" role="tablist" aria-label="Arbitrage windows">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "live"}
              className={`arbs-tab${activeTab === "live" ? " active" : ""}`}
              onClick={() => setActiveTab("live")}
            >
              Live Arbs
              <span className="tab-count">{liveRows.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "past"}
              className={`arbs-tab${activeTab === "past" ? " active" : ""}`}
              onClick={() => setActiveTab("past")}
            >
              Past Arbs
              <span className="tab-count">{pastRows.length}</span>
            </button>
            </div>

            <button
              type="button"
              className="arbs-calc-open"
              onClick={() => setCalculatorOpen(true)}
            >
              Open Calculator
            </button>
          </div>

          {activeTab === "live" ? (
            liveRows.length === 0 ? (
              <div className="arbs-state">No live arbitrage opportunities at this time.</div>
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
                    const value = Number.isFinite(next) ? Math.max(0, next) : 0;
                    setTotalStake(value);
                    // A rounding step larger than the stake cannot be honoured.
                    setRounding((current) => (current > value ? 0 : current));
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
                    <option key={step} value={step} disabled={step > totalStake}>
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
                      <th scope="col">Ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveRows.map((arb, arbIndex) => {
                      const legs = legsFor(arb);
                      const kickoff = kickoffLabel(arb.kickoff);
                      const rowClass = arbIndex % 2 === 1 ? "arb-row-alt" : undefined;
                      const rowKey = arbKey(arb, legs);
                      const deepKey = arbDeepLinkKey(arb);
                      const rowClasses = [
                        rowClass,
                        highlightKey === deepKey ? "arb-row-highlight" : null,
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const logged = loggedKeys.includes(rowKey);

                      const rawStakes = legs.map((leg) =>
                        typeof leg.stake === "number"
                          ? (leg.stake / 100) * totalStake
                          : null,
                      );
                      const stakes = roundStakes(
                        rawStakes,
                        legs.map((leg) => leg.odds),
                        rounding,
                        totalStake,
                      );
                      // Rounding can nudge the legs above or below the requested total, so
                      // profit is measured against what would actually be laid out.
                      const outlay = stakes.reduce<number>(
                        (sum, stake) => sum + (stake ?? 0),
                        0,
                      );
                      const laidOut = outlay > 0 ? outlay : totalStake;

                      return (
                        <Fragment key={rowKey}>
                          {legs.map((leg, legIndex) => {
                            const legStake = stakes[legIndex];
                            // Payout on this side minus the full outlay: what you keep if it wins.
                            const legProfit =
                              legStake === null ? null : legStake * leg.odds - laidOut;

                            return (
                            <tr
                              className={rowClasses || undefined}
                              // Anchor for the notification deep link; first leg carries it.
                              data-arb-key={legIndex === 0 ? deepKey : undefined}
                              key={`${leg.bookmaker}-${leg.outcome}`}
                            >
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
                                {leg.url ? (
                                  <a 
                                    href={leg.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer" 
                                    className="arb-bookmaker-pill"
                                  >
                                    {leg.bookmaker}
                                  </a>
                                ) : (
                                  <span className="arb-bookmaker-pill">{leg.bookmaker}</span>
                                )}
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

                              {legIndex === 0 && (
                                <td className="arb-log" rowSpan={LEGS_PER_MATCH}>
                                  <label className="arb-log-toggle">
                                    <input
                                      type="checkbox"
                                      checked={logged}
                                      disabled={logged}
                                      aria-label={`Log ${arb.home} vs ${arb.away} to the ledger`}
                                      onChange={() =>
                                        setLogTarget({ key: rowKey, arb, legs, stakes })
                                      }
                                    />
                                    <span>{logged ? "Logged" : "Log"}</span>
                                  </label>
                                </td>
                              )}
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
                {liveRows.length} {liveRows.length === 1 ? "opportunity" : "opportunities"}
                {rounding > 0
                  ? ` · Stakes scaled from ${totalStake.toFixed(2)}, rounded to nearest ${rounding}`
                  : ` · Stakes scaled to ${totalStake.toFixed(2)} in total`}
              </p>
            </div>
              </>
            )
          ) : pastRows.length === 0 ? (
              <div className="arbs-state">
                No past arbitrage opportunities yet. Every arb the scanner sees is kept here after
                kickoff, along with how its prices moved.
              </div>
            ) : (
              <div className="arbs-panel">
                <div className="arbs-table-wrap">
                  <table className="arbs-table arbs-table-past">
                    <thead>
                      <tr>
                        <th scope="col">Status</th>
                        <th scope="col">Bookmaker</th>
                        <th scope="col">Event</th>
                        <th scope="col">Market</th>
                        <th scope="col">Open → Final</th>
                        <th scope="col">Move</th>
                        <th scope="col">Profit at Close</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pastRows.map((record, recordIndex) => {
                        const legs = record.legs;
                        const status = matchStatus(record.kickoff, now);
                        const kickoff = kickoffLabel(record.kickoff);
                        const rowClass = recordIndex % 2 === 1 ? "arb-row-alt" : undefined;
                        const closeProfit = record.finalProfitPct ?? record.profitPct;
                        const peakProfit = record.peakProfitPct ?? record.profitPct;
                        const span = legs.length;

                        return (
                          <Fragment
                            key={
                              record.key ??
                              `${record.kickoff}-${record.home}-${record.away}-${record.market}`
                            }
                          >
                            {legs.map((leg, legIndex) => {
                              const delta = oddsDelta(leg);
                              const moveTone =
                                delta === null
                                  ? "flat"
                                  : delta.pct > 0
                                    ? "up"
                                    : delta.pct < 0
                                      ? "down"
                                      : "flat";

                              return (
                                <tr
                                  className={rowClass}
                                  key={`${leg.bookmaker}-${leg.outcome}-${legIndex}`}
                                >
                                  {legIndex === 0 && (
                                    <td className="arb-status-cell" rowSpan={span}>
                                      <span className={`arb-status arb-status-${status.tone}`}>
                                        {status.label}
                                      </span>
                                      <span className="arb-event-when">
                                        {kickoff.date} · {kickoff.time}
                                      </span>
                                    </td>
                                  )}

                                  <td className="arb-bookmaker">
                                    <span className="arb-bookmaker-pill">{leg.bookmaker}</span>
                                  </td>

                                  {legIndex === 0 && (
                                    <td className="arb-event" rowSpan={span}>
                                      <span className="arb-event-teams">
                                        {record.home} vs {record.away}
                                      </span>
                                      {record.tournament && (
                                        <span className="arb-event-tournament">
                                          {record.tournament}
                                        </span>
                                      )}
                                      {record.note && (
                                        <span className="arb-note">{record.note}</span>
                                      )}
                                    </td>
                                  )}

                                  <td className="arb-market">
                                    <span className="arb-market-type">{record.market || "—"}</span>
                                    <span className="arb-market-outcome">
                                      {leg.outcome || "—"}
                                    </span>
                                  </td>

                                  <td className="arb-odds">
                                    <span className="arb-odds-move">
                                      <span className="arb-odds-open">
                                        {fmtOdds(delta?.open ?? leg.openOdds)}
                                      </span>
                                      <span className="arb-odds-arrow">→</span>
                                      <span className="arb-odds-final">
                                        {fmtOdds(delta?.close ?? leg.finalOdds ?? leg.lastOdds)}
                                      </span>
                                    </span>
                                    <span className="arb-stake">
                                      {leg.finalOdds == null
                                        ? "Latest pre-kickoff price"
                                        : "Final price"}
                                    </span>
                                  </td>

                                  <td className={`arb-move ${moveTone}`}>
                                    {delta === null
                                      ? "—"
                                      : `${delta.pct > 0 ? "+" : ""}${delta.pct.toFixed(1)}%`}
                                  </td>

                                  {legIndex === 0 && (
                                    <td className="arb-profit" rowSpan={span}>
                                      <span className="arb-profit-value">
                                        {Number(closeProfit).toFixed(2)}%
                                      </span>
                                      <span className="arb-profit-time">
                                        Peak {Number(peakProfit).toFixed(2)}%
                                      </span>
                                    </td>
                                  )}
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
                  {pastRows.length === PAST_LIMIT
                    ? `Latest ${PAST_LIMIT} tracked`
                    : `${pastRows.length} tracked`}
                  {" · prices frozen at kickoff"}
                </p>
              </div>
          )}
        </>
      )}

      {calculatorOpen && <ArbCalculator onClose={() => setCalculatorOpen(false)} />}

      {logTarget && (
        <LogArbModal
          arb={logTarget.arb}
          legs={logTarget.legs}
          initialStakes={logTarget.stakes}
          simulation={simulation}
          onClose={() => setLogTarget(null)}
          onSaved={() => {
            const savedKey = logTarget.key;
            setLoggedKeys((current) =>
              current.includes(savedKey) ? current : [...current, savedKey],
            );
            setLogTarget(null);
            setToast("Arb logged successfully.");
            // Stakes were just debited, so re-run the balance alerts.
            refreshNotifications();
          }}
        />
      )}
      {toast && <Toast message={toast} />}
    </section>
  );
};

export default ArbsTable;