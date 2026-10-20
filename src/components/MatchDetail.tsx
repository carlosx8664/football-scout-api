import type { Match } from "../types";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import "./MatchDetail.css";

interface MatchDetailProps {
  match: Match | null;
  date: string;
}

const MatchDetail = ({ match, date }: MatchDetailProps) => {
  if (!match) {
    return (
      <main className="detail-container">
        <a className="back-link" href="/">
          ← Back to today's matches
        </a>
        <div className="empty-state">That match is not on today's slate ({date}).</div>
      </main>
    );
  }

  const kickoff = formatKickoff(match.fixture.date);
  const prices = matchWinnerPrices(match.odds);
  const hasScore = match.goals?.home != null && match.goals?.away != null;

  return (
    <main className="detail-container">
      <a className="back-link" href="/">
        ← Back to today's matches
      </a>

      <article className="detail-card">
        <div className="detail-meta">
          <span>{match.league.name}</span>
          <span>
            {kickoff.date} · {kickoff.time}
          </span>
        </div>

        <div className="detail-teams">
          <div className="detail-team">
            <img src={match.teams.home.logo} alt="" />
            <span>{match.teams.home.name}</span>
          </div>
          <span className="detail-score">
            {hasScore ? `${match.goals?.home} - ${match.goals?.away}` : "vs"}
          </span>
          <div className="detail-team">
            <img src={match.teams.away.logo} alt="" />
            <span>{match.teams.away.name}</span>
          </div>
        </div>

        <div className="detail-odds">
          <div className="odd-box">
            <span className="odd-label">1</span>
            <span className="odd-value">{prices.home}</span>
          </div>
          <div className="odd-box">
            <span className="odd-label">X</span>
            <span className="odd-value">{prices.draw}</span>
          </div>
          <div className="odd-box">
            <span className="odd-label">2</span>
            <span className="odd-value">{prices.away}</span>
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
