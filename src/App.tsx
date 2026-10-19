import { useState, useEffect } from 'react';
import './App.css';

interface Odd {
  value: string;
  odd: string;
}

interface Match {
  fixture: {
    id: number;
    date: string;
  };
  league: {
    id: number;
    name: string;
    logo: string;
  };
  teams: {
    home: { name: string; logo: string };
    away: { name: string; logo: string };
  };
  odds: Odd[] | null;
  ai_analysis?: string;
}

interface SnapshotData {
  status: string;
  date: string;
  quota_remaining: string;
  match_count: number;
  matches: Match[];
}

// The list of leagues for the sidebar
const LEAGUES = [
  { id: 39, name: "Premier League", logo: "https://media.api-sports.io/football/leagues/39.png" },
  { id: 135, name: "Serie A", logo: "https://media.api-sports.io/football/leagues/135.png" },
  { id: 78, name: "Bundesliga", logo: "https://media.api-sports.io/football/leagues/78.png" },
  { id: 140, name: "La Liga", logo: "https://media.api-sports.io/football/leagues/140.png" },
  { id: 61, name: "Ligue 1", logo: "https://media.api-sports.io/football/leagues/61.png" },
  { id: 71, name: "Brasileirão", logo: "https://media.api-sports.io/football/leagues/71.png" },
  { id: 94, name: "Primeira Liga", logo: "https://media.api-sports.io/football/leagues/94.png" },
  { id: 144, name: "Belgian Pro League", logo: "https://media.api-sports.io/football/leagues/144.png" },
  { id: 88, name: "Eredivisie", logo: "https://media.api-sports.io/football/leagues/88.png" },
  { id: 40, name: "EFL Championship", logo: "https://media.api-sports.io/football/leagues/40.png" }
];

function App() {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLeague, setSelectedLeague] = useState<number>(39); // Default to EPL

  useEffect(() => {
    fetch('/api/snapshot')
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || 'Failed to fetch data');
        return data;
      })
      .then((data: SnapshotData) => {
        setData(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  if (loading) return <div className="loader">Loading today's matches...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  // Filter based on sidebar selection
  const filteredMatches = data.matches.filter(m => m.league.id === selectedLeague);

  return (
    <div className="app-layout">
      
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>⚽ Scout</h2>
        </div>
        <div className="league-list">
          {LEAGUES.map((league) => (
            <button 
              key={league.id}
              className={`league-btn ${selectedLeague === league.id ? 'active' : ''}`}
              onClick={() => setSelectedLeague(league.id)}
            >
              <img src={league.logo} alt={league.name} />
              <span>{league.name}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="main-content">
        <header className="top-bar">
          <h1>{LEAGUES.find(l => l.id === selectedLeague)?.name}</h1>
          <div className="header-stats">
            <span>Date: {data.date}</span>
            <span className="quota">API Quota: {data.quota_remaining}</span>
          </div>
        </header>

        <div className="match-grid">
          {filteredMatches.length === 0 ? (
            <div className="empty-state">No matches today for {LEAGUES.find(l => l.id === selectedLeague)?.name}.</div>
          ) : (
            filteredMatches.map((match) => (
              <div key={match.fixture.id} className="match-card">
                
                <div className="card-header">
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
            ))
          )}
        </div>
      </main>
    </div>
  );
}

export default App;