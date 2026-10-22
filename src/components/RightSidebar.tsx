import { Link } from "react-router-dom";
import { formatKickoff } from "../lib/format";
import type { Match } from "../types";
import "./RightSidebar.css";

interface RightSidebarProps {
  matches: Match[];
  date: string;
}

const RightSidebar = ({ matches, date }: RightSidebarProps) => {
  const topPicks = matches
    .filter((match) => match.fixture.date.slice(0, 10) === date)
    .flatMap((match) => {
      const prices = [
        { side: "Home", odd: Number(match.odds?.find((entry) => entry.value === "Home")?.odd) },
        { side: "Away", odd: Number(match.odds?.find((entry) => entry.value === "Away")?.odd) },
      ].filter((price) => Number.isFinite(price.odd) && price.odd > 0);
      const favorite = prices.sort((a, b) => a.odd - b.odd)[0];

      return favorite ? [{ match, favorite }] : [];
    })
    .filter(({ favorite }) => favorite.odd < 1.6)
    .sort((a, b) => a.favorite.odd - b.favorite.odd)
    .slice(0, 5);

  return (
    <aside className="right-sidebar">
      <section className="top-picks-container">
        <h3>🔥 Top AI Picks</h3>
        <p className="top-picks-subtitle">Highest confidence matches today</p>
        {topPicks.length > 0 ? (
          <ul className="top-picks-list">
            {topPicks.map(({ match, favorite }) => (
              <li className="top-pick" key={match.fixture.id}>
                <div className="top-pick-teams">
                  <span>{match.teams.home.name} vs {match.teams.away.name}</span>
                  <span className="top-pick-time">{formatKickoff(match.fixture.date).time}</span>
                </div>
                <div className="top-pick-footer">
                  <span className="top-pick-odds">
                    {favorite.side} {favorite.odd.toFixed(2)}
                  </span>
                  <Link className="top-pick-link" to={`/match/${match.fixture.id}`}>
                    View details
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="top-picks-empty">No high-confidence picks available today.</p>
        )}
      </section>
    </aside>
  );
};

export default RightSidebar;