import { computePlan, useBankroll } from "../lib/bankroll";
import { formatGhs } from "../lib/wallets";
import type { Wallet } from "../types";
import "./MoneyGuide.css";

interface MoneyGuideProps {
  wallets: Wallet[];
  simulation: boolean;
}

/**
 * Practical deposit/withdrawal rhythm for keeping bookmaker accounts unremarkable. Lives in the
 * Active Bets column so it sits next to the money actually at risk.
 */
const MoneyGuide = ({ wallets, simulation }: MoneyGuideProps) => {
  const { settings } = useBankroll();
  const plan = computePlan(settings, wallets.length);
  const names = wallets.map((wallet) => wallet.name).join(", ");

  return (
    <section className="money-guide">
      <h2>How to move money without looking like a bot</h2>
      <p className="money-guide-subtitle">
        {simulation ? "Simulation" : "Real"} ledger · {wallets.length} wallets ·{" "}
        {formatGhs(plan.bankroll)} bankroll
      </p>

      <ul>
        <li>
          <strong>Withdraw only profits</strong>, once or twice a week, in 200–500 GHS chunks per
          bookie. Batching avoids mobile-money fees on every transfer.
        </li>
        <li>
          <strong>Deposit reactively</strong> — only when a bookie drops under 15% of the
          portfolio, in 50 GHS steps (the Top up buttons size it for you).
        </li>
        <li>
          <strong>Never send odd amounts</strong> (GHS 137.42) or repeat within minutes; one
          movement per bookie every 10 minutes is the cap the app enforces.
        </li>
        <li>
          <strong>Keep BetBoro light</strong> — withdraw after each settlement and leave just
          enough to cover a leg, since payouts there are slow.
        </li>
        <li>
          <strong>Hold the float</strong>: {names || "your wallets"} should average{" "}
          {formatGhs(plan.perWallet)} each at {formatGhs(plan.bankroll)} bankroll.
        </li>
      </ul>
    </section>
  );
};

export default MoneyGuide;
