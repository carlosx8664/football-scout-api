import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  parseSimulation,
  walletPayload,
} from "../../shared/wallets.js";

/**
 * GET /api/wallets?simulation=1
 *
 * Returns the four wallets for the requested mode plus the available-liquidity summary
 * (wallet balances minus stakes on active bets in that same mode).
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));

  try {
    return json(await walletPayload(db, simulation));
  } catch (error) {
    return dbError(error);
  }
}
