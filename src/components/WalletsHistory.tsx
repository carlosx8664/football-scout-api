import { Link } from "react-router-dom";
import { useSimulation } from "../lib/simulation";
import HistoryLedger from "./HistoryLedger";
import "./WalletsHistory.css";

/**
 * Settled history as its own wallets sub-page: full width, no right sidebar, so the ledger gets
 * the whole centre column instead of sharing it with Active Bets and Cash Flow.
 */
const WalletsHistory = () => {
  const { enabled } = useSimulation();

  return (
    <div className="wallets-history-page">
      <header className="wallets-history-header">
        <div>
          <h1>History</h1>
          <p>
            Settled arbs in the {enabled ? "simulation" : "real"} ledger, grouped by day.
          </p>
        </div>
        <Link className="wallets-history-back" to="/wallets">
          Back to Wallets
        </Link>
      </header>
      <HistoryLedger simulation={enabled} refreshToken={0} />
    </div>
  );
};

export default WalletsHistory;
