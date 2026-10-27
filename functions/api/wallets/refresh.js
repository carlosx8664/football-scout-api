import {
  DB_UNAVAILABLE_MESSAGE,
  SIMULATION_RESET_PER_WALLET,
  dbError,
  ensureWallets,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  setCashReserve,
  walletPayload,
} from "../../../shared/wallets.js";

const MAX_OPENING_BALANCE = 1_000_000;
/** Leftover cash is capped so a wild bankroll cannot park an absurd amount off-book. */
const MAX_CASH_RESERVE = 10_000_000;

/**
 * POST /api/wallets/refresh
 *
 * Body: `{ simulation?: boolean, scope?: "mode" | "all", openingBalance?: number, bankroll?: number }`
 *
 * Wipes the ledger for a clean start: every active bet, settled history row, cash-flow entry and
 * mug bet for the selected mode(s) is removed, and each wallet is set back to `openingBalance`
 * (default 250 GHS). Wallets are re-provisioned first so any bookmaker added since the last
 * refresh gets an account too.
 *
 * When `bankroll` is supplied it is treated as the money the user actually has: anything above
 * `openingBalance × wallet count` becomes the cash reserve (the mobile-money wallet), which is
 * how 10,000 across 6 bookies ends up as 6 × 1,650 plus 100 unallocated.
 */
export async function onRequestPost({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  let body = {};
  try {
    body = await request.json();
  } catch {
    // An empty body is fine — everything falls back to the defaults.
  }

  const simulation = parseSimulation(body?.simulation);
  const scope = body?.scope === "all" ? "all" : "mode";

  const requested = Number(body?.openingBalance);
  const openingBalance =
    Number.isFinite(requested) && requested >= 0 && requested <= MAX_OPENING_BALANCE
      ? round2(requested)
      : SIMULATION_RESET_PER_WALLET;

  const requestedBankroll = Number(body?.bankroll);
  const bankroll =
    Number.isFinite(requestedBankroll) && requestedBankroll > 0
      ? Math.min(requestedBankroll, MAX_CASH_RESERVE)
      : null;

  const modes = scope === "all" ? [true, false] : [simulation];

  try {
    for (const mode of modes) {
      // Provision first: a brand-new bookmaker must exist before the balance reset reaches it.
      await ensureWallets(db, mode);
    }

    const statements = [];
    for (const mode of modes) {
      const flag = modeValue(mode);
      statements.push(
        db.prepare("DELETE FROM active_bets WHERE is_simulation = ?").bind(flag),
        db.prepare("DELETE FROM history WHERE is_simulation = ?").bind(flag),
        db.prepare("DELETE FROM wallet_transfers WHERE is_simulation = ?").bind(flag),
        db.prepare("DELETE FROM mug_bets WHERE is_simulation = ?").bind(flag),
        db
          .prepare("UPDATE wallets SET balance = ? WHERE is_simulation = ?")
          .bind(openingBalance, flag),
      );
    }

    await db.batch(statements);

    // Leftover bankroll becomes cash on hand instead of silently disappearing.
    if (bankroll !== null) {
      for (const mode of modes) {
        const row = await db
          .prepare("SELECT COUNT(*) AS count FROM wallets WHERE is_simulation = ?")
          .bind(modeValue(mode))
          .first();
        const wallets = Number(row?.count ?? 0);
        const leftover = Math.max(0, round2(bankroll - openingBalance * wallets));
        await setCashReserve(db, mode, leftover);
      }
    }

    return json(await walletPayload(db, simulation));
  } catch (error) {
    return dbError(error);
  }
}
