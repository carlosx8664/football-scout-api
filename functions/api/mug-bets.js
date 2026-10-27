import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../shared/wallets.js";
import {
  MUG_MAX_ODDS,
  MUG_MAX_STAKE,
  loadMugTotals,
  toMugBet,
} from "../../shared/mug-bets.js";

const LIMIT = 100;

/**
 * GET /api/mug-bets?simulation=1
 *
 * Open mug bets first (newest first), then settled ones, plus lifetime totals.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));

  try {
    const [rows, totals] = await Promise.all([
      db
        .prepare(
          `SELECT id, bookie_name, event_name, stake, odds, status, payout, created_at, settled_at
             FROM mug_bets
            WHERE is_simulation = ?
            ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
            LIMIT ${LIMIT}`,
        )
        .bind(modeValue(simulation))
        .all(),
      loadMugTotals(db, simulation),
    ]);

    return json({
      simulation,
      mugBets: (rows.results ?? []).map(toMugBet),
      totals,
    });
  } catch (error) {
    return dbError(error);
  }
}

/**
 * POST /api/mug-bets
 *
 * Body: `{ bookie, eventName, stake, odds, simulation?: boolean }`
 *
 * Logs a small single on a real match and debits the stake from that bookie, the same way an arb
 * leg is debited. Responds with the fresh wallet payload so the dashboard can repaint.
 */
export async function onRequestPost({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const bookie = typeof body?.bookie === "string" ? body.bookie.trim() : "";
  const eventName = typeof body?.eventName === "string" ? body.eventName.trim() : "";
  const stake = round2(Number(body?.stake));
  const odds = Number(body?.odds);

  if (!bookie) return json({ error: "Pick the bookmaker this mug bet is with." }, 400);
  if (!eventName) return json({ error: "Describe the match (e.g. Barcelona to win)." }, 400);
  if (!Number.isFinite(stake) || stake <= 0 || stake > MUG_MAX_STAKE) {
    return json({ error: `Stake must be between 0 and ${MUG_MAX_STAKE}.` }, 400);
  }
  if (!Number.isFinite(odds) || odds <= 1 || odds > MUG_MAX_ODDS) {
    return json({ error: "Odds must be greater than 1." }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const wallet = await db
      .prepare(
        "SELECT id, bookie_name, balance FROM wallets WHERE bookie_name = ? AND is_simulation = ?",
      )
      .bind(bookie, mode)
      .first();

    if (!wallet) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} wallet for ${bookie}.` }, 404);
    }

    const balance = round2(Number(wallet.balance ?? 0));
    if (balance < stake) {
      return json(
        { error: `${bookie} only holds GHS ${balance}; cannot stake GHS ${stake}.` },
        409,
      );
    }

    const id = crypto.randomUUID();

    await db.batch([
      db
        .prepare("UPDATE wallets SET balance = balance - ? WHERE id = ? AND is_simulation = ?")
        .bind(stake, wallet.id, mode),
      db
        .prepare(
          `INSERT INTO mug_bets (id, bookie_name, event_name, stake, odds, is_simulation)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, wallet.bookie_name, eventName, stake, odds, mode),
    ]);

    const row = await db.prepare("SELECT * FROM mug_bets WHERE id = ?").bind(id).first();

    return json({ ...(await walletPayload(db, simulation)), mugBet: toMugBet(row ?? {}) }, 201);
  } catch (error) {
    return dbError(error);
  }
}
