import { useState, useEffect } from 'react';
import './App.css';
import Header from './components/Header';
import Sidebar from './components/Sidebar';
import MainFeed from './components/MainFeed';
import RightSidebar from './components/RightSidebar';

interface SnapshotData {
  status: string;
  date: string;
  quota_remaining: string;
  match_count: number;
  matches: any[];
}

const LEAGUES = [
  { id: 39, name: "Premier League" },
  { id: 135, name: "Serie A" },
  { id: 78, name: "Bundesliga" },
  { id: 140, name: "La Liga" },
  { id: 61, name: "Ligue 1" },
  { id: 71, name: "Brasileirão" },
  { id: 94, name: "Primeira Liga" },
  { id: 144, name: "Belgian Pro League" },
  { id: 88, name: "Eredivisie" },
  { id: 40, name: "EFL Championship" }
];

function App() {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 0 = Home (Top Matches), 39 = Premier League, etc.
  const [selectedLeague, setSelectedLeague] = useState<number>(0); 

  useEffect(() => {
    fetch('/api/snapshot')
      .then(async (res) => {
        const d = await res.json();
        if (!res.ok) throw new Error(d.message || d.error || 'Failed to fetch data');
        return d;
      })
      .then((d: SnapshotData) => {
        setData(d);
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

  // If Home (0), show all matches. Otherwise, filter by league.
  const filteredMatches = selectedLeague === 0 
    ? data.matches 
    : data.matches.filter(m => m.league.id === selectedLeague);

  const selectedLeagueName = selectedLeague === 0 
    ? "Top Matches of the Day" 
    : LEAGUES.find(l => l.id === selectedLeague)?.name || "";

  return (
    <div className="app-container">
      <Header onClickLogo={() => setSelectedLeague(0)} />
      
      <div className="app-body">
        <Sidebar 
          selectedLeague={selectedLeague} 
          setSelectedLeague={setSelectedLeague} 
        />
        
        <MainFeed 
          matches={filteredMatches} 
          selectedLeagueName={selectedLeagueName}
          quota={data.quota_remaining}
          date={data.date}
        />
        
        <RightSidebar />
      </div>
    </div>
  );
}

export default App;