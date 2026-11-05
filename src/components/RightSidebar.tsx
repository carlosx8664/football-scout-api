import { Link } from "react-router-dom";
import { formatKickoff } from "../lib/format";
import { bookQuotes, sortedQuotes } from "../lib/odds";
import type { Match } from "../types";
import BetBuilder from "./BetBuilder";
import LeagueTable from "./LeagueTable";
import "./RightSidebar.css";

interface RightSidebarProps {
  matches: Match[];
  date: string;
  /** When a match page is open, the sidebar shows that league's table instead of top picks. */
  focusMatch?: Match | null;
}

const OUTCOMES = [
  { key: "home", label: "Home" },
  { key: "draw", label: "Draw" },
  { key: "away", label: "Away" },
] as const;

type OutcomeKey = (typeof OUTCOMES)[number]["key"];

/** Only overlays of at least this size against the consensus line make the list. */
const MIN_EDGE = 0.02;

/** Fixtures need this many books quoting all three outcomes before a consensus exists. */
const MIN_BOOKS = 3;

/** Middle value; the median ignores the one book that hasn't repriced yet. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface ConsensusLine {
  /** De-vigged decimal price per outcome, i.e. the market's "true" price. */
  fair: Record<OutcomeKey, number>;
  /** Books that quoted all three outcomes and contributed to the line. */
  books: number;
}

/**
 * Market consensus for a 1X2 fixture: each book's implied probabilities are normalised to remove
 * its own overround, then the median across books becomes the fair price. That makes a genuine
 * overlay (a book beating the field) score positive while a lone stale quote does not.
 */
function consensusLine(match: Match): ConsensusLine | null {
  const book = match.book_odds;
  if (!book) return null;

  const quotes: Record<OutcomeKey, Record<string, number>> = {
    home: Object.fromEntries(bookQuotes(book.home)),
    draw: Object.fromEntries(bookQuotes(book.draw)),
    away: Object.fromEntries(bookQuotes(book.away)),
  };

  const names = Object.keys(quotes.home).filter(
    (name) => quotes.draw[name] > 1 && quotes.away[name] > 1,
  );
  if (names.length < MIN_BOOKS) return null;

  const implied: Record<OutcomeKey, number[]> = { home: [], draw: [], away: [] };

  for (const name of names) {
    const raw = {
      home: 1 / quotes.home[name],
      draw: 1 / quotes.draw[name],
      away: 1 / quotes.away[name],
    };
    const total = raw.home + raw.draw + raw.away;

    for (const outcome of OUTCOMES) implied[outcome.key].push(raw[outcome.key] / total);
  }

  return {
    books: names.length,
    fair: {
      home: 1 / median(implied.home),
      draw: 1 / median(implied.draw),
      away: 1 / median(implied.away),
    },
  };
}

interface TopPick {
  match: Match;
  label: string;
  odds: number;
  bookmaker: string;
  fairOdds: number;
  /** Best price against the fair price, as a fraction. */
  edge: number;
  books: number;
}

/** The single best-priced overlay on a fixture, or null when no outcome beats the consensus. */
function bestValue(match: Match): TopPick | null {
  const line = consensusLine(match);
  if (!line) return null;

  let pick: TopPick | null = null;

  for (const outcome of OUTCOMES) {
    const quotes = sortedQuotes(match.book_odds?.[outcome.key]);
    if (quotes.length === 0) continue;

    const [bookmaker, odds] = quotes[0];
    const fairOdds = line.fair[outcome.key];
    const edge = odds / fairOdds - 1;

    if (!pick || edge > pick.edge) {
      pick = { match, label: outcome.label, odds, bookmaker, fairOdds, edge, books: line.books };
    }
  }

  return pick;
}

const RightSidebar = ({ matches, date, focusMatch = null }: RightSidebarProps) => {
  if (focusMatch) {
    return (
      <aside className="right-sidebar">
        <LeagueTable match={focusMatch} />
      </aside>
    );
  }

  const now = Date.now();
  const topPicks = matches
    .filter(
      (match) =>
        match.fixture.date.slice(0, 10) === date &&
        new Date(match.fixture.date).getTime() > now,
    )
    .flatMap((match) => {
      const pick = bestValue(match);
      return pick ? [pick] : [];
    })
    .filter((pick) => pick.edge >= MIN_EDGE)
    .sort((a, b) => b.edge - a.edge)
    .slice(0, 5);

  return (
    <aside className="right-sidebar">
      <div className="right-sidebar-stack">
        <section className="top-picks-container">
          <h3>🔥 Top Picks</h3>
          <p className="top-picks-subtitle">Prices beating the market consensus</p>
          {topPicks.length > 0 ? (
            <ul className="top-picks-list">
              {topPicks.map((pick) => (
                <li className="top-pick" key={pick.match.fixture.id}>
                  <div className="top-pick-teams">
                    <span>{pick.match.teams.home.name} vs {pick.match.teams.away.name}</span>
                    <span className="top-pick-time">
                      {formatKickoff(pick.match.fixture.date).time}
                    </span>
                  </div>
                  <div className="top-pick-footer">
                    <span className="top-pick-odds">
                      {pick.label} {pick.odds.toFixed(2)}
                      <span className="top-pick-edge">
                        {" "}
                        +{(pick.edge * 100).toFixed(1)}% at {pick.bookmaker}
                      </span>
                    </span>
                    <Link className="top-pick-link" to={`/match/${pick.match.fixture.id}`}>
                      View details
                    </Link>
                  </div>
                  <div className="top-pick-fair">
                    fair {pick.fairOdds.toFixed(2)} · {pick.books} books
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="top-picks-empty">
              No book is pricing above the market consensus right now.
            </p>
          )}
        </section>

        <section className="bet-builder-container">
          <BetBuilder compact />
        </section>
      </div>
    </aside>
  );
};

export default RightSidebar;