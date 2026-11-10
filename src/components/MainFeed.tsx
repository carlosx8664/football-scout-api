import { useEffect, useMemo, useState } from "react";
import type { LiveMatch, Match } from "../types";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import {
  indexLiveMatches,
  liveLabel,
  scoreParts,
  useLiveScores,
  useServerClock,
} from "../lib/liveScores";
import { FEED_DAYS, daySections, liveMatches } from "../lib/schedule";
import BookBreakdown from "./BookBreakdown";
import "./MainFeed.css";

interface MainFeedProps {
  matches: Match[];
  date: string;
  now: number;
  /** Notifies the app which fixture's row is expanded, so the rail can show its league table. */
  onSelectMatch?: (match: Match | null) => void;
}

/** A fixture at or past this age (and absent from the live feed) is treated as finished. */
const MATCH_DURATION_MS = 120 * 60 * 1000;

/** Country shown in the league heading, keyed by API-Football league id. */
const LEAGUE_COUNTRY: Record<number, string> = {
  39: "England",
  40: "England",
  45: "England",
  48: "England",
  135: "Italy",
  78: "Germany",
  140: "Spain",
  61: "France",
  71: "Brazil",
  94: "Portugal",
  203: "Turkey",
  119: "Denmark",
  144: "Belgium",
  88: "Netherlands",
  2: "Europe",
  3: "Europe",
  848: "Europe",
  1: "World",
  5: "Europe",
  10: "World",
  36: "Africa",
  29: "Africa",
  30: "Asia",
  31: "North America",
  32: "Europe",
  33: "Oceania",
  34: "South America",
};

const leagueHeading = (league: Match["league"]): string => {
  const country = LEAGUE_COUNTRY[league.id];
  return country ? `${country.toUpperCase()}: ${league.name}` : league.name;
};

interface RowState {
  kind: "scheduled" | "live" | "finished";
  status: string;
  score: string;
}

/** Final/current goals from the snapshot, formatted as "1 - 0"; blank when unknown. */
function goalsScore(match: Match): string {
  const home = match.goals?.home;
  const away = match.goals?.away;
  return home == null || away == null ? "" : `${home} - ${away}`;
}

/** Turns "67'" into "67'", a minute past 90 into "90+3'", and leaves HT/FT untouched. */
function liveClock(match: LiveMatch, anchor: { now: number; serverNow: number }): string {
  const label = liveLabel(match, anchor);
  const minute = /^(\d+)'$/.exec(label);
  if (!minute) return label || "Live";

  const value = Number(minute[1]);
  return value > 90 ? `90+${value - 90}'` : `${value}'`;
}

function describeMatch(
  match: Match,
  liveById: Map<string, LiveMatch>,
  anchor: { now: number; serverNow: number },
): RowState {
  const live = match.sr_id ? liveById.get(match.sr_id) : undefined;

  // The live feed always wins when it knows the fixture.
  if (live) {
    const ended = live.status === 4 || live.matchStatus === "Ended";
    const parts = scoreParts(live.score);

    if (ended) {
      return {
        kind: "finished",
        status: "Finished",
        score: parts ? `${parts.home} - ${parts.away}` : goalsScore(match),
      };
    }

    return {
      kind: "live",
      status: liveClock(live, anchor),
      score: parts ? `${parts.home} - ${parts.away}` : "0 - 0",
    };
  }

  // No live entry: a kickoff well in the past is finished, otherwise it is still upcoming.
  const kickoff = new Date(match.fixture.date).getTime();
  if (kickoff + MATCH_DURATION_MS < anchor.now) {
    return { kind: "finished", status: "Finished", score: goalsScore(match) };
  }

  return {
    kind: "scheduled",
    status: formatKickoff(match.fixture.date).time,
    score: "",
  };
}

const OddsPanel = ({ match }: { match: Match }) => {
  const prices = matchWinnerPrices(match.odds);
  const totals = (match.odds ?? []).filter((entry) => /^(over|under)\b/i.test(entry.value));

  return (
    <div className="score-detail">
      <div className="odds-market">
        <span className="odds-market-title">1X2</span>
        <div className="odds-market-row">
          <div className="odds-cell">
            <span className="odds-cell-label">1</span>
            <strong>{prices.home}</strong>
            <BookBreakdown price={match.book_odds?.home} />
          </div>
          <div className="odds-cell">
            <span className="odds-cell-label">X</span>
            <strong>{prices.draw}</strong>
            <BookBreakdown price={match.book_odds?.draw} />
          </div>
          <div className="odds-cell">
            <span className="odds-cell-label">2</span>
            <strong>{prices.away}</strong>
            <BookBreakdown price={match.book_odds?.away} />
          </div>
        </div>
      </div>

      <div className="odds-market">
        <span className="odds-market-title">Over / Under</span>
        {totals.length > 0 ? (
          <div className="odds-market-row">
            {totals.map((entry) => (
              <div className="odds-cell" key={entry.value}>
                <span className="odds-cell-label">{entry.value}</span>
                <strong>{entry.odd}</strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="odds-empty">Over/Under odds are not available for this fixture.</span>
        )}
      </div>
    </div>
  );
};

interface LeagueGroup {
  league: Match["league"];
  matches: Match[];
}

/** Leagues in first-seen order, fixtures inside a league in kickoff order. */
function groupByLeague(matches: Match[]): LeagueGroup[] {
  const byLeague = new Map<number, LeagueGroup>();
  for (const match of matches) {
    const group = byLeague.get(match.league.id);
    if (group) group.matches.push(match);
    else byLeague.set(match.league.id, { league: match.league, matches: [match] });
  }
  for (const group of byLeague.values()) {
    group.matches.sort(
      (a, b) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
    );
  }
  return [...byLeague.values()];
}

const MainFeed = ({ matches, date, now, onSelectMatch }: MainFeedProps) => {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { payload: liveScores } = useLiveScores();
  // The extrapolated minute is server time minus the snapshot time, so both sides use the
  // server's clock; `now` alone would let a skewed device invent minutes.
  const { offsetMs } = useServerClock();
  const liveById = useMemo(() => indexLiveMatches(liveScores), [liveScores]);
  const liveEventIds = useMemo(() => new Set(liveById.keys()), [liveById]);
  const anchor = { now: now + offsetMs, serverNow: liveScores?.serverNow ?? 0 };

  const live = useMemo(() => liveMatches(matches, now, liveEventIds), [matches, now, liveEventIds]);
  const liveIds = useMemo(() => new Set(live.map((match) => match.fixture.id)), [live]);
  const sections = useMemo(
    () => daySections(matches, now, { days: FEED_DAYS, excludeIds: liveIds }),
    [matches, now, liveIds],
  );

  const visibleMatches = useMemo(
    () => [...live, ...sections.flatMap((section) => section.matches)],
    [live, sections],
  );

  // Drop the selection when the expanded fixture leaves the feed (day or league change).
  useEffect(() => {
    if (expandedId === null) return;
    if (visibleMatches.some((match) => match.fixture.id === expandedId)) return;
    setExpandedId(null);
    onSelectMatch?.(null);
  }, [expandedId, visibleMatches, onSelectMatch]);

  const toggleRow = (match: Match) => {
    const next = expandedId === match.fixture.id ? null : match.fixture.id;
    setExpandedId(next);
    onSelectMatch?.(next === null ? null : match);
  };

  const renderGroups = (list: Match[], keyPrefix: string) =>
    groupByLeague(list).map((group) => (
      <section className="league-group" key={`${keyPrefix}-${group.league.id}`}>
        <header className="league-group-header">
          <span className="league-group-title">{leagueHeading(group.league)}</span>
        </header>

        <div className="league-rows">
          {group.matches.map((match) => {
            const row = describeMatch(match, liveById, anchor);
            const isOpen = expandedId === match.fixture.id;

            return (
              <div className="score-item" key={match.fixture.id}>
                <button
                  type="button"
                  className={`score-row ${row.kind}${isOpen ? " open" : ""}`}
                  onClick={() => toggleRow(match)}
                  aria-expanded={isOpen}
                >
                  <span className="score-status">{row.status}</span>

                  <span className="score-fixture">
                    <span className="score-team home">
                      <span className="score-team-name">{match.teams.home.name}</span>
                      {match.teams.home.logo ? (
                        <img className="score-logo" src={match.teams.home.logo} alt="" loading="lazy" />
                      ) : null}
                    </span>
                    <span className="score-team away">
                      {match.teams.away.logo ? (
                        <img className="score-logo" src={match.teams.away.logo} alt="" loading="lazy" />
                      ) : null}
                      <span className="score-team-name">{match.teams.away.name}</span>
                    </span>
                  </span>

                  <span className="score-value">{row.score}</span>
                </button>

                {isOpen ? <OddsPanel match={match} /> : null}
              </div>
            );
          })}
        </div>
      </section>
    ));

  return (
    <main className="main-feed">
      <div className="feed-top-header">
        <h2 className="page-title">Next 7 Days</h2>
        <span className="feed-date-badge">{date}</span>
      </div>

      {live.length === 0 && sections.length === 0 ? (
        <div className="empty-state">No matches in the next 7 days for this league.</div>
      ) : (
        <div className="score-table">
          {live.length > 0 ? (
            <div className="day-section" key="live">
              <div className="day-section-header live">
                <h3 className="day-section-title">Live</h3>
                <span className="day-section-count">{live.length}</span>
              </div>
              <div className="day-section-body">{renderGroups(live, "live")}</div>
            </div>
          ) : null}

          {sections.map((section) => (
            <div className="day-section" key={section.key}>
              <div className={`day-section-header${section.isToday ? " today" : ""}`}>
                <h3 className="day-section-title">{section.label}</h3>
                <span className="day-section-count">{section.matches.length}</span>
              </div>
              <div className="day-section-body">{renderGroups(section.matches, section.key)}</div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
};

export default MainFeed;