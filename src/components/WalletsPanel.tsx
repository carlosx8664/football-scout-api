import { useState } from "react";
import { formatGhs, resetSimulationWallets, updateWalletBalance } from "../lib/wallets";
import type { WalletsPayload } from "../types";
import "./WalletsPanel.css";

/** Four simulation wallets at 250 GHS each. */
const SIMULATION_RESET_TOTAL = 1_000;

interface EditState {
  id: string;
  value: string;
}

/**
 * "My Wallets" section: balances from D1, click-to-edit deposits/withdrawals, the available
 * liquidity summary, and the simulation reset button. The dashboard owns the fetch so the page
 * only calls GET /api/wallets once; writes report the fresh payload back up.
 */
interface WalletsPanelProps {
  payload: WalletsPayload | null;
  error: string | null;
  loading: boolean;
  simulation: boolean;
  /** Fresh payload after a PATCH/reset, already tagged with its own mode. */
  onPayload: (payload: WalletsPayload) => void;
  onError: (message: string | null, simulation: boolean) => void;
}

const WalletsPanel = ({
  payload,
  error,
  loading,
  simulation,
  onPayload,
  onError,
}: WalletsPanelProps) => {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const save = async (walletId: string, rawValue: string) => {
    const balance = Number(rawValue);
    if (!Number.isFinite(balance) || balance < 0) {
      onError("Enter a balance of 0 or more.", simulation);
      return;
    }

    setSavingId(walletId);
    try {
      const next = await updateWalletBalance(walletId, balance, simulation);
      onPayload(next);
      onError(null, simulation);
      setEdit(null);
    } catch (err) {
      onError((err as Error).message, simulation);
    } finally {
      setSavingId(null);
    }
  };

  const reset = async () => {
    const confirmed = window.confirm(
      `Reset the 4 simulation wallets to ${SIMULATION_RESET_TOTAL.toLocaleString("en-GH")} GHS ` +
        "(250 GHS each)?",
    );
    if (!confirmed) return;

    setResetting(true);
    try {
      const next = await resetSimulationWallets();
      onPayload(next);
      onError(null, true);
      setEdit(null);
    } catch (err) {
      onError((err as Error).message, true);
    } finally {
      setResetting(false);
    }
  };

  const wallets = payload?.wallets ?? [];
  const liquidity = payload?.liquidity ?? null;
  return (
    <section className="wallets-panel">
      <header className="wallets-header">
        <div>
          <h2>My Wallets</h2>
          <p className="wallets-subtitle">
            {simulation
              ? "Simulated bookmaker balances — click a balance to log a deposit or withdrawal."
              : "Real bookmaker balances — click a balance to log a deposit or withdrawal."}
          </p>
        </div>
        <span className={`wallets-mode ${simulation ? "sim" : "real"}`}>
          {simulation ? "Simulation" : "Real"}
        </span>
      </header>

      {error && <p className="wallets-error">{error}</p>}

      {liquidity && (
        <div className="wallets-liquidity">
          <div className="liquidity-stat" title="Cash in the wallets plus stakes already committed">
            <span>Portfolio value</span>
            <strong>{formatGhs(liquidity.totalBalance + liquidity.staked)}</strong>
          </div>
          <div className="liquidity-stat" title="Deducted from the wallets when the bet was logged">
            <span>Staked (already debited)</span>
            <strong>{formatGhs(liquidity.staked)}</strong>
          </div>
          <div className="liquidity-stat available" title="Cash you can deploy right now">
            <span>Available Liquidity</span>
            <strong>{formatGhs(liquidity.available)}</strong>
          </div>
          <div
            className={`liquidity-stat profit${
              (payload?.totalProfit ?? 0) < 0 ? " negative" : ""
            }`}
          >
            <span>Total Profit</span>
            <strong>{formatGhs(payload?.totalProfit ?? 0)}</strong>
          </div>
        </div>
      )}

      {loading ? (
        <p className="wallets-empty">Loading wallets…</p>
      ) : !payload ? null : wallets.length === 0 ? (
        <p className="wallets-empty">
          No {simulation ? "simulation" : "real"} wallets found. Apply the D1 migration
          (`npx wrangler d1 migrations apply DB --local`) to seed all four.
        </p>
      ) : (
        <ul className="wallets-list">
          {wallets.map((wallet) => (
            <li className="wallet-row" key={wallet.id}>
              <div className="wallet-identity">
                <span className="wallet-name">{wallet.name}</span>
                <span className="wallet-bookie">{wallet.bookmaker}</span>
              </div>

              {edit?.id === wallet.id ? (
                <form
                  className="wallet-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void save(wallet.id, edit.value);
                  }}
                >
                  <input
                    className="wallet-input"
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    aria-label={`${wallet.name} balance`}
                    value={edit.value}
                    onChange={(event) => setEdit({ id: wallet.id, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEdit(null);
                    }}
                    autoFocus
                  />
                  <button
                    className="wallet-save"
                    type="submit"
                    disabled={savingId === wallet.id}
                  >
                    {savingId === wallet.id ? "Saving…" : "Save"}
                  </button>
                  <button className="wallet-cancel" type="button" onClick={() => setEdit(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  className="wallet-balance"
                  type="button"
                  title="Click to log a deposit or withdrawal"
                  onClick={() => {
                    onError(null, simulation);
                    setEdit({ id: wallet.id, value: wallet.balance.toFixed(2) });
                  }}
                >
                  {formatGhs(wallet.balance)}
                  <span className="wallet-edit-hint">edit</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {simulation && (
        <button
          className="wallets-reset"
          type="button"
          onClick={() => void reset()}
          disabled={resetting}
        >
          {resetting
            ? "Resetting…"
            : `Reset Simulation Wallets to ${SIMULATION_RESET_TOTAL.toLocaleString("en-GH")} GHS`}
        </button>
      )}
    </section>
  );
};

export default WalletsPanel;
