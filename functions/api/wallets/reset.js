import {
  DB_UNAVAILABLE_MESSAGE,
  SIMULATION_RESET_PER_WALLET,
  dbError,
  getDb,
  json,
  modeValue,
  walletPayload,
} from "../../../shared/wallets.js";

/**
 * POST /api/wallets/reset
 *
 * Puts every simulation wallet back to 250 GHS (4 wallets = 1,000 GHS). Real wallets are never
 * touched, because the statement filters on `is_simulation = 1`.
 */
export async function onRequestPost({ env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  try {
    await db
      .prepare("UPDATE wallets SET balance = ? WHERE is_simulation = ?")
      .bind(SIMULATION_RESET_PER_WALLET, modeValue(true))
      .run();

    return json(await walletPayload(db, true));
  } catch (error) {
    return dbError(error);
  }
}
