import type { Match } from "../types";
import { Link } from "react-router-dom";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import BookBreakdown from "./BookBreakdown";
import "./MatchDetail.css";

interface MatchDetailProps {
  match: Match | null;
  date: string;
}

const MatchDetail = ({ match, date }: MatchDetailProps) => {
  if (!match) {
    return (
      <main className="detail-container">
        <Link className="back-link" to="/">
          ← Back to matches
        </Link>
        <div className="empty-state">That match is not on today's slate ({date}).</div>
      </main>
    );
  }

  const kickoff = formatKickoff(match.fixture.date);
  const prices = matchWinnerPrices(match.odds);
  const hasScore = match.goals?.home != null && match.goals?.away != null;

  return (
    <main className="detail-container">
      <Link className="back-link" to="/">
        ← Back to matches
      </Link>

      <article className="detail-card">
        <div className="detail-meta">
          <span>{match.league.name}</span>
          <span>
            {kickoff.date} · {kickoff.time}
          </span>
        </div>

        <div className="detail-teams">
          <div className="detail-team">
            {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
            <span>{match.teams.home.name}</span>
          </div>
          <span className="detail-score">
            {hasScore ? `${match.goals?.home} - ${match.goals?.away}` : "vs"}
          </span>
          <div className="detail-team">
            {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
            <span>{match.teams.away.name}</span>
          </div>
        </div>

        <div className="detail-odds">
          <div className="odd-box">
            <span className="odd-label">1</span>
            <span className="odd-value">{prices.home}</span>
            <BookBreakdown price={match.book_odds?.home} />
          </div>
          <div className="odd-box">
            <span className="odd-label">X</span>
            <span className="odd-value">{prices.draw}</span>
            <BookBreakdown price={match.book_odds?.draw} />
          </div>
          <div className="odd-box">
            <span className="odd-label">2</span>
            <span className="odd-value">{prices.away}</span>
            <BookBreakdown price={match.book_odds?.away} />
          </div>
        </div>

        <section className="ai-box">
          <strong>🤖 Scout Analysis</strong>
          <p>
            {match.ai_analysis ??
              "Analysis is still being generated for this fixture — refresh in a minute."}
          </p>
        </section>
      </article>
    </main>
  );
};

export default MatchDetail;
