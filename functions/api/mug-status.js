import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  parseSimulation,
} from "../../shared/wallets.js";

/**
 * GET /api/mug-status?simulation=0&from=<iso>&to=<iso>
 *
 * Advisory only — the arb log no longer blocks on the daily mug-bet gate, because a live arb has
 * to be grabbed before it moves. This reports which funded bookies still owe today's camouflage
 * mug bet, so the dashboard can nag instead of refusing the arb.
 *
 * "Today" is the punter's own midnight-to-midnight window, sent by the client (`localDayWindow`),
 * matching how the old gate measured it.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const url = new URL(request.url);
  const simulation = parseSimulation(url.searchParams.get("simulation"));
  const mode = simulation ? 1 : 0;
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return json({ error: "from and to are required (the client's local day window)." }, 400);
  }

  try {
    const [wallets, covered] = await Promise.all([
      db
        .prepare(
          `SELECT bookie_name, balance FROM wallets
            WHERE is_simulation = ? AND balance > 0
            ORDER BY bookie_name COLLATE NOCASE ASC`,
        )
        .bind(mode)
        .all(),
      // A mug bet counts for the day it was logged, whether it is still open or already settled.
      db
        .prepare(
          `SELECT DISTINCT lower(name) AS bookie FROM (
              SELECT bookie_a_name AS name FROM active_bets
                WHERE is_simulation = ? AND kind = 'muggy'
                  AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
              UNION
              SELECT bookie_b_name AS name FROM active_bets
                WHERE is_simulation = ? AND kind = 'muggy'
                  AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
              UNION
              SELECT bookie_a_name AS name FROM history
                WHERE is_simulation = ? AND kind = 'muggy' AND settlement_type <> 'cancelled'
                  AND logged_at IS NOT NULL
                  AND datetime(logged_at) >= datetime(?) AND datetime(logged_at) < datetime(?)
              UNION
              SELECT bookie_b_name AS name FROM history
                WHERE is_simulation = ? AND kind = 'muggy' AND settlement_type <> 'cancelled'
                  AND logged_at IS NOT NULL
                  AND datetime(logged_at) >= datetime(?) AND datetime(logged_at) < datetime(?)
            )`,
        )
        .bind(mode, from, to, mode, from, to, mode, from, to, mode, from, to)
        .all(),
    ]);

    const mugged = new Set((covered.results ?? []).map((row) => String(row.bookie)));
    const rows = (wallets.results ?? []).map((row) => ({
      name: String(row.bookie_name),
      balance: Math.round(Number(row.balance ?? 0) * 100) / 100,
      muggedToday: mugged.has(String(row.bookie_name).toLowerCase()),
    }));

    return json({
      simulation,
      day: { from, to },
      bookies: rows,
      owed: rows.filter((row) => !row.muggedToday).map((row) => row.name),
    });
  } catch (error) {
    return dbError(error);
  }
}
