import { useState, useEffect } from 'react';
import './App.css';

// Define the shape of our data so TypeScript knows what to expect
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

function App() {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch from your Cloudflare Pages Function
    fetch('/api/snapshot')
      .then(async (res) => {
        const data = await res.json();
        
        // If the backend throws an error, display it instead of hiding it
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Failed to fetch data');
        }
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

  return (
    <div className="container">
      <header className="header">
        <h1>⚽ Matchday Scout</h1>
        <p>Date: {data.date} | API Quota Left: {data.quota_remaining}</p>
      </header>

      <main className="match-list">
        {data.matches.length === 0 ? (
          <p>No matches today for tracked leagues.</p>
        ) : (
          data.matches.map((match) => (
            <div key={match.fixture.id} className="match-card">
              
              <div className="league-info">
                <img src={match.league.logo} alt="league" width="20" />
                <span>{match.league.name}</span>
                <span className="time">
                  {new Date(match.fixture.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              <div className="teams">
                <div className="team">
                  <img src={match.teams.home.logo} alt="home" width="40" />
                  <span>{match.teams.home.name}</span>
                </div>
                <div className="vs">VS</div>
                <div className="team">
                  <img src={match.teams.away.logo} alt="away" width="40" />
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

              {/* AI Analysis Block */}
              {match.ai_analysis && (
                <div className="ai-box">
                  <strong>🤖 Scout Analysis:</strong>
                  <p>{match.ai_analysis}</p>
                </div>
              )}

            </div>
          ))
        )}
      </main>
    </div>
  );
}

export default App;