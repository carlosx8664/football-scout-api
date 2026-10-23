import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import "./BestArbBadge.css";

const REFRESH_MS = 5 * 60_000;

interface BestArb {
  home: string;
  away: string;
  profitPct: number;
  /** 1 = real odds; anything else means the feed was generated in boost test mode. */
  boost: number | null;
}

interface ArbsPayload {
  arbs?: unknown;
  boostApplied?: unknown;
}

function pickBest(raw: unknown): BestArb | null {
  const payload = (raw ?? {}) as ArbsPayload;
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(payload.arbs)
      ? payload.arbs
      : [];
  const boost = typeof payload.boostApplied === "number" ? payload.boostApplied : null;
  const now = Date.now();

  let best: BestArb | null = null;

  for (const entry of list) {
    const arb = entry as Record<string, unknown>;
    const profitPct = arb?.profitPct;
    if (typeof profitPct !== "number" || !Number.isFinite(profitPct)) continue;

    // Only advertise opportunities that have not started.
    const kickoff = arb?.kickoff;
    if (typeof kickoff === "number" && kickoff <= now) continue;

    if (!best || profitPct > best.profitPct) {
      best = {
        home: String(arb?.home ?? "Home"),
        away: String(arb?.away ?? "Away"),
        profitPct,
        boost,
      };
    }
  }

  return best;
}

/**
 * Persistent header reminder of the best live arbitrage, shown on every page so it is not
 * missed while browsing matches.
 */
const BestArbBadge = () => {
  const [best, setBest] = useState<BestArb | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      try {
        const response = await fetch("/arbs.json", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) return;
        setBest(pickBest(await response.json()));
      } catch {
        if (!controller.signal.aborted) console.warn("Could not read arbs.json for the header.");
      }
    };

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  if (!best) return null;

  const isTest = best.boost !== null && Math.abs(best.boost - 1) > 1e-9;

  return (
    <Link
      to="/arbs"
      className={`best-arb${isTest ? " best-arb-test" : ""}`}
      title={`Best arbitrage right now: ${best.home} vs ${best.away} (${best.profitPct.toFixed(2)}%)`}
    >
      <span className="best-arb-label">{isTest ? "Test arb" : "Best arb"}</span>
      <span className="best-arb-profit">{best.profitPct.toFixed(2)}%</span>
      <span className="best-arb-match">
        {best.home} vs {best.away}
      </span>
    </Link>
  );
};

export default BestArbBadge;
