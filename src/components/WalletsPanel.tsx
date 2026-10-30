import { useState } from "react";
import { MIN_BOOKIES, computePlan, hasSplit, selectedBookies, useBankroll } from "../lib/bankroll";
import { formatAmount } from "../lib/wallets";
import type { Wallet, WalletsPayload } from "../types";
import "./WalletsPanel.css";

/**
 * "My Wallets" section: the planned split per selected bookie, the bookie selection and the
 * liquidity summary. Money moves through Top up / Withdraw, which update the bookie balance, the
 * Momo reserve and the Cash Flow ledger. The dashboard owns the fetch so the page only calls
 * GET /api/wallets once; writes report the fresh payload back up.
 */
interface WalletsPanelProps {
  payload: WalletsPayload | null;
  error: string | null;
  loading: boolean;
  simulation: boolean;
  /** Momo cash reserve: what a top-up spends and a withdrawal adds to. */
  momo: number;
  /** Logs a deposit/withdrawal against the Momo reserve; rejects with the API message. */
  onTransfer: (walletId: string, kind: "deposit" | "withdrawal", amount: number) => Promise<void>;
  onError: (message: string | null, simulation: boolean) => void;
}

const WalletsPanel = ({
  payload,
  error,
  loading,
  simulation,
  momo,
  onTransfer,
  onError,
}: WalletsPanelProps) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const { settings, setSettings } = useBankroll();
  const [selectionError, setSelectionError] = useState<string | null>(null);

  const move = async (wallet: Wallet, kind: "deposit" | "withdrawal") => {
    const verb = kind === "deposit" ? "deposit into" : "withdraw from";
    const raw = window.prompt(
      `How much do you want to ${verb} ${wallet.name}?\n\n` +
        (kind === "deposit"
          ? `Momo holds ${formatAmount(momo)}, so that is the most you can top up.`
          : `${wallet.name} holds ${formatAmount(wallet.balance)}.`),
      kind === "deposit" ? formatAmount(Math.min(momo, 100)) : formatAmount(wallet.balance),
    );
    if (raw === null) return;

    const amount = Math.round(Number(raw.replace(/,/g, "")) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      onError("Enter an amount greater than 0.", simulation);
      return;
    }
    if (kind === "deposit" && amount > momo) {
      onError(
        `Not enough cash in the reserves: Momo holds ${formatAmount(momo)}, so you cannot top up ${formatAmount(amount)}.`,
        simulation,
      );
      return;
    }
    if (kind === "withdrawal" && amount > wallet.balance) {
      onError(
        `${wallet.name} only holds ${formatAmount(wallet.balance)}, so you cannot withdraw ${formatAmount(amount)}.`,
        simulation,
      );
      return;
    }

    setBusyId(wallet.id);
    try {
      await onTransfer(wallet.id, kind, amount);
      onError(null, simulation);
    } catch (err) {
      onError((err as Error).message, simulation);
    } finally {
      setBusyId(null);
    }
  };

  const wallets = payload?.wallets ?? [];
  const liquidity = payload?.liquidity ?? null;
  const bookies = selectedBookies(settings);
  const splitReady = hasSplit(settings);
  /**
   * The split: bankroll / number of selected bookies, always floored to a whole 100 (10,000 over
   * 6 bookies = 1,600 each, with 400 left in Momo). Recomputed from the selection on every
   * render, so ticking or unticking a bookie reprices every row at once.
   */
  const plannedShare = splitReady ? computePlan(settings, bookies.length).perWallet : 0;
  const isSelectedBookie = (name: string) =>
    bookies.some((bookie) => bookie.toLowerCase() === name.toLowerCase());
  // Liquidity is real cash: the sum of the actual wallet balances.
  const actualCash = liquidity?.totalBalance ?? 0;
  // An arb in play locks the bookies already in the rotation, so a live leg can never be dropped.
  // Bookies that were not selected previously stay active, so a new bookie can still be added.
  const pendingBookies = payload?.pendingSettlement?.bookies ?? [];
  const arbInPlay = pendingBookies.length > 0;

  // The bankroll splits across the picked bookies only, so a split needs at least two of them.
  const toggleBookie = (name: string) => {
    const next = isSelectedBookie(name)
      ? bookies.filter((bookie) => bookie.toLowerCase() !== name.toLowerCase())
      : [...bookies, name];
    setSettings({ ...settings, bookies: next });
    setSelectionError(
      next.length < MIN_BOOKIES
        ? `Select at least ${MIN_BOOKIES} bookies — with ${next.length} selected the bankroll cannot be split.`
        : null,
    );
  };

  const selectAllBookies = () => {
    setSettings({ ...settings, bookies: wallets.map((wallet) => wallet.name) });
    setSelectionError(null);
  };

  return (
    <section className="wallets-panel">
      <header className="wallets-header">
        <div>
          <h2>My Wallets</h2>
          <p className="wallets-subtitle">
            {simulation
              ? "Simulated bookmakers — pick the bookies to split across, then top up or withdraw."
              : "Real bookmakers — pick the bookies to split across, then top up or withdraw."}
          </p>
        </div>
        <span className={`wallets-mode ${simulation ? "sim" : "real"}`}>
          {simulation ? "Simulation" : "Real"}
        </span>
      </header>

      {error && <p className="wallets-error">{error}</p>}
      {selectionError && <p className="wallets-error">{selectionError}</p>}

      {liquidity && (
        <div className="wallets-liquidity">
          <div
            className="liquidity-stat"
            title="Actual cash in the wallets plus stakes already committed"
          >
            <span>Portfolio value</span>
            <strong>{formatAmount(actualCash + liquidity.staked)}</strong>
          </div>
          <div className="liquidity-stat" title="Deducted from the wallets when the bet was logged">
            <span>Staked</span>
            <strong>{formatAmount(liquidity.staked)}</strong>
          </div>
          <div className="liquidity-stat available" title="Actual cash you can deploy right now">
            <span>Available Liquidity</span>
            <strong>{formatAmount(actualCash)}</strong>
          </div>
          <div
            className={`liquidity-stat profit${
              (payload?.totalProfit ?? 0) < 0 ? " negative" : ""
            }`}
          >
            <span>Total Profit</span>
            <strong>{formatAmount(payload?.totalProfit ?? 0)}</strong>
          </div>
        </div>
      )}

      {wallets.length > 0 && (
        <div className="wallets-selection">
          <span className="wallets-selection-count">
            {bookies.length} of {wallets.length} bookies selected for the bankroll split
          </span>
          <button
            type="button"
            className="wallets-select-all"
            onClick={selectAllBookies}
            disabled={bookies.length === wallets.length}
          >
            Select all
          </button>
        </div>
      )}

      {loading ? (
        <p className="wallets-empty">Loading walletsâ€¦</p>
      ) : !payload ? null : wallets.length === 0 ? (
        <p className="wallets-empty">
          No {simulation ? "simulation" : "real"} wallets found. Apply the D1 migration
          (`npx wrangler d1 migrations apply DB --local`) to seed all four.
        </p>
      ) : (
        <ul className="wallets-list">
          {wallets.map((wallet) => {
            const isSelected = isSelectedBookie(wallet.name);
            const locked = arbInPlay && isSelected;
            // The plan is the point of the row: bankroll / selected bookies, live.
            const planAmount = isSelected ? plannedShare : 0;

            return (
              <li className="wallet-row" key={wallet.id}>
                <input
                  className="wallet-select"
                  type="checkbox"
                  checked={isSelected}
                  disabled={locked}
                  onChange={() => toggleBookie(wallet.name)}
                  aria-label={`Include ${wallet.name} in the bankroll split`}
                  title={
                    locked
                      ? `${wallet.name} is in play — locked until the arb settles`
                      : "Include this bookie in the bankroll split"
                  }
                />
                <div className="wallet-identity">
                  <span className="wallet-name">{wallet.name}</span>
                  {/* `bookmaker` mirrors `name` from the same column, so only show it when different. */}
                  {wallet.bookmaker !== wallet.name && (
                    <span className="wallet-bookie">{wallet.bookmaker}</span>
                  )}
                </div>

                <span className="wallet-amount" title={`Holds ${formatAmount(wallet.balance)}`}>
                  {formatAmount(wallet.balance)}
                  <span className="wallet-plan">
                    {isSelected ? `plan ${formatAmount(planAmount)}` : "not in plan"}
                  </span>
                </span>

                <div className="wallet-actions">
                  <button
                    className="wallet-topup"
                    type="button"
                    disabled={busyId === wallet.id}
                    onClick={() => void move(wallet, "deposit")}
                  >
                    Top up
                  </button>
                  <button
                    className="wallet-withdraw"
                    type="button"
                    disabled={busyId === wallet.id || wallet.balance <= 0}
                    onClick={() => void move(wallet, "withdrawal")}
                  >
                    Withdraw
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default WalletsPanel;
