import { useState } from "react";
import { Link } from "react-router-dom";
import type { Match } from "../types";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import { matchesForTab, type FeedTab } from "../lib/schedule";
import BookBreakdown from "./BookBreakdown";
import "./MainFeed.css";

interface MainFeedProps {
  matches: Match[];
  selectedLeagueName: string;
  date: string;
  now: number;
}

const TABS: Array<{ id: FeedTab; label: string }> = [
  { id: "today", label: "Today's Matches" },
  { id: "tomorrow", label: "Tomorrow's Matches" },
  { id: "week", label: "This Week" },
];

const PAGE_SIZE = 8;

const MainFeed = ({ matches, selectedLeagueName, date, now }: MainFeedProps) => {
  const [activeTab, setActiveTab] = useState<FeedTab>("today");
  const [page, setPage] = useState(1);

  const counts: Record<FeedTab, number> = {
    today: matchesForTab(matches, "today", now).length,
    tomorrow: matchesForTab(matches, "tomorrow", now).length,
    week: matchesForTab(matches, "week", now).length,
  };
  const visibleMatches = matchesForTab(matches, activeTab, now);

  const pageCount = Math.max(1, Math.ceil(visibleMatches.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageMatches = visibleMatches.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  return (
    <main className="main-feed">
      <div className="feed-top-header">
        <h1 className="page-title">{selectedLeagueName}</h1>
        <span className="feed-date-badge">{date}</span>
      </div>

      <div className="match-tabs" role="tablist" aria-label="Match days">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`match-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => {
              setActiveTab(tab.id);
              setPage(1);
            }}
          >
            {tab.label}
            <span className="tab-count">{counts[tab.id]}</span>
          </button>
        ))}
      </div>

      <div className="match-card-grid">
        {visibleMatches.length === 0 ? (
          <div className="empty-state">
            {activeTab === "today"
              ? "No more matches today for this league."
              : activeTab === "tomorrow"
                ? "No matches tomorrow for this league."
                : "No matches later this week for this league."}
          </div>
        ) : (
          pageMatches.map((match) => {
            const prices = matchWinnerPrices(match.odds);
            const kickoff = formatKickoff(match.fixture.date);

            return (
              <div key={match.fixture.id} className="new-match-card">
                {match.odds ? (
                  <div className="hot-badge">HOT 🔥</div>
                ) : (
                  <div className="hot-badge hot-badge-muted">Awaiting odds</div>
                )}

                <div className="card-league-date">
                  <span>{kickoff.date}</span>
                  <span>{kickoff.time}</span>
                </div>
                <div className="card-league-name">{match.league.name}</div>

                <div className="card-teams-row">
                  <div className="card-team">
                    {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
                    <span>{match.teams.home.name}</span>
                  </div>
                  <span className="card-vs">-</span>
                  <div className="card-team">
                    {match.teams.away.logo && <img src={match.teams.away.logo} alt="" />}
                    <span>{match.teams.away.name}</span>
                  </div>
                </div>

                <div className="card-prediction-box">
                  <span className="prediction-title">Match Winner Odds</span>
                  <div className="card-odds-row">
                    <div className="card-odd">
                      <span className="odd-label">1</span>
                      <span className="odd-value">{prices.home}</span>
                      <BookBreakdown price={match.book_odds?.home} />
                    </div>
                    <div className="card-odd">
                      <span className="odd-label">X</span>
                      <span className="odd-value">{prices.draw}</span>
                      <BookBreakdown price={match.book_odds?.draw} />
                    </div>
                    <div className="card-odd">
                      <span className="odd-label">2</span>
                      <span className="odd-value">{prices.away}</span>
                      <BookBreakdown price={match.book_odds?.away} />
                    </div>
                  </div>
                </div>

                <Link to={`/match/${match.fixture.id}`} className="details-btn">
                  View AI Details ➜
                </Link>
              </div>
            );
          })
        )}
      </div>

      {pageCount > 1 && (
        <nav className="match-pagination" aria-label="Match pages">
          <button
            type="button"
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 1}
          >
            ← Prev
          </button>
          <span className="page-status">
            Page {currentPage} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage === pageCount}
          >
            Next →
          </button>
        </nav>
      )}
    </main>
  );
};

export default MainFeed;
