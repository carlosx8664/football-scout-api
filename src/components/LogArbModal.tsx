import { useEffect, useState, type FormEvent } from "react";
import { logArb } from "../lib/bets";
import { fetchWallets, formatGhs } from "../lib/wallets";
import type { ArbLeg, ArbOpportunity } from "../types";
import "./LogArbModal.css";

interface LogArbModalProps {
  arb: ArbOpportunity;
  legs: ArbLeg[];
  /** Stakes the scanner/rounding control already computed; editable here. */
  initialStakes: Array<number | null>;
  /** Current global mode — becomes `is_simulation` on the saved row. */
  simulation: boolean;
  onClose: () => void;
  onSaved: () => void;
}

const LogArbModal = ({
  arb,
  legs,
  initialStakes,
  simulation,
  onClose,
  onSaved,
}: LogArbModalProps) => {
  const [stakes, setStakes] = useState<string[]>(() =>
    legs.map((_, index) => {
      const value = initialStakes[index];
      return value === null || value === undefined ? "" : value.toFixed(2);
    }),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cash currently sitting in each bookie wallet, shown under its stake input.
  const [balances, setBalances] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    // A missing balance hint must never block logging, so failures are ignored here.
    fetchWallets(simulation, controller.signal)
      .then((walletPayload) => {
        setBalances(
          Object.fromEntries(walletPayload.wallets.map((wallet) => [wallet.name, wallet.balance])),
        );
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [simulation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const numbers = stakes.map((value) => Number(value));
  const usable = numbers.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = usable[0] + usable[1];
  // Worst case of the two payout sides, net of the full outlay — rounding can kill the edge.
  const worstPayout = Math.min(
    usable[0] * (legs[0]?.odds ?? 0),
    usable[1] * (legs[1]?.odds ?? 0),
  );
  const profit = total > 0 ? worstPayout - total : 0;
  const profitPct = total > 0 ? (profit / total) * 100 : 0;
  const valid = numbers.every((value) => Number.isFinite(value) && value > 0);

  const balanceFor = (bookie: string): number | undefined => {
    if (!balances) return undefined;
    return (
      balances[bookie] ??
      Object.entries(balances).find(([name]) => name.toLowerCase() === bookie.toLowerCase())?.[1]
    );
  };

  const overdrawnIndex = legs.findIndex((leg, index) => {
    const available = balanceFor(leg.bookmaker);
    return available !== undefined && numbers[index] > available;
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) {
      setError("Enter a stake above 0 for both legs.");
      return;
    }
    if (overdrawnIndex >= 0) {
      setError(`Stake exceeds the available balance on ${legs[overdrawnIndex].bookmaker}.`);
      return;
    }

    setSaving(true);
    try {
      await logArb({
        eventName: `${arb.home} vs ${arb.away} — ${arb.market || "arbitrage"}`,
        legs: [
          { name: legs[0].bookmaker, odds: legs[0].odds, stake: numbers[0] },
          { name: legs[1].bookmaker, odds: legs[1].odds, stake: numbers[1] },
        ],
        simulation,
        kickoff: Number.isFinite(arb.kickoff) ? arb.kickoff : undefined,
      });
      setSaving(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div
      className="log-arb-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="log-arb-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="log-arb-title"
      >
        <header className="log-arb-header">
          <h2 id="log-arb-title">Log Arb</h2>
          <span className={`log-arb-mode ${simulation ? "sim" : "real"}`}>
            {simulation ? "Simulation" : "Real"}
          </span>
        </header>

        <p className="log-arb-event">
          {arb.home} vs {arb.away}
        </p>
        <p className="log-arb-meta">
          {arb.market || "—"}
          {arb.tournament ? ` · ${arb.tournament}` : ""}
        </p>

        <form onSubmit={(event) => void submit(event)}>
          <table className="log-arb-legs">
            <thead>
              <tr>
                <th scope="col">Bookmaker</th>
                <th scope="col">Outcome</th>
                <th scope="col">Odds</th>
                <th scope="col">Stake (GHS)</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, index) => {
                const available = balanceFor(leg.bookmaker);
                const overBalance = available !== undefined && numbers[index] > available;

                return (
                  <tr key={`${leg.bookmaker}-${leg.outcome}`}>
                  <td className="log-arb-bookie">{leg.bookmaker}</td>
                  <td>{leg.outcome || "—"}</td>
                  <td className="log-arb-odds">{leg.odds.toFixed(2)}</td>
                  <td>
                    <input
                      className="log-arb-stake"
                      type="number"
                      min="0"
                      step="0.01"
                      inputMode="decimal"
                      aria-label={`${leg.bookmaker} stake`}
                      value={stakes[index]}
                      onChange={(event) => {
                        const next = [...stakes];
                        next[index] = event.target.value;
                        setStakes(next);
                      }}
                      autoFocus={index === 0}
                    />
                    {available !== undefined && (
                      <span className={`log-arb-available${overBalance ? " over" : ""}`}>
                        {overBalance ? "Exceeds balance · " : "Available "}
                        {formatGhs(available)}
                      </span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>

          <div className="log-arb-summary">
            <div>
              <span>Total stake</span>
              <strong>{formatGhs(total)}</strong>
            </div>
            <div>
              <span>Worst-case profit</span>
              <strong className={profit < 0 ? "negative" : undefined}>
                {formatGhs(profit)} ({profitPct.toFixed(2)}%)
              </strong>
            </div>
          </div>

          {profit < 0 && (
            <p className="log-arb-warn">
              These stakes lose money on one side. Adjust them before saving.
            </p>
          )}
          {error && <p className="log-arb-error">{error}</p>}

          <footer className="log-arb-actions">
            <button type="button" className="log-arb-cancel" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="log-arb-save" disabled={saving}>
              {saving ? "Saving…" : "Save to Ledger"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

export default LogArbModal;
