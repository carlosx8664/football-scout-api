import { LEAGUES } from "../../shared/leagues.js";
import "./Sidebar.css";

interface SidebarProps {
  selectedLeague: number;
  setSelectedLeague: (id: number) => void;
}

const Sidebar = ({ selectedLeague, setSelectedLeague }: SidebarProps) => {
  return (
    <aside className="left-sidebar">
      <div className="sidebar-section">
        <div className="top-matches">
          <button
            className={`league-link ${selectedLeague === 0 ? "active" : ""}`}
            onClick={() => setSelectedLeague(0)}
            style={{ fontWeight: 700 }}
          >
            <span>Top Matches Today</span>
          </button>
        </div>

        <h3>Popular Leagues</h3>
        <ul className="league-nav">
          {LEAGUES.map((league) => (
            <li key={league.id}>
              <button
                className={`league-link ${selectedLeague === league.id ? "active" : ""}`}
                onClick={() => setSelectedLeague(league.id)}
              >
                <img src={league.logo} alt="" />
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
