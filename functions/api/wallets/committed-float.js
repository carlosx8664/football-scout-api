import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  parseSimulation,
} from "../../../shared/wallets.js";

const round2 = (value) => Math.round(Number(value ?? 0) * 100) / 100;

/**
 * GET /api/wallets/committed-float?simulation=
 *
 * Stakes are debited when a bet is logged, so a wallet's `balance` is cash that is free right now.
 * What the page could not answer is where the rest went and when it comes back: this reports, per
 * bookie and per release date, the stakes sitting on unsettled bets.
 *
 * The release date is the fixture's kickoff day (a bet settles after its match), falling back to
 * the day it was logged when the kickoff is unknown.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));
  const mode = simulation ? 1 : 0;

  try {
    const [wallets, bets] = await Promise.all([
      db
        .prepare(
          `SELECT bookie_name, balance FROM wallets
            WHERE is_simulation = ?
            ORDER BY bookie_name COLLATE NOCASE ASC`,
        )
        .bind(mode)
        .all(),
      db
        .prepare(
          `SELECT event_name, kind, kickoff, created_at,
                  bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake
             FROM active_bets
            WHERE is_simulation = ?`,
        )
        .bind(mode)
        .all(),
    ]);

    const today = new Date().toISOString().slice(0, 10);
    const byBookie = new Map();
    for (const row of wallets.results ?? []) {
      byBookie.set(String(row.bookie_name), {
        name: String(row.bookie_name),
        free: round2(row.balance),
        committed: 0,
        today: 0,
        bets: 0,
      });
    }

    const schedule = new Map();
    const touched = (name) => {
      const key = String(name ?? "");
      if (!key) return null;
      if (!byBookie.has(key)) {
        byBookie.set(key, { name: key, free: 0, committed: 0, today: 0, bets: 0 });
      }
      return byBookie.get(key);
    };

    for (const bet of bets.results ?? []) {
      const released = String(bet.kickoff ?? "").slice(0, 10) || String(bet.created_at ?? "").slice(0, 10);
      if (!released) continue;

      for (const leg of ["a", "b"]) {
        const stake = round2(bet[`bookie_${leg}_stake`]);
        if (stake <= 0) continue;
        const bookie = touched(bet[`bookie_${leg}_name`]);
        if (!bookie) continue;

        bookie.committed = round2(bookie.committed + stake);
        bookie.bets += 1;
        if (released <= today) bookie.today = round2(bookie.today + stake);

        const bucket = schedule.get(released) ?? { date: released, amount: 0, legs: 0 };
        bucket.amount = round2(bucket.amount + stake);
        bucket.legs += 1;
        schedule.set(released, bucket);
      }
    }

    const bookies = [...byBookie.values()]
      .map((bookie) => ({
        ...bookie,
        /** What the account is actually holding: free cash plus stakes in play. */
        exposure: round2(bookie.free + bookie.committed),
      }))
      .sort((a, b) => b.exposure - a.exposure);

    const committedTotal = round2(bookies.reduce((sum, bookie) => sum + bookie.committed, 0));
    const freeTotal = round2(bookies.reduce((sum, bookie) => sum + bookie.free, 0));
    // The smallest funded balance caps how big the next arb's legs can be.
    const funded = bookies.filter((bookie) => bookie.free > 0);
    const freeFloor = funded.length > 0 ? Math.min(...funded.map((bookie) => bookie.free)) : 0;

    return json({
      simulation,
      today,
      bookies,
      totals: {
        free: freeTotal,
        committed: committedTotal,
        exposure: round2(freeTotal + committedTotal),
        freeFloor: round2(freeFloor),
      },
      schedule: [...schedule.values()].sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (error) {
    return dbError(error);
  }
}
