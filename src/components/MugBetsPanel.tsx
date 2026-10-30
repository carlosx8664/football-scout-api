import { useState } from "react";
import { computePlan, useBankroll } from "../lib/bankroll";
import { logArb } from "../lib/bets";
import { formatAmount } from "../lib/wallets";
import type { Wallet, WalletsPayload } from "../types";
import "./MugBetsPanel.css";

type Tab = "muggy" | "free";

/** Hedge stake that equalises both outcomes: (free stake × free odds) / hedge odds. */
const hedgeStakeFor = (stake: string, odds: string, hedgeOdds: string) => {
  const s = Number(stake);
  const o = Number(odds);
  const h = Number(hedgeOdds);
  if (!Number.isFinite(s) || !Number.isFinite(o) || !Number.isFinite(h)) return "";
  if (s <= 0 || o <= 1 || h <= 1) return "";
  return ((s * o) / h).toFixed(2);
};

interface MugBetsPanelProps {
  simulation: boolean;
  /** Bumped after any ledger write so the wallets refetch. */
  refreshToken: number;
  wallets: Wallet[];
  onChanged: (payload: WalletsPayload) => void;
}

/**
 * Mug-bet entry: muggy accas and free bets both land in `active_bets` (kind = muggy / free), so
 * they show up in Active Bets with the same Remove and Settle actions as arbs and their stakes
 * flow into liquidity, Momo and profit/loss like any other bet.
 */
const MugBetsPanel = ({ simulation, wallets, onChanged }: MugBetsPanelProps) => {
  const { settings } = useBankroll();
  const plan = computePlan(settings, Math.max(wallets.length, 1));
  const [tab, setTab] = useState<Tab>("muggy");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const firstBookie = wallets[0]?.name ?? "";
  const defaultStake = String(Math.max(1, Math.round(plan.microMug)));
  const [muggy, setMuggy] = useState({ bookie: "", stake: defaultStake, odds: "1.30" });
  const [free, setFree] = useState({
    bookie: "",
    match: "",
    stake: defaultStake,
    odds: "1.30",
    hedgeBookie: "",
    hedgeStake: hedgeStakeFor(defaultStake, "1.30", "1.30"),
    hedgeOdds: "1.30",
  });
  /** True until the user types their own hedge stake, which switches the auto-fill off. */
  const [hedgeAuto, setHedgeAuto] = useState(true);

  const muggyBookie = muggy.bookie || firstBookie;
  const freeBookie = free.bookie || firstBookie;
  const hedgeBookie =
    free.hedgeBookie || wallets.find((wallet) => wallet.name !== freeBookie)?.name || "";

  /** Updates the free-bet form and refreshes the hedge stake unless the user overrode it. */
  const updateFree = (patch: Partial<typeof free>) =>
    setFree((current) => {
      const next = { ...current, ...patch };
      return hedgeAuto
        ? { ...next, hedgeStake: hedgeStakeFor(next.stake, next.odds, next.hedgeOdds) }
        : next;
    });

  const freeStake = Number(free.stake) || 0;
  const freeOdds = Number(free.odds) || 0;
  const hedgeStake = Number(free.hedgeStake) || 0;
  const hedgeOdds = Number(free.hedgeOdds) || 0;
  // A free bet's stake is not returned, so the whole payout is profit.
  const freePayout = freeStake > 0 && freeOdds > 1 ? freeStake * freeOdds : 0;
  const hedgeProfit = hedgeStake > 0 && hedgeOdds > 1 ? hedgeStake * hedgeOdds - hedgeStake : 0;
  // What is left after the hedge stake is lost (free bet wins) or kept (hedge wins).
  const profitIfFreeWins = freePayout - hedgeStake;
  const profitIfHedgeWins = hedgeProfit;
  const expectedProfit =
    freePayout > 0 && hedgeStake > 0 ? Math.min(profitIfFreeWins, profitIfHedgeWins) : 0;

  /** logArb answers with the bet, not the wallets, so pull the fresh cash positions. */
  const refreshWallets = async (): Promise<WalletsPayload> => {
    const response = await fetch(`/api/wallets?simulation=${simulation ? 1 : 0}`, {
      cache: "no-store",
    });
    const payload = (await response.json()) as WalletsPayload & { error?: string };
    if (!response.ok || !payload?.wallets) {
      throw new Error(payload?.error ?? "Could not refresh the wallets.");
    }
    return payload;
  };

  const submitMuggy = async (event: React.FormEvent) => {
    event.preventDefault();
    const stake = Number(muggy.stake);
    const odds = Number(muggy.odds);
    if (!Number.isFinite(stake) || stake <= 0) {
      setProblem("Stake must be greater than 0.");
      return;
    }

    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await logArb({
        eventName: `Muggy acca - ${muggyBookie}`,
        kind: "muggy",
        simulation,
        // One funded leg; the second is the ledger's required slot, carrying no stake.
        legs: [
          { name: muggyBookie, odds, stake },
          { name: muggyBookie, odds: 1.01, stake: 0 },
        ],
      });
      setNotice(`Muggy acca logged: ${formatAmount(result.totalStake)} on ${muggyBookie}.`);
      onChanged(await refreshWallets());
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitFree = async (event: React.FormEvent) => {
    event.preventDefault();
    const stakeValue = Number(free.stake);
    const oddsValue = Number(free.odds);
    const hedgeStakeValue = Number(free.hedgeStake) || 0;
    const hedgeOddsValue = Number(free.hedgeOdds) || 1.01;

    if (!free.match.trim()) {
      setProblem("Add the match the free bet is on.");
      return;
    }
    if (!Number.isFinite(stakeValue) || stakeValue <= 0) {
      setProblem("Stake must be greater than 0.");
      return;
    }

    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      const result = await logArb({
        eventName: free.match.trim(),
        kind: "free",
        simulation,
        legs: [
          { name: freeBookie, odds: oddsValue, stake: stakeValue },
          { name: hedgeBookie || freeBookie, odds: hedgeOddsValue, stake: hedgeStakeValue },
        ],
      });
      setNotice(
        hedgeStakeValue > 0
          ? `Free bet logged: ${formatAmount(hedgeStakeValue)} hedge on ${hedgeBookie}.`
          : `Free bet logged with no hedge (${formatAmount(result.totalStake)} outlay).`,
      );
      onChanged(await refreshWallets());
      setFree((current) => ({ ...current, match: "" }));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mugbets-panel">
      <header className="mugbets-header">
        <div>
          <h2>Mug Bets</h2>
          <p className="mugbets-subtitle">
            Keep the {simulation ? "simulation" : "real"} accounts looking human. Both forms land
            in Active Bets.
          </p>
        </div>
      </header>

      <div className="mugbets-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "muggy"}
          className={`mugbets-tab${tab === "muggy" ? " active" : ""}`}
          onClick={() => setTab("muggy")}
        >
          Muggy Acca
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "free"}
          className={`mugbets-tab${tab === "free" ? " active" : ""}`}
          onClick={() => setTab("free")}
        >
          Free Bet
        </button>
      </div>

      {problem && <p className="mugbets-error">{problem}</p>}
      {notice && <p className="mugbets-notice">{notice}</p>}

      {tab === "muggy" ? (
        <form className="mugbets-form" onSubmit={submitMuggy}>
          <label className="mugbets-field-wide">
            <span>Bookie</span>
            <select
              value={muggyBookie}
              onChange={(event) => setMuggy((c) => ({ ...c, bookie: event.target.value }))}
              required
            >
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.name}>
                  {wallet.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Stake (daily {formatAmount(plan.microMug)})</span>
            <input
              type="number"
              min="1"
              step="1"
              value={muggy.stake}
              onChange={(event) => setMuggy((c) => ({ ...c, stake: event.target.value }))}
              required
            />
          </label>

          <label>
            <span>Odds</span>
            <input
              type="number"
              min="1.01"
              step="0.01"
              value={muggy.odds}
              onChange={(event) => setMuggy((c) => ({ ...c, odds: event.target.value }))}
              required
            />
          </label>

          <button type="submit" className="mugbets-add" disabled={busy}>
            {busy ? "Saving…" : "Log Muggy Acca"}
          </button>
        </form>
      ) : (
        <form className="mugbets-form" onSubmit={submitFree}>
          <label>
            <span>Bookie</span>
            <select
              value={freeBookie}
              onChange={(event) => updateFree({ bookie: event.target.value })}
              required
            >
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.name}>
                  {wallet.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Match</span>
            <input
              type="text"
              placeholder="Barcelona to win"
              value={free.match}
              onChange={(event) => updateFree({ match: event.target.value })}
              required
            />
          </label>

          <label>
            <span>Stake (free)</span>
            <input
              type="number"
              min="1"
              step="1"
              value={free.stake}
              onChange={(event) => updateFree({ stake: event.target.value })}
              required
            />
          </label>

          <label>
            <span>Odds</span>
            <input
              type="number"
              min="1.01"
              step="0.01"
              value={free.odds}
              onChange={(event) => updateFree({ odds: event.target.value })}
              required
            />
          </label>

          <fieldset className="mugbets-hedge">
            <legend>Hedge details</legend>
            <label>
              <span>Hedge Bookie</span>
              <select
                value={hedgeBookie}
                onChange={(event) => updateFree({ hedgeBookie: event.target.value })}
              >
                {wallets
                  .filter((wallet) => wallet.name !== freeBookie)
                  .map((wallet) => (
                    <option key={wallet.id} value={wallet.name}>
                      {wallet.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>
                Hedge Stake
                {hedgeAuto ? (
                  <em className="mugbets-auto">auto</em>
                ) : (
                  <button
                    type="button"
                    className="mugbets-auto mugbets-auto-btn"
                    onClick={() => {
                      setHedgeAuto(true);
                      setFree((current) => ({
                        ...current,
                        hedgeStake: hedgeStakeFor(current.stake, current.odds, current.hedgeOdds),
                      }));
                    }}
                  >
                    recalc
                  </button>
                )}
              </span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={free.hedgeStake}
                onChange={(event) => {
                  setHedgeAuto(false);
                  setFree((current) => ({ ...current, hedgeStake: event.target.value }));
                }}
                placeholder="0"
              />
            </label>
            <label>
              <span>Odds</span>
              <input
                type="number"
                min="1.01"
                step="0.01"
                value={free.hedgeOdds}
                onChange={(event) => updateFree({ hedgeOdds: event.target.value })}
                placeholder="1.30"
              />
            </label>
            <div className="mugbets-win mugbets-field-wide">
              <span>Possible Win (profit)</span>
              <strong>{formatAmount(hedgeProfit)}</strong>
            </div>
          </fieldset>

          <div className="mugbets-win mugbets-field-wide">
            <span>Possible Win (free bet payout)</span>
            <strong>{formatAmount(freePayout)}</strong>
          </div>

          <div className="mugbets-profit mugbets-field-wide">
            <div className="mugbets-profit-head">
              <span>Expected Profit</span>
              <strong>{formatAmount(expectedProfit)}</strong>
            </div>
            <small>
              Free bet wins {formatAmount(profitIfFreeWins)} · Hedge wins{" "}
              {formatAmount(profitIfHedgeWins)}
            </small>
          </div>

          <button type="submit" className="mugbets-add" disabled={busy}>
            {busy ? "Saving…" : "Log Free Bet"}
          </button>
        </form>
      )}
    </section>
  );
};

export default MugBetsPanel;