import { useCallback, useEffect, useState } from "react";
import {
  createMugBet,
  fetchMugBets,
  settleMugBet,
  type MugBetInput,
} from "../lib/mugBets";
import { formatGhs } from "../lib/wallets";
import type { MugBetsPayload, Wallet, WalletsPayload } from "../types";
import "./MugBetsPanel.css";

interface MugBetsPanelProps {
  simulation: boolean;
  /** Bumped after any ledger write so the list refetches. */
  refreshToken: number;
  wallets: Wallet[];
  onChanged: (payload: WalletsPayload) => void;
}

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

/**
 * Mug-bet tracker: small singles on real matches, logged so the accounts keep looking human.
 * The stake is debited when logged; a win credits `stake × odds` back, a loss does nothing.
 */
const MugBetsPanel = ({ simulation, refreshToken, wallets, onChanged }: MugBetsPanelProps) => {
  const [result, setResult] = useState<{ key: string; payload: MugBetsPayload } | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({
    bookie: "",
    eventName: "",
    stake: "50",
    odds: "1.30",
  });

  const key = simulation ? "sim" : "real";

  useEffect(() => {
    const controller = new AbortController();

    fetchMugBets(simulation, controller.signal)
      .then((next) => {
        setResult({ key, payload: next });
        setProblem(null);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setProblem({ key, message: err.message });
      });

    return () => controller.abort();
  }, [simulation, refreshToken, key]);

  // Default to the first wallet until the user picks one; derived, so no state-sync effect.
  const selectedBookie = form.bookie || wallets[0]?.name || "";

  const payload = result?.key === key ? result.payload : null;
  const error = problem?.key === key ? problem.message : null;
  const bets = payload?.mugBets ?? [];
  const totals = payload?.totals ?? null;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusyId("new");
      try {
        const input: MugBetInput = {
          bookie: selectedBookie,
          eventName: form.eventName.trim(),
          stake: Number(form.stake),
          odds: Number(form.odds),
        };
        const next = await createMugBet(input, simulation);
        onChanged(next);
        setForm((current) => ({ ...current, eventName: "" }));
        setProblem(null);
      } catch (err) {
        setProblem({ key, message: (err as Error).message });
      } finally {
        setBusyId(null);
      }
    },
    [form, key, onChanged, selectedBookie, simulation],
  );

  const settle = useCallback(
    async (id: string, won: boolean) => {
      setBusyId(id);
      try {
        const next = await settleMugBet(id, won, simulation);
        onChanged(next);
        setProblem(null);
      } catch (err) {
        setProblem({ key, message: (err as Error).message });
      } finally {
        setBusyId(null);
      }
    },
    [key, onChanged, simulation],
  );

  return (
    <section className="mugbets-panel">
      <header className="mugbets-header">
        <div>
          <h2>Mug Bets</h2>
          <p className="mugbets-subtitle">
            Small singles that keep the {simulation ? "simulation" : "real"} accounts looking human.
          </p>
        </div>
        <span className="mugbets-count">
          {totals?.open ?? 0} open
        </span>
      </header>

      <p className="mugbets-tip">
        <strong>Protect your account:</strong> Place a 50 GHS single bet on Barcelona to win (Odds
        &gt; 1.20) every weekend.
      </p>

      {error && <p className="mugbets-error">{error}</p>}

      <form className="mugbets-form" onSubmit={submit}>
        <label>
          <span>Bookie</span>
          <select
            value={selectedBookie}
            onChange={(event) => setForm((c) => ({ ...c, bookie: event.target.value }))}
            required
          >
            {wallets.length === 0 && <option value="">No wallets</option>}
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.name}>
                {wallet.name}
              </option>
            ))}
          </select>
        </label>

        <label className="grow">
          <span>Match</span>
          <input
            type="text"
            placeholder="Barcelona to win"
            value={form.eventName}
            onChange={(event) => setForm((c) => ({ ...c, eventName: event.target.value }))}
            required
          />
        </label>

        <label>
          <span>Stake</span>
          <input
            type="number"
            min="1"
            step="1"
            inputMode="decimal"
            value={form.stake}
            onChange={(event) => setForm((c) => ({ ...c, stake: event.target.value }))}
            required
          />
        </label>

        <label>
          <span>Odds</span>
          <input
            type="number"
            min="1.01"
            step="0.01"
            inputMode="decimal"
            value={form.odds}
            onChange={(event) => setForm((c) => ({ ...c, odds: event.target.value }))}
            required
          />
        </label>

        <button type="submit" className="mugbets-add" disabled={busyId === "new"}>
          {busyId === "new" ? "Saving…" : "Log mug bet"}
        </button>
      </form>

      {totals && totals.count > 0 && (
        <div className="mugbets-totals">
          <span>
            Staked <strong>{formatGhs(totals.staked)}</strong>
          </span>
          <span>
            Returned <strong>{formatGhs(totals.returned)}</strong>
          </span>
          <span className={totals.net > 0 ? "cost" : ""}>
            Net cost <strong>{formatGhs(totals.net)}</strong>
          </span>
        </div>
      )}

      {bets.length === 0 ? (
        <p className="mugbets-empty">
          No mug bets logged yet. A 50 GHS single a week is enough to keep an account active.
        </p>
      ) : (
        <ul className="mugbets-list">
          {bets.map((bet) => (
            <li className={`mugbets-row ${bet.status}`} key={bet.id}>
              <span className="mugbets-bookie">{bet.bookie}</span>
              <span className="mugbets-event">{bet.eventName}</span>
              <span className="mugbets-stake">
                {formatGhs(bet.stake)} @ {bet.odds.toFixed(2)}
              </span>

              {bet.status === "open" ? (
                <span className="mugbets-actions">
                  <button
                    type="button"
                    className="mugbets-won"
                    onClick={() => void settle(bet.id, true)}
                    disabled={busyId === bet.id}
                  >
                    Won
                  </button>
                  <button
                    type="button"
                    className="mugbets-lost"
                    onClick={() => void settle(bet.id, false)}
                    disabled={busyId === bet.id}
                  >
                    Lost
                  </button>
                </span>
              ) : (
                <span className={`mugbets-status ${bet.status}`}>
                  {bet.status === "won"
                    ? `Won ${formatGhs(bet.payout)}`
                    : `Lost ${formatGhs(bet.stake)}`}
                  <span className="mugbets-when">{when(bet.settledAt ?? bet.createdAt)}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default MugBetsPanel;
