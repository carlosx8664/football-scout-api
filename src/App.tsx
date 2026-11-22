import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import ArbsTable from "./components/ArbsTable";
import Header from "./components/Header";
import LoadingOverlay from "./components/LoadingOverlay";
import MainFeed from "./components/MainFeed";
import RightSidebar from "./components/RightSidebar";
import Sidebar from "./components/Sidebar";
import SimulationBanner from "./components/SimulationBanner";
import WalletsDashboard from "./components/WalletsDashboard";
import WalletsHistory from "./components/WalletsHistory";
import { fetchSnapshot } from "./lib/api";
import { SNAPSHOT_REFRESH_INTERVAL_MS } from "./lib/schedule";
import type { Match, SnapshotData } from "./types";

const ARBS_ROUTE = /^\/arbs\/?$/;
const WALLETS_ROUTE = /^\/wallets\/?$/;
const WALLETS_HISTORY_ROUTE = /^\/wallets\/history\/?$/;

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
  // Fixture expanded in the feed; drives the league table in the right rail.
  const [selectedMatch, setSelectedMatch] = useState<Match | null>(null);
  const dataRef = useRef<SnapshotData | null>(null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const isArbs = ARBS_ROUTE.test(pathname);
  const isWallets = WALLETS_ROUTE.test(pathname);
  const isWalletsHistory = WALLETS_HISTORY_ROUTE.test(pathname);

  // On the arbs or wallets pages there is no feed to filter, so picking a league
  // has to take the user back to the home feed first.
  const selectLeague = useCallback(
    (id: number) => {
      setSelectedLeague(id);
      setSelectedMatch(null);
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

  // Keep the feed fresh without a manual reload: poll on the backend's 15-minute cadence and
  // pull again whenever the tab becomes visible, regains focus, or comes back online.
  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      if (cancelled || document.visibilityState === "hidden" || !dataRef.current) return;
      fetchSnapshot()
        .then((snapshot) => {
          if (!cancelled) applySnapshot(snapshot);
        })
        .catch(() => {
          // A failed refresh keeps the last good snapshot on screen.
        });
    };

    const timer = setInterval(refresh, SNAPSHOT_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [applySnapshot]);

  // The arbs page only reads /arbs.json, so it must not wait on (or break with) the
  // API-Football snapshot. The wallets page only talks to /api/wallets.
  const filteredMatches =
    !data || selectedLeague === 0
      ? (data?.matches ?? [])
      : data.matches.filter((match) => match.league.id === selectedLeague);

  let content: ReactNode;

  if (isArbs) {
    content = (
      <Shell>
        <div className="app-body app-body-wide">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <ArbsTable now={now} />
        </div>
      </Shell>
    );
  } else if (isWalletsHistory) {
    content = (
      <Shell>
        <div className="app-body app-body-wide">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <WalletsHistory />
        </div>
      </Shell>
    );
  } else if (isWallets) {
    content = (
      <Shell>
        <div className="app-body">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />
          <WalletsDashboard />
        </div>
      </Shell>
    );
  } else if (loading) {
    content = <div className="loader">Loading matches...</div>;
  } else if (error) {
    content = <div className="error">Error: {error}</div>;
  } else if (data) {
    content = (
      <Shell>
        <div className="app-body app-body-home">
          <Sidebar selectedLeague={selectedLeague} setSelectedLeague={selectLeague} />

          <MainFeed
            matches={filteredMatches}
            date={data.date}
            now={now}
            onSelectMatch={setSelectedMatch}
          />

          <RightSidebar matches={data.matches} date={data.date} selectedMatch={selectedMatch} />
        </div>
      </Shell>
    );
  } else {
    content = null;
  }

  return (
    <>
      <LoadingOverlay message="Loading matches…" visible={loading} />
      {content}
    </>
  );
}

export default App;