import { Link } from "react-router-dom";
import { formatKickoff } from "../lib/format";
import { sortedQuotes } from "../lib/odds";
import type { Match } from "../types";
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

/**
 * Best price available on an outcome versus the next best bookmaker, as a share of that
 * price. This is a real, checkable number: 3.10 against 3.00 is a 3.3% better price.
 */
function bestEdge(match: Match) {
  const book = match.book_odds;
  if (!book) return null;

  let pick: { label: string; odds: number; edge: number; bookmaker: string } | null = null;

  for (const outcome of OUTCOMES) {
    const quotes = sortedQuotes(book[outcome.key]);

    // Need at least two books to have any edge to measure.
    if (quotes.length < 2) continue;

    const [bestBook, bestOdds] = quotes[0];
    const other = quotes[1][1];
    const edge = bestOdds / other - 1;

    if (!pick || edge > pick.edge) {
      pick = { label: outcome.label, odds: bestOdds, edge, bookmaker: bestBook };
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

  const topPicks = matches
    .filter((match) => match.fixture.date.slice(0, 10) === date)
    .flatMap((match) => {
      const pick = bestEdge(match);
      return pick ? [{ match, pick }] : [];
    })
    .sort((a, b) => b.pick.edge - a.pick.edge)
    .slice(0, 5);

  return (
    <aside className="right-sidebar">
      <section className="top-picks-container">
        <h3>🔥 Top Picks</h3>
        <p className="top-picks-subtitle">Biggest price gaps across our books</p>
        {topPicks.length > 0 ? (
          <ul className="top-picks-list">
            {topPicks.map(({ match, pick }) => (
              <li className="top-pick" key={match.fixture.id}>
                <div className="top-pick-teams">
                  <span>{match.teams.home.name} vs {match.teams.away.name}</span>
                  <span className="top-pick-time">{formatKickoff(match.fixture.date).time}</span>
                </div>
                <div className="top-pick-footer">
                  <span className="top-pick-odds">
                    {pick.label} {pick.odds.toFixed(2)}
                    <span className="top-pick-edge">
                      {" "}
                      +{(pick.edge * 100).toFixed(1)}% at {pick.bookmaker}
                    </span>
                  </span>
                  <Link className="top-pick-link" to={`/match/${match.fixture.id}`}>
                    View details
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="top-picks-empty">
            No bookmaker is quoting a better price than the others right now.
          </p>
        )}
      </section>
    </aside>
  );
};

export default RightSidebar;