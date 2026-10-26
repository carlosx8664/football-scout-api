import { useSimulation } from "../lib/simulation";
import "./Simulation.css";

/** Global switch: every wallet query is filtered by the matching `is_simulation` value. */
const SimulationToggle = () => {
  const { enabled, toggle } = useSimulation();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`simulation-toggle ${enabled ? "on" : "off"}`}
      onClick={toggle}
      title={
        enabled
          ? "Simulation mode is on — switch to real wallets"
          : "Real mode — switch to simulated wallets"
      }
    >
      <span className="simulation-toggle-track" aria-hidden="true">
        <span className="simulation-toggle-thumb" />
      </span>
      <span className="simulation-toggle-label">Simulation</span>
    </button>
  );
};

export default SimulationToggle;
