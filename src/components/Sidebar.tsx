import React from 'react';

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

interface SidebarProps {
  selectedLeague: number;
  setSelectedLeague: (id: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({ selectedLeague, setSelectedLeague }) => {
  return (
    <aside className="left-sidebar">
      <div className="sidebar-section">
        
        {/* New Top Matches Button */}
        <div style={{ marginBottom: '24px' }}>
          <button 
            className={`league-link ${selectedLeague === 0 ? 'active' : ''}`}
            onClick={() => setSelectedLeague(0)}
            style={{ fontWeight: 700 }}
          >
            <span>🏠 Top Matches Today</span>
          </button>
        </div>

        <h3>Popular Leagues</h3>
        <ul className="league-nav">
          {LEAGUES.map((league) => (
            <li key={league.id}>
              <button 
                className={`league-link ${selectedLeague === league.id ? 'active' : ''}`}
                onClick={() => setSelectedLeague(league.id)}
              >
                <img src={league.logo} alt={league.name} />
                <span>{league.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      
      <div className="newsletter-box">
        <h4>📧 My Best Bets in your Inbox</h4>
        <p>Free newsletter sent weekly to 100,000+ subscribers.</p>
        <input type="email" placeholder="Enter your email" />
        <button>Join the mailing list</button>
      </div>
    </aside>
  );
};

export default Sidebar;