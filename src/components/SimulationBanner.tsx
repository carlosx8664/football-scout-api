import { useSimulation } from "../lib/simulation";
import "./Simulation.css";

/** Yellow strip shown across the top of the dashboard while simulation mode is active. */
const SimulationBanner = () => {
  const { enabled } = useSimulation();
  if (!enabled) return null;

  return (
    <div className="simulation-banner" role="status">
      <strong>🧪 SIMULATION MODE ACTIVE</strong>
      <span className="simulation-banner-hint">
        Wallets and bets are simulated — no real money is at stake.
      </span>
    </div>
  );
};

export default SimulationBanner;
