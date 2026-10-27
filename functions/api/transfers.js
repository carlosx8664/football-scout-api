import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../shared/wallets.js";

const LIMIT = 100;

/**
 * GET /api/transfers?simulation=1
 *
 * Recent deposits/withdrawals for the mode, plus lifetime totals (count, deposited, withdrawn)
 * so the cash-flow history has numbers even after old rows scroll out of the list.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));
  const mode = modeValue(simulation);

  try {
    const [rows, totals] = await Promise.all([
      db
        .prepare(
          `SELECT id, wallet_id, bookie_name, kind, amount, created_at
             FROM wallet_transfers
            WHERE is_simulation = ?
            ORDER BY created_at DESC
            LIMIT ${LIMIT}`,
        )
        .bind(mode)
        .all(),
      db
        .prepare(
          `SELECT
             COUNT(*) AS count,
             COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE 0 END), 0) AS deposited,
             COALESCE(SUM(CASE WHEN kind = 'withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn
           FROM wallet_transfers WHERE is_simulation = ?`,
        )
        .bind(mode)
        .first(),
    ]);

    const deposited = round2(Number(totals?.deposited ?? 0));
    const withdrawn = round2(Number(totals?.withdrawn ?? 0));

    return json({
      simulation,
      transfers: (rows.results ?? []).map((row) => ({
        id: row.id,
        walletId: row.wallet_id,
        bookie: row.bookie_name,
        kind: row.kind,
        amount: round2(Number(row.amount)),
        createdAt: row.created_at,
      })),
      totals: {
        count: Number(totals?.count ?? 0),
        deposited,
        withdrawn,
        net: round2(deposited - withdrawn),
      },
    });
  } catch (error) {
    return dbError(error);
  }
}
