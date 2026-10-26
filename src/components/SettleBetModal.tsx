import { useEffect, useState } from "react";
import { formatGhs } from "../lib/wallets";
import type { ActiveBetRecord, SettleBetRequest, SettlementOutcome } from "../types";
import "./SettleBetModal.css";

interface SettleBetModalProps {
  bet: ActiveBetRecord;
  simulation: boolean;
  onClose: () => void;
  /** Rejects with the server message when the settlement cannot be applied. */
  onConfirm: (request: SettleBetRequest) => Promise<void>;
}

type VoidedLegs = "a" | "b" | "both";
type RemainingOutcome = "won" | "lost" | "cashed";

interface Credit {
  bookie: string;
  amount: number;
  kind: string;
}

interface Plan {
  request: SettleBetRequest;
  credits: Credit[];
  net: number;
}

const Choice = ({
  label,
  hint,
  onClick,
  disabled,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button type="button" className="settle-choice" onClick={onClick} disabled={disabled}>
    <span className="settle-choice-name">{label}</span>
    {hint && <span className="settle-choice-meta">{hint}</span>}
  </button>
);

/**
 * Settlement wizard: outcome (normal win / void / cash out) -> the questions that outcome
 * needs -> a preview of the wallet credits and net result before anything is written.
 */
const SettleBetModal = ({ bet, simulation, onClose, onConfirm }: SettleBetModalProps) => {
  const [outcome, setOutcome] = useState<SettlementOutcome | null>(null);
  const [winner, setWinner] = useState<"a" | "b" | null>(null);
  const [voided, setVoided] = useState<VoidedLegs | null>(null);
  const [remaining, setRemaining] = useState<RemainingOutcome | null>(null);
  const [cashOutAmount, setCashOutAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const totalStake = bet.legA.stake + bet.legB.stake;
  const legOf = (side: "a" | "b") => (side === "a" ? bet.legA : bet.legB);
  const amountValue = Number(cashOutAmount);
  const amountValid =
    cashOutAmount.trim() !== "" && Number.isFinite(amountValue) && amountValue >= 0;

  const needsAmount =
    (outcome === "cashout" && winner !== null) ||
    (outcome === "void" && voided !== null && voided !== "both" && remaining === "cashed");

  const liveLeg = voided === "a" ? bet.legB : bet.legA;

  function buildPlan(): Plan | null {
    if (outcome === "win" && winner) {
      const leg = legOf(winner);
      const payout = leg.stake * leg.odds;
      return {
        request: { simulation, outcome: "win", winner },
        credits: [{ bookie: leg.name, amount: payout, kind: "Payout" }],
        net: payout - totalStake,
      };
    }

    if (outcome === "cashout" && winner && amountValid) {
      return {
        request: { simulation, outcome: "cashout", winner, cashOutAmount: amountValue },
        credits: [{ bookie: legOf(winner).name, amount: amountValue, kind: "Cash out" }],
        net: amountValue - totalStake,
      };
    }

    if (outcome === "void" && voided === "both") {
      return {
        request: { simulation, outcome: "void", voided: "both" },
        credits: [
          { bookie: bet.legA.name, amount: bet.legA.stake, kind: "Refund" },
          { bookie: bet.legB.name, amount: bet.legB.stake, kind: "Refund" },
        ],
        net: 0,
      };
    }

    if (outcome === "void" && (voided === "a" || voided === "b")) {
      const voidedLeg = legOf(voided);
      const refund = { bookie: voidedLeg.name, amount: voidedLeg.stake, kind: "Refund" };

      if (remaining === "lost") {
        return {
          request: { simulation, outcome: "void", voided, remaining: "lost" },
          credits: [refund],
          net: voidedLeg.stake - totalStake,
        };
      }

      if (remaining === "won") {
        const payout = liveLeg.stake * liveLeg.odds;
        return {
          request: { simulation, outcome: "void", voided, remaining: "won" },
          credits: [refund, { bookie: liveLeg.name, amount: payout, kind: "Payout" }],
          net: voidedLeg.stake + payout - totalStake,
        };
      }

      if (remaining === "cashed" && amountValid) {
        return {
          request: {
            simulation,
            outcome: "void",
            voided,
            remaining: "cashed",
            cashOutAmount: amountValue,
          },
          credits: [refund, { bookie: liveLeg.name, amount: amountValue, kind: "Cash out" }],
          net: voidedLeg.stake + amountValue - totalStake,
        };
      }
    }

    return null;
  }

  const plan = buildPlan();

  const reset = () => {
    setOutcome(null);
    setWinner(null);
    setVoided(null);
    setRemaining(null);
    setCashOutAmount("");
    setError(null);
  };

  const confirm = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      await onConfirm(plan.request);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="settle-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="settle-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settle-title"
      >
        <header className="settle-header">
          <h2 id="settle-title">Settle bet</h2>
          <span className={`settle-mode ${simulation ? "sim" : "real"}`}>
            {simulation ? "Simulation" : "Real"}
          </span>
        </header>

        <p className="settle-event">{bet.eventName}</p>
        <p className="settle-outlay">Total outlay {formatGhs(totalStake)}</p>

        {!outcome && (
          <>
            <p className="settle-question">What was the outcome?</p>
            <div className="settle-choices">
              <Choice
                label="Normal Win"
                hint="Both legs settled normally"
                onClick={() => setOutcome("win")}
              />
              <Choice
                label="Void / Refund"
                hint="One or both legs were cancelled"
                onClick={() => setOutcome("void")}
              />
              <Choice
                label="Cash Out"
                hint="You cashed out a bet early"
                onClick={() => setOutcome("cashout")}
              />
            </div>
          </>
        )}

        {outcome === "win" && (
          <>
            <p className="settle-question">Which leg won?</p>
            <div className="settle-choices">
              {(["a", "b"] as const).map((side) => {
                const leg = legOf(side);
                return (
                  <Choice
                    key={side}
                    label={`${leg.name} Won`}
                    hint={`${formatGhs(leg.stake)} @ ${leg.odds.toFixed(2)} → payout ${formatGhs(
                      leg.stake * leg.odds,
                    )}`}
                    onClick={() => setWinner(side)}
                  />
                );
              })}
            </div>
          </>
        )}

        {outcome === "cashout" && (
          <>
            <p className="settle-question">Which bookie did you cash out on?</p>
            <div className="settle-choices">
              {(["a", "b"] as const).map((side) => {
                const leg = legOf(side);
                return (
                  <Choice
                    key={side}
                    label={leg.name}
                    hint={`Stake ${formatGhs(leg.stake)} @ ${leg.odds.toFixed(2)}`}
                    onClick={() => setWinner(side)}
                  />
                );
              })}
            </div>
          </>
        )}

        {outcome === "void" && (
          <>
            {!voided && (
              <>
                <p className="settle-question">Which leg was voided?</p>
                <div className="settle-choices">
                  <Choice
                    label={`Leg A · ${bet.legA.name}`}
                    hint={`Refund ${formatGhs(bet.legA.stake)}`}
                    onClick={() => setVoided("a")}
                  />
                  <Choice
                    label={`Leg B · ${bet.legB.name}`}
                    hint={`Refund ${formatGhs(bet.legB.stake)}`}
                    onClick={() => setVoided("b")}
                  />
                  <Choice
                    label="Both legs"
                    hint="Refund both stakes"
                    onClick={() => setVoided("both")}
                  />
                </div>
              </>
            )}

            {voided && voided !== "both" && !remaining && (
              <>
                <p className="settle-question">
                  What happened to the remaining live leg ({liveLeg.name})?
                </p>
                <div className="settle-choices">
                  <Choice
                    label="It Won"
                    hint={`Payout ${formatGhs(liveLeg.stake * liveLeg.odds)}`}
                    onClick={() => setRemaining("won")}
                  />
                  <Choice
                    label="It Lost"
                    hint="Stake was already deducted"
                    onClick={() => setRemaining("lost")}
                  />
                  <Choice
                    label="I Cashed Out"
                    hint="Enter the exact cash out amount"
                    onClick={() => setRemaining("cashed")}
                  />
                </div>
              </>
            )}
          </>
        )}

        {needsAmount && (
          <label className="settle-amount">
            <span>Cash Out Amount (GHS)</span>
            <input
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={cashOutAmount}
              onChange={(event) => setCashOutAmount(event.target.value)}
              autoFocus
            />
          </label>
        )}

        {plan && (
          <div className="settle-preview">
            {plan.credits.map((credit, index) => (
              <div className="settle-preview-row" key={`${credit.bookie}-${index}`}>
                <span>
                  {credit.kind} · {credit.bookie}
                </span>
                <strong>+{formatGhs(credit.amount)}</strong>
              </div>
            ))}
            <div className="settle-preview-row total">
              <span>Net profit / loss</span>
              <strong className={plan.net < 0 ? "negative" : undefined}>
                {plan.net >= 0 ? "+" : "−"}
                {formatGhs(Math.abs(plan.net))}
              </strong>
            </div>
          </div>
        )}

        {error && <p className="settle-error">{error}</p>}

        <footer className="settle-actions">
          <button
            type="button"
            className="settle-cancel"
            onClick={outcome ? reset : onClose}
            disabled={busy}
          >
            {outcome ? "Start over" : "Cancel"}
          </button>
          <button
            type="button"
            className="settle-confirm"
            onClick={() => void confirm()}
            disabled={!plan || busy}
          >
            {busy ? "Saving..." : "Confirm Settlement"}
          </button>
        </footer>
      </div>
    </div>
  );
};

export default SettleBetModal;