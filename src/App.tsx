import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { leagueName } from "../shared/leagues.js";
import ArbsTable from "./components/ArbsTable";
import Header from "./components/Header";
import MainFeed from "./components/MainFeed";
import MatchDetail from "./components/MatchDetail";
import RightSidebar from "./components/RightSidebar";
import Sidebar from "./components/Sidebar";
import SimulationBanner from "./components/SimulationBanner";
import WalletsDashboard from "./components/WalletsDashboard";
import WalletsHistory from "./components/WalletsHistory";
import { fetchSnapshot } from "./lib/api";
import { SNAPSHOT_REFRESH_INTERVAL_MS, hasMatchStartingSoon } from "./lib/schedule";
import type { SnapshotData } from "./types";

const MATCH_ROUTE = /^\/match\/(\d+)\/?$/;
const ARBS_ROUTE = /^\/arbs\/?$/;
const WALLETS_ROUTE = /^\/wallets\/?$/;
const WALLETS_HISTORY_ROUTE = /^\/wallets\/history\/?$/;

function currentMatchId(pathname: string): number | null {
  const result = MATCH_ROUTE.exec(pathname);
  return result ? Number(result[1]) : null;
}

/** Header + the simulation banner shared by every route. */
const Shell = ({ children }: { children: ReactNode }) => (
  <div className="app-container">
    <Header />
    <SimulationBanner />
    {children}
  </div>
);

function App() {
  const [data, setData] = useState<SnapshotData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 0 = Home (all leagues), otherwise an API-Football league id.
  const [selectedLeague, setSelectedLeague] = useState(0);
  // Kept in state so the upcoming filter is pure and refreshes as kickoffs pass.
  const [now, setNow] = useState(() => Date.now());
  const dataRef = useRef<SnapshotData | null>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const matchId = currentMatchId(pathname);
  const isArbs = ARBS_ROUTE.test(pathname);
  const isWallets = WALLETS_ROUTE.test(pathname);
  const isWalletsHistory = WALLETS_HISTORY_ROUTE.test(pathname);

  // On a match page (or the arbs page) there is no feed to filter, so picking a league
  // has to take the user back to the home feed first.
  const selectLeague = useCallback(
    (id: number) => {
      setSelectedLeague(id);
      if (pathname !== "/") navigate("/");
    },
    [navigate, pathname],
  );

  const applySnapshot = useCallback((snapshot: SnapshotData) => {
    dataRef.current = snapshot;
    setData(snapshot);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchSnapshot(controller.signal)
      .then((snapshot) => {
        applySnapshot(snapshot);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });

    return () => controller.abort();
  }, [applySnapshot]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Near kickoff, pull the freshest snapshot from KV (no API-Football requests involved).
  useEffect(() => {
    const timer = setInterval(() => {
      const current = dataRef.current;
      if (!current || current.status !== "success") return;
      if (!hasMatchStartingSoon(current.matches, Date.now())) return;

      fetchSnapshot()
        .then(applySnapshot)
        .catch(() => {
          // A failed refresh keeps the last good snapshot on screen.
        });
    }, SNAPSHOT_REFRESH_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [applySnapshot]);

  // The arbs page only reads /arbs.json, so it must not wait on (or break with) the
  // API-Football snapshot. The wallets page only talks to /api/wallets.
  if (isArbs) {
    return (
      <Shell>
        <div className="app-body app-body-wide">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <ArbsTable now={now} />
        </div>
      </Shell>
    );
  }

  if (isWalletsHistory) {
    return (
      <Shell>
        <div className="app-body app-body-wide">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <WalletsHistory />
        </div>
      </Shell>
    );
  }

  if (isWallets) {
    return (
      <Shell>
        <div className="app-body">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <WalletsDashboard />
        </div>
      </Shell>
    );
  }

  if (loading) return <div className="loader">Loading today's matches...</div>;
  if (error) return <div className="error">Error: {error}</div>;
  if (!data) return null;


  const filteredMatches =
    selectedLeague === 0
      ? data.matches
      : data.matches.filter((match) => match.league.id === selectedLeague);
  const focusedMatch =
    matchId !== null
      ? (data.matches.find((match) => match.fixture.id === matchId) ?? null)
      : null;

  return (
    <Shell>
      <div className="app-body">
        <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />

        {matchId !== null ? (
          <MatchDetail match={focusedMatch} date={data.date} />
        ) : (
          <MainFeed
            matches={filteredMatches}
            selectedLeagueName={
              selectedLeague === 0 ? "Today's Matches" : leagueName(selectedLeague)
            }
            date={data.date}
            now={now}
          />
        )}

        <RightSidebar matches={data.matches} date={data.date} focusMatch={focusedMatch} />
      </div>
    </Shell>
  );
}

export default App;