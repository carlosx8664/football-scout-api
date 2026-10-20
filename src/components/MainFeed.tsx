import React from 'react';

interface MainFeedProps {
  matches: any[];
  selectedLeagueName: string;
  quota: string;
  date: string;
}

const MainFeed: React.FC<MainFeedProps> = ({ matches, selectedLeagueName, quota, date }) => {
  return (
    <main className="main-feed">
      
      <div className="feed-top-header">
        <h1 className="page-title">{selectedLeagueName}</h1>
        <span className="quota-badge">API Quota Left: {quota} | {date}</span>
      </div>

      {/* 3-Column Grid Layout */}
      <div className="match-card-grid">
        {matches.length === 0 ? (
          <div className="empty-state">No matches today for this league.</div>
        ) : (
          matches.map((match) => {
            // Extract the odds into Home/Draw/Away
            const homeOdd = match.odds?.find((o: any) => o.value === "Home")?.odd || "-";
            const drawOdd = match.odds?.find((o: any) => o.value === "Draw")?.odd || "-";
            const awayOdd = match.odds?.find((o: any) => o.value === "Away")?.odd || "-";

            return (
              <div key={match.fixture.id} className="new-match-card">
                
                {/* Red HOT Badge */}
                <div className="hot-badge">HOT 🔥</div>

                {/* Date & League */}
                <div className="card-league-date">
                  <span>{new Date(match.fixture.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                  <span>{new Date(match.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="card-league-name">{match.league.name}</div>

                {/* Teams */}
                <div className="card-teams-row">
                  <div className="card-team">
                    <img src={match.teams.home.logo} alt="home" />
                    <span>{match.teams.home.name}</span>
                  </div>
                  <span className="card-vs">-</span>
                  <div className="card-team">
                    <img src={match.teams.away.logo} alt="away" />
                    <span>{match.teams.away.name}</span>
                  </div>
                </div>

                {/* Odds Box */}
                <div className="card-prediction-box">
                  <span className="prediction-title">Match Winner Odds</span>
                  <div className="card-odds-row">
                    <div className="card-odd">
                      <span className="odd-label">1</span>
                      <span className="odd-value">{homeOdd}</span>
                    </div>
                    <div className="card-odd">
                      <span className="odd-label">X</span>
                      <span className="odd-value">{drawOdd}</span>
                    </div>
                    <div className="card-odd">
                      <span className="odd-label">2</span>
                      <span className="odd-value">{awayOdd}</span>
                    </div>
                  </div>
                </div>

                {/* View Details Button */}
                <a href={`/match/${match.fixture.id}`} className="details-btn">
                  View AI Details ➔
                </a>

                {/* Footer Badge */}
                <div className="card-footer">
                  <span>🇬🇭 Exclusive Offer</span>
                </div>

              </div>
            );
          })
        )}
      </div>
    </main>
  );
};

export default MainFeed;