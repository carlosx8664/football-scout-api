import { MIN_BOOKIES, computePlan, hasSplit, selectedBookies, useBankroll } from "../lib/bankroll";
import { formatAmount } from "../lib/wallets";
import type { WalletsPayload } from "../types";
import "./RebalancingHints.css";

/** Share of the per-bookie target below which a wallet is treated as very low. */
const LOW_PCT = 50;

interface RebalancingHintsProps {
  payload: WalletsPayload | null;
  error: string | null;
  loading: boolean;
}

/**
 * Per-bookie progress against the Bankroll Plan target, so the gauge reads left-to-right:
 * red = needs a top-up, amber = slightly below target, green = at or above target.
 */
const bandFor = (ratio: number) => (ratio < LOW_PCT ? "danger" : ratio < 100 ? "caution" : "healthy");

/** Bookie split gauges: name, share of the target, progress bar and live balance. */
const RebalancingHints = ({ payload, error, loading }: RebalancingHintsProps) => {
  const wallets = payload?.wallets ?? [];
  const { settings } = useBankroll();
  const selection = selectedBookies(settings);
  const selectedNames = new Set(selection.map((name) => name.toLowerCase()));
  const bookies = wallets.filter((wallet) => selectedNames.has(wallet.name.toLowerCase()));
  const splitReady = hasSplit(settings) && bookies.length >= MIN_BOOKIES;
  // Split across everything the user picked, so this matches My Wallets and the Bankroll Plan.
  const target = splitReady ? computePlan(settings, selection.length).perWallet : 0;

  return (
    <section className="rebalance-panel">
      <header className="rebalance-header">
        <div>
          <h2>Rebalancing Hints</h2>
        </div>
      </header>

      {error && <p className="rebalance-error">{error}</p>}

      {loading ? (
        <p className="rebalance-empty">Loading wallet split...</p>
      ) : !payload ? null : wallets.length === 0 ? (
        <p className="rebalance-empty">No wallets to rebalance yet.</p>
      ) : selection.length === 0 ? (
        <p className="rebalance-empty">
          No bookies selected. Pick at least {MIN_BOOKIES} in My Wallets to split the bankroll.
        </p>
      ) : !splitReady ? (
        <p className="rebalance-empty">
          Pick at least {MIN_BOOKIES} bookies that hold a wallet in this ledger to split the
          bankroll.
        </p>
      ) : (
        <ul className="rebalance-split">
          {bookies.map((wallet) => {
            const ratio = target > 0 ? (wallet.balance / target) * 100 : 0;
            const band = bandFor(ratio);
            return (
              <li className="rebalance-row" key={wallet.id}>
                <span className="rebalance-bookie">{wallet.name}</span>
                <span className={`rebalance-share ${band}`}>{Math.round(ratio)}%</span>
                <span className="rebalance-bar">
                  <span
                    className={`rebalance-bar-fill ${band}`}
                    style={{ width: `${Math.min(ratio, 100)}%` }}
                  />
                </span>
                <span className="rebalance-balance">{formatAmount(wallet.balance)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default RebalancingHints;