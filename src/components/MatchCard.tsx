import React from 'react';

interface Odd {
  value: string;
  odd: string;
}

interface MatchProps {
  match: {
    fixture: { id: number; date: string; };
    league: { name: string; logo: string; };
    teams: { home: { name: string; logo: string }; away: { name: string; logo: string }; };
    odds: Odd[] | null;
    ai_analysis?: string;
  };
}

const MatchCard: React.FC<MatchProps> = ({ match }) => {
  return (
    <div className="match-card">
      <div className="card-header">
        <span className="league-name">{match.league.name}</span>
        <span className="time">
          {new Date(match.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>

      <div className="teams">
        <div className="team">
          <img src={match.teams.home.logo} alt="home" />
          <span>{match.teams.home.name}</span>
        </div>
        <div className="vs">VS</div>
        <div className="team">
          <img src={match.teams.away.logo} alt="away" />
          <span>{match.teams.away.name}</span>
        </div>
      </div>

      <div className="odds-container">
        {match.odds ? (
          match.odds.map((odd, index) => (
            <div key={index} className="odd-box">
              <span className="odd-label">{odd.value}</span>
              <span className="odd-value">{odd.odd}</span>
            </div>
          ))
        ) : (
          <p className="no-odds">Odds not available yet</p>
        )}
      </div>

      {match.ai_analysis && (
        <div className="ai-box">
          <strong>🤖 Scout Analysis:</strong>
          <p>{match.ai_analysis}</p>
        </div>
      )}
    </div>
  );
};

export default MatchCard;