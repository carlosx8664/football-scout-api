import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Match } from "../types";
import { formatKickoff, matchWinnerPrices } from "../lib/format";
import { indexLiveMatches, liveLabel, scoreParts, useLiveScores } from "../lib/liveScores";
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
  { id: "live", label: "Live Matches" },
  { id: "today", label: "Today's Matches" },
  { id: "tomorrow", label: "Tomorrow's Matches" },
];

const PAGE_SIZE = 8;

const MainFeed = ({ matches, selectedLeagueName, date, now }: MainFeedProps) => {
  const [activeTab, setActiveTab] = useState<FeedTab>("today");
  const [page, setPage] = useState(1);

  const { payload: liveScores } = useLiveScores();
  const liveById = useMemo(() => indexLiveMatches(liveScores), [liveScores]);
  const liveEventIds = useMemo(() => new Set(liveById.keys()), [liveById]);

  const counts: Record<FeedTab, number> = {
    live: matchesForTab(matches, "live", now, liveEventIds).length,
    today: matchesForTab(matches, "today", now, liveEventIds).length,
    tomorrow: matchesForTab(matches, "tomorrow", now, liveEventIds).length,
  };
  // Live is only offered while something is actually in play.
  const tabs = TABS.filter((tab) => tab.id !== "live" || counts.live > 0);
  const currentTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : "today";
  const visibleMatches = matchesForTab(matches, currentTab, now, liveEventIds);

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
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={currentTab === tab.id}
            className={`match-tab${currentTab === tab.id ? " active" : ""}`}
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
            {currentTab === "live"
              ? "No live matches right now for this league."
              : currentTab === "today"
                ? "No more matches today for this league."
                : "No matches tomorrow for this league."}
          </div>
        ) : (
          pageMatches.map((match) => {
            const prices = matchWinnerPrices(match.odds);
            const kickoff = formatKickoff(match.fixture.date);
            // A live entry replaces the kickoff time with the clock and the "-" with the score.
            const live = match.sr_id ? liveById.get(match.sr_id) : undefined;
            const clock = live
              ? liveLabel(live, { now, serverNow: liveScores?.serverNow ?? 0 })
              : "";
            const score = live ? scoreParts(live.score) : null;

            return (
              <div key={match.fixture.id} className="new-match-card">
                {!match.odds && <div className="hot-badge hot-badge-muted">Awaiting odds</div>}

                <div className={`card-league-date${clock ? " is-live" : ""}`}>
                  <span>{kickoff.date}</span>
                  <span>{clock || kickoff.time}</span>
                </div>
                <div className="card-league-name">{match.league.name}</div>

                <div className="card-teams-row">
                  <div className="card-team">
                    {match.teams.home.logo && <img src={match.teams.home.logo} alt="" />}
                    <span>{match.teams.home.name}</span>
                  </div>
                  {score ? (
                    <span className="card-live-score">
                      {score.home} - {score.away}
                    </span>
                  ) : (
                    <span className="card-vs">-</span>
                  )}
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
