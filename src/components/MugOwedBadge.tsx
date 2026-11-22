import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchMugStatus, type MugStatus } from "../lib/mugStatus";
import { useSimulation } from "../lib/simulation";
import "./MugOwedBadge.css";

const REFRESH_MS = 60_000;

/**
 * Advisory reminder of funded bookies that still owe today's camouflage mug bet.
 *
 * The arb log deliberately does not block on this any more — a live arb has to be grabbed before
 * the price moves — so this nags from the shell instead of standing in front of the arb form.
 * Renders nothing once every funded bookie has had its mug bet today.
 */
const MugOwedBadge = () => {
  const { enabled: simulation } = useSimulation();
  const [status, setStatus] = useState<MugStatus | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        setStatus(await fetchMugStatus(simulation, controller.signal));
      } catch {
        if (!controller.signal.aborted) setStatus(null);
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [simulation]);

  if (!status || status.owed.length === 0) return null;

  return (
    <div className="mug-owed" role="status">
      <span className="mug-owed-label">☕ Mug tax owed</span>
      <span className="mug-owed-books">{status.owed.join(" · ")}</span>
      <span className="mug-owed-note">Arbs still log freely — place the acca when you get a gap.</span>
      <Link to="/wallets" className="mug-owed-link">
        Mug Bets →
      </Link>
    </div>
  );
};

export default MugOwedBadge;
