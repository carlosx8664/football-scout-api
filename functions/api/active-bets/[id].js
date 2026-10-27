import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../../shared/wallets.js";

/**
 * DELETE /api/active-bets/:id?simulation=1|0
 *
 * Cancels a bet that was logged in error: both stakes are refunded to their bookie wallets and
 * the row leaves `active_bets`. A zero-profit `history` row tagged `cancelled` keeps the audit
 * trail, so the removal is visible later without affecting Total Profit or the daily goal.
 */
export async function onRequestDelete({ request, env, params }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));
  const mode = modeValue(simulation);

  try {
    const bet = await db
      .prepare("SELECT * FROM active_bets WHERE id = ? AND is_simulation = ?")
      .bind(id, mode)
      .first();

    if (!bet) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} active bet with id "${id}".` }, 404);
    }

    // Both legs can sit on the same bookie, so refunds are grouped per wallet.
    const refunds = new Map();
    for (const leg of [
      { bookie: bet.bookie_a_name, stake: Number(bet.bookie_a_stake) },
      { bookie: bet.bookie_b_name, stake: Number(bet.bookie_b_stake) },
    ]) {
      refunds.set(leg.bookie, round2((refunds.get(leg.bookie) ?? 0) + leg.stake));
    }

    const bookies = [...refunds.keys()];
    const wallets = await db
      .prepare(
        `SELECT bookie_name FROM wallets
          WHERE is_simulation = ? AND bookie_name IN (${bookies.map(() => "?").join(", ")})`,
      )
      .bind(mode, ...bookies)
      .all();

    const found = new Set((wallets.results ?? []).map((row) => row.bookie_name));
    const missing = bookies.find((bookie) => !found.has(bookie));
    if (missing) {
      return json(
        { error: `Missing ${simulation ? "simulation" : "real"} wallet for ${missing}.` },
        409,
      );
    }

    const totalStake = round2(Number(bet.bookie_a_stake) + Number(bet.bookie_b_stake));
    const historyId = crypto.randomUUID();

    await db.batch([
      ...[...refunds].map(([bookie, amount]) =>
        db
          .prepare(
            "UPDATE wallets SET balance = balance + ? WHERE bookie_name = ? AND is_simulation = ?",
          )
          .bind(amount, bookie, mode),
      ),
      db
        .prepare(
          `INSERT INTO history (
             id, event_name, winning_bookie, net_profit, is_simulation, settlement_type,
             bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake, total_stake
           ) VALUES (?, ?, NULL, 0, ?, 'cancelled', ?, ?, ?, ?, ?)`,
        )
        .bind(
          historyId,
          bet.event_name,
          mode,
          bet.bookie_a_name,
          Number(bet.bookie_a_stake),
          bet.bookie_b_name,
          Number(bet.bookie_b_stake),
          totalStake,
        ),
      db.prepare("DELETE FROM active_bets WHERE id = ? AND is_simulation = ?").bind(id, mode),
    ]);

    return json({
      id,
      historyId,
      eventName: bet.event_name,
      simulation,
      refunded: [...refunds].map(([bookie, amount]) => ({ bookie, amount })),
      totalRefunded: round2([...refunds.values()].reduce((sum, amount) => sum + amount, 0)),
    });
  } catch (error) {
    return dbError(error);
  }
}
