/**
 * Stake maths shared by the side panel (preview) and the service worker (execution),
 * so the numbers on screen are the numbers that get typed.
 */

export const DEFAULT_SETTINGS = {
  apiBase: '',
  totalStake: 100,
  roundStep: 10,
  oddsTolerancePct: 0.5,
  autoRefreshSec: 60,
};

/**
 * Splits `total` across legs so every leg returns the same amount: stake_i = total / (odds_i * Σ(1/odds_j)).
 * Each leg is floored to `step`, and the rounding shortfall is handed back to the leg that lost most,
 * which keeps the book balanced without ever exceeding the requested outlay.
 */
export function allocateStakes(legs, total, step) {
  const prices = legs.map((leg) => Number(leg.odds) || 0);
  const implied = prices.reduce((sum, odds) => sum + (odds > 1 ? 1 / odds : 0), 0);
  const stake = Number(total) || 0;
  if (!(implied > 0) || !(stake > 0)) return legs.map(() => 0);

  const wanted = Math.max(1, Number(step) || 1);
  const unit = stake >= wanted * legs.length ? wanted : 1;
  const raw = prices.map((odds) => (odds > 1 ? stake / implied / odds : 0));
  // An unpriceable leg gets 0, never the minimum unit: a leg with no odds must fail the job, not
  // silently receive the rounding step (10) as its stake.
  const stakes = raw.map((value) => (value > 0 ? Math.max(unit, Math.floor(value / unit) * unit) : 0));

  let shortfall = stake - stakes.reduce((sum, value) => sum + value, 0);
  let guard = 0;
  while (shortfall >= unit && guard < 500) {
    let best = 0;
    for (let i = 1; i < raw.length; i += 1) {
      if (raw[i] - stakes[i] > raw[best] - stakes[best]) best = i;
    }
    stakes[best] += unit;
    shortfall -= unit;
    guard += 1;
  }

  return stakes.map((value) => Number(value.toFixed(2)));
}

/** Combined implied probability of a set of prices, e.g. 0.978 for a 2.2% arb. */
export function impliedTotal(legs) {
  return legs.reduce((sum, leg) => {
    const odds = Number(leg.odds) || 0;
    return sum + (odds > 1 ? 1 / odds : 0);
  }, 0);
}
