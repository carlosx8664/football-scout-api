import { useEffect, useState } from "react";
import { formatGhs } from "../lib/wallets";
import "./ArbCalculator.css";

const BOOKMAKERS = ["BoltBet", "SportyBet", "MSport", "BetBoro"];
const ROUNDING_STEPS = [5, 10, 20, 50, 100];

type LegIndex = 0 | 1;
/** Which input drives the calculation: the total stake, or a manually typed leg stake. */
type StakeSource = "total" | "a" | "b";

interface LegDraft {
  bookmaker: string;
  market: string;
  odds: string;
  stake: string;
}

interface ArbCalculatorProps {
  onClose: () => void;
}

const blankLeg = (bookmaker: string): LegDraft => ({
  bookmaker,
  market: "",
  odds: "",
  stake: "",
});

const toNumber = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** Keeps generated stakes readable (285, 285.67) instead of float noise. */
const toInput = (value: number): string => (Number.isFinite(value) ? String(Number(value.toFixed(2))) : "");

const roundTo = (value: number, step: number): number =>
  step > 0 ? Math.max(step, Math.round(value / step) * step) : value;

/** Splits a total so both legs return the same amount: stakeA * oddsA == stakeB * oddsB. */
function splitStake(total: number, oddsA: number, oddsB: number) {
  const shareA = 1 / oddsA;
  const shareB = 1 / oddsB;
  const stakeA = (total * shareA) / (shareA + shareB);
  return { stakeA, stakeB: total - stakeA };
}

const signed = (value: number, digits = 2) => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;

const ArbCalculator = ({ onClose }: ArbCalculatorProps) => {
  const [legs, setLegs] = useState<[LegDraft, LegDraft]>([
    blankLeg(BOOKMAKERS[0]),
    blankLeg(BOOKMAKERS[1]),
  ]);
  const [totalStake, setTotalStake] = useState("");
  const [rounding, setRounding] = useState(0);
  const [source, setSource] = useState<StakeSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const oddsA = toNumber(legs[0].odds);
  const oddsB = toNumber(legs[1].odds);
  const validOddsA = oddsA !== null && oddsA > 1;
  const validOddsB = oddsB !== null && oddsB > 1;

  const stakeA = toNumber(legs[0].stake) ?? 0;
  const stakeB = toNumber(legs[1].stake) ?? 0;
  const total = stakeA + stakeB;

  const payoutA = validOddsA && stakeA > 0 ? stakeA * (oddsA as number) : null;
  const payoutB = validOddsB && stakeB > 0 ? stakeB * (oddsB as number) : null;
  const profitA = payoutA !== null && total > 0 ? payoutA - total : null;
  const profitB = payoutB !== null && total > 0 ? payoutB - total : null;
  const guaranteed = profitA !== null && profitB !== null ? Math.min(profitA, profitB) : null;
  const roi = guaranteed !== null && total > 0 ? (guaranteed / total) * 100 : null;

  const applyBalanced = (next: [LegDraft, LegDraft], mode: StakeSource, step = rounding) => {
    const a = toNumber(next[0].odds);
    const b = toNumber(next[1].odds);
    if (a === null || b === null || a <= 1 || b <= 1) {
      setLegs(next);
      setError("Enter odds greater than 1.00 for both legs.");
      return;
    }

    if (mode === "total") {
      const requested = toNumber(totalStake);
      if (requested === null || requested <= 0) {
        setLegs(next);
        setError("Enter a total stake above 0.");
        return;
      }
      const { stakeA: rawA, stakeB: rawB } = splitStake(requested, a, b);
      setLegs([
        { ...next[0], stake: toInput(roundTo(rawA, step)) },
        { ...next[1], stake: toInput(roundTo(rawB, step)) },
      ]);
      setError(null);
      return;
    }

    const index: LegIndex = mode === "a" ? 0 : 1;
    const other: LegIndex = index === 0 ? 1 : 0;
    const typed = toNumber(next[index].stake);
    if (typed === null || typed <= 0) {
      setLegs(next);
      setError(`Enter a stake for Leg ${index === 0 ? "A" : "B"}.`);
      return;
    }

    // Equal profit on the other side needs stake * odds to match, so scale by the odds ratio.
    const rawOther = index === 0 ? (typed * a) / b : (typed * b) / a;
    const updated: [LegDraft, LegDraft] = [{ ...next[0] }, { ...next[1] }];
    updated[other] = { ...updated[other], stake: toInput(roundTo(rawOther, step)) };
    setLegs(updated);
    setError(null);
  };

  const updateLeg = (index: LegIndex, patch: Partial<LegDraft>) => {
    const next: [LegDraft, LegDraft] = [
      { ...legs[0], ...(index === 0 ? patch : {}) },
      { ...legs[1], ...(index === 1 ? patch : {}) },
    ];

    if (patch.stake !== undefined) {
      const mode: StakeSource = index === 0 ? "a" : "b";
      setSource(mode);
      applyBalanced(next, mode);
      return;
    }

    if (patch.odds !== undefined && source !== null) {
      // Odds changed under an existing split, so re-derive the other side.
      applyBalanced(next, source);
      return;
    }

    setLegs(next);
  };

  const updateRounding = (step: number) => {
    setRounding(step);
    if (source !== null) applyBalanced(legs, source, step);
  };

  const calculate = () => {
    const requested = toNumber(totalStake);
    if (requested !== null && requested > 0) {
      setSource("total");
      applyBalanced(legs, "total");
      return;
    }
    if (stakeA > 0) {
      setSource("a");
      applyBalanced(legs, "a");
      return;
    }
    if (stakeB > 0) {
      setSource("b");
      applyBalanced(legs, "b");
      return;
    }
    setError("Enter a total stake, or a stake for one leg.");
  };

  const profitClass = (value: number | null) =>
    value === null ? "" : value < 0 ? "negative" : value > 0 ? "positive" : "";

  return (
    <div
      className="calc-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="calc-modal" role="dialog" aria-modal="true" aria-labelledby="calc-title">
        <header className="calc-header">
          <div>
            <h2 id="calc-title">Real-time Arb Calculator</h2>
            <p className="calc-subtitle">
              Equal-profit staking for any two bookmakers — no arb required.
            </p>
          </div>
          <button type="button" className="calc-close" onClick={onClose} aria-label="Close calculator">
            ×
          </button>
        </header>

        <div className="calc-controls">
          <label className="calc-field calc-field-total">
            <span>Total Stake (GHS)</span>
            <input
              type="number"
              min="0"
              step="10"
              inputMode="decimal"
              placeholder="1000"
              value={totalStake}
              onChange={(event) => {
                setTotalStake(event.target.value);
                setSource("total");
              }}
            />
          </label>

          <label className="calc-field">
            <span>Round to nearest</span>
            <select value={rounding} onChange={(event) => updateRounding(Number(event.target.value))}>
              <option value={0}>None</option>
              {ROUNDING_STEPS.map((step) => (
                <option key={step} value={step}>
                  {step}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="calc-legs">
          {legs.map((leg, index) => {
            const label = index === 0 ? "A" : "B";
            return (
              <fieldset className="calc-leg" key={label}>
                <legend>Leg {label}</legend>

                <label className="calc-field">
                  <span>Bookmaker</span>
                  <select
                    value={leg.bookmaker}
                    onChange={(event) =>
                      updateLeg(index as LegIndex, { bookmaker: event.target.value })
                    }
                  >
                    {BOOKMAKERS.map((bookmaker) => (
                      <option key={bookmaker} value={bookmaker}>
                        {bookmaker}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="calc-field">
                  <span>Market</span>
                  <input
                    type="text"
                    placeholder="e.g. Over 27.5 Shots"
                    value={leg.market}
                    onChange={(event) =>
                      updateLeg(index as LegIndex, { market: event.target.value })
                    }
                  />
                </label>

                <label className="calc-field">
                  <span>Odds</span>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="2.05"
                    value={leg.odds}
                    onChange={(event) => updateLeg(index as LegIndex, { odds: event.target.value })}
                  />
                </label>

                <label className="calc-field">
                  <span>Stake (GHS)</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="—"
                    value={leg.stake}
                    onChange={(event) => updateLeg(index as LegIndex, { stake: event.target.value })}
                  />
                </label>
              </fieldset>
            );
          })}
        </div>

        <div className="calc-actions">
          <button type="button" className="calc-calculate" onClick={calculate}>
            Calculate
          </button>
          {error && <p className="calc-error">{error}</p>}
        </div>

        <div className="calc-results">
          <div className="calc-result">
            <span>Profit if Leg A wins</span>
            <strong className={profitClass(profitA)}>
              {profitA === null ? "—" : formatGhs(profitA)}
            </strong>
          </div>
          <div className="calc-result">
            <span>Profit if Leg B wins</span>
            <strong className={profitClass(profitB)}>
              {profitB === null ? "—" : formatGhs(profitB)}
            </strong>
          </div>
          <div className="calc-result">
            <span>Total stake</span>
            <strong>{total > 0 ? formatGhs(total) : "—"}</strong>
          </div>
          <div className="calc-result calc-result-total">
            <span>Total profit (worst case)</span>
            <strong className={profitClass(guaranteed)}>
              {guaranteed === null ? "—" : formatGhs(guaranteed)}
            </strong>
            <small className={profitClass(roi)}>{roi === null ? "—" : `${signed(roi)}% ROI`}</small>
          </div>
        </div>

        {guaranteed !== null && guaranteed < 0 && (
          <p className="calc-warning">
            Negative profit: these odds do not cover both outcomes. Adjust the stakes or odds.
          </p>
        )}
      </div>
    </div>
  );
};

export default ArbCalculator;
