import { useEffect, useState } from "react";
import { leagueName } from "../shared/leagues.js";
import Header from "./components/Header";
import MainFeed from "./components/MainFeed";
import MatchDetail from "./components/MatchDetail";
import RightSidebar from "./components/RightSidebar";
import Sidebar from "./components/Sidebar";
import { fetchSnapshot } from "./lib/api";
import type { SnapshotData } from "./types";

const MATCH_ROUTE = /^\/match\/(\d+)\/?$/;

function currentMatchId(): number | null {
  const result = MATCH_ROUTE.exec(window.location.pathname);
  return result ? Number(result[1]) : null;
}

function App() {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 0 = Home (all leagues), otherwise an API-Football league id.
  const [selectedLeague, setSelectedLeague] = useState(0);
  const matchId = currentMatchId();

  useEffect(() => {
    const controller = new AbortController();

    fetchSnapshot(controller.signal)
      .then((snapshot) => {
        setData(snapshot);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, []);

  if (loading) return <div className="loader">Loading today's matches...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;

  if (data.status === "pending") {
    return (
      <div className="app-container">
        <Header />
        <div className="notice" role="status">
          <h1>Today's slate is still syncing</h1>
          <p>{data.message}</p>
        </div>
      </div>
    );
  }

  if (matchId !== null) {
    return (
      <div className="app-container">
        <Header />
        {data.stale && (
          <div className="stale-banner" role="status">
            {data.message}
          </div>
        )}
        <MatchDetail
          match={data.matches.find((match) => match.fixture.id === matchId) ?? null}
          date={data.date}
        />
      </div>
    );
  }

  const filteredMatches =
    selectedLeague === 0
      ? data.matches
      : data.matches.filter((match) => match.league.id === selectedLeague);

  return (
    <div className="app-container">
      <Header />

      {data.stale && (
        <div className="stale-banner" role="status">
          {data.message}
        </div>
      )}

      <div className="app-body">
        <Sidebar selectedLeague={selectedLeague} setSelectedLeague={setSelectedLeague} />

        <MainFeed
          matches={filteredMatches}
          selectedLeagueName={
            selectedLeague === 0 ? "Top Matches of the Day" : leagueName(selectedLeague)
          }
          quota={data.quota_remaining ?? "unknown"}
          date={data.date}
        />

        <RightSidebar />
      </div>
    </div>
  );
}

export default App;
