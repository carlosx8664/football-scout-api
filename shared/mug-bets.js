/**
 * Mug-bet helpers shared by the mug-bet endpoints and `GET /api/history`.
 *
 * A mug bet is a small single on a real match, placed to keep a bookmaker account looking human.
 * It is deliberately not part of `history`: arb profit stays a pure measure of the arbitrage
 * book, and History reports "arb profit vs mug spend" side by side instead of merging them.
 */

export const MUG_MAX_STAKE = 10_000;
export const MUG_MAX_ODDS = 1_000;

/** Row -> API shape. */
export function toMugBet(row) {
  return {
    id: row.id,
    bookie: row.bookie_name,
    eventName: row.event_name,
    stake: Math.round(Number(row.stake) * 100) / 100,
    odds: Number(row.odds),
    status: row.status ?? "open",
    payout: Math.round(Number(row.payout ?? 0) * 100) / 100,
    createdAt: row.created_at,
    settledAt: row.settled_at ?? null,
  };
}

/**
 * Totals for one mode, optionally limited to a date window on `created_at`.
 *
 * `net` is what the habit has cost so far: stakes out minus payouts back. Open bets count in
 * `staked` but not in `returned`, which is accurate — that money is still out there.
 */
export async function loadMugTotals(db, simulation, range = null) {
  const where = ["is_simulation = ?"];
  const params = [simulation ? 1 : 0];

  if (range?.from) {
    where.push("date(created_at) >= date(?)");
    params.push(range.from);
  }
  if (range?.to) {
    where.push("date(created_at) <= date(?)");
    params.push(range.to);
  }

  const row = await db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(stake), 0) AS staked,
         COALESCE(SUM(payout), 0) AS returned,
         COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open
       FROM mug_bets WHERE ${where.join(" AND ")}`,
    )
    .bind(...params)
    .first();

  const round2 = (value) => Math.round(value * 100) / 100;
  const staked = round2(Number(row?.staked ?? 0));
  const returned = round2(Number(row?.returned ?? 0));

  return {
    count: Number(row?.count ?? 0),
    open: Number(row?.open ?? 0),
    staked,
    returned,
    net: round2(staked - returned),
  };
}

/** Mug bets created inside a window, newest first. */
export async function loadMugBets(db, simulation, range = null, limit = 100) {
  const where = ["is_simulation = ?"];
  const params = [simulation ? 1 : 0];

  if (range?.from) {
    where.push("date(created_at) >= date(?)");
    params.push(range.from);
  }
  if (range?.to) {
    where.push("date(created_at) <= date(?)");
    params.push(range.to);
  }

  const { results } = await db
    .prepare(
      `SELECT id, bookie_name, event_name, stake, odds, status, payout, created_at, settled_at
         FROM mug_bets
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ${Math.max(1, limit)}`,
    )
    .bind(...params)
    .all();

  return (results ?? []).map(toMugBet);
}
