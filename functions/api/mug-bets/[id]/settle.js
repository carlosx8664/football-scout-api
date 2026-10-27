import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../../shared/wallets.js";
import { toMugBet } from "../../../../shared/mug-bets.js";

/**
 * POST /api/mug-bets/:id/settle
 *
 * Body: `{ won: boolean, simulation?: boolean }`
 *
 * Settles one open mug bet. A win credits `stake × odds` back to the bookie; a loss changes no
 * balance (the stake was already debited when the bet was logged). Nothing is written to
 * `wallet_transfers` — a payout is not a deposit — and nothing lands in `history`, which stays a
 * pure record of arbitrage.
 */
export async function onRequestPost({ request, env, params }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const won = body?.won;
  if (typeof won !== "boolean") {
    return json({ error: "`won` must be true or false." }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const bet = await db
      .prepare("SELECT * FROM mug_bets WHERE id = ? AND is_simulation = ?")
      .bind(id, mode)
      .first();

    if (!bet) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} mug bet with id "${id}".` }, 404);
    }
    if (bet.status !== "open") {
      return json({ error: "That mug bet is already settled." }, 409);
    }

    const stake = round2(Number(bet.stake));
    const payout = won ? round2(stake * Number(bet.odds)) : 0;

    const statements = [
      db
        .prepare(
          `UPDATE mug_bets
              SET status = ?, payout = ?, settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND is_simulation = ?`,
        )
        .bind(won ? "won" : "lost", payout, id, mode),
    ];

    if (payout > 0) {
      statements.push(
        db
          .prepare(
            `UPDATE wallets SET balance = balance + ?
              WHERE bookie_name = ? AND is_simulation = ?`,
          )
          .bind(payout, bet.bookie_name, mode),
      );
    }

    await db.batch(statements);

    const row = await db.prepare("SELECT * FROM mug_bets WHERE id = ?").bind(id).first();

    return json({ ...(await walletPayload(db, simulation)), mugBet: toMugBet(row ?? {}) });
  } catch (error) {
    return dbError(error);
  }
}
