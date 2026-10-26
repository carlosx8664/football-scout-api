import { useEffect, useState } from "react";
import { formatGhs } from "../lib/wallets";
import type { ActiveBetRecord } from "../types";
import "./SettleBetModal.css";

interface SettleBetModalProps {
  bet: ActiveBetRecord;
  simulation: boolean;
  onClose: () => void;
  /** Rejects with the server message when the settlement cannot be applied. */
  onConfirm: (winner: "a" | "b") => Promise<void>;
}

/** Asks which leg won, then hands the winner to the settle endpoint. */
const SettleBetModal = ({ bet, simulation, onClose, onConfirm }: SettleBetModalProps) => {
  const [busy, setBusy] = useState<"a" | "b" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = async (winner: "a" | "b") => {
    setBusy(winner);
    try {
      await onConfirm(winner);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
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
          <h2 id="settle-title">Which leg won?</h2>
          <span className={`settle-mode ${simulation ? "sim" : "real"}`}>
            {simulation ? "Simulation" : "Real"}
          </span>
        </header>

        <p className="settle-event">{bet.eventName}</p>

        <div className="settle-choices">
          {([["a", bet.legA], ["b", bet.legB]] as const).map(([side, leg]) => (
            <button
              key={side}
              type="button"
              className="settle-choice"
              onClick={() => void choose(side)}
              disabled={busy !== null}
            >
              <span className="settle-choice-name">{leg.name} Won</span>
              <span className="settle-choice-meta">
                {formatGhs(leg.stake)} @ {leg.odds.toFixed(2)} → payout{" "}
                {formatGhs(leg.stake * leg.odds)}
              </span>
            </button>
          ))}
        </div>

        {error && <p className="settle-error">{error}</p>}

        <footer className="settle-actions">
          <button type="button" className="settle-cancel" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
};

export default SettleBetModal;
