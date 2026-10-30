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

/**
 * POST /api/wallets/refresh
 *
 * Body: `{ simulation?: boolean, scope?: "mode" | "all", openingBalance?: number, bookies?: string[] }`
 *
 * Wipes the ledger for a clean start: every active bet, settled history row, cash-flow entry and
 * mug bet for the selected mode(s) is removed, and each wallet is set back to `openingBalance`
 * (default 250 GHS). Wallets are re-provisioned first so any bookmaker added since the last
 * refresh gets an account too.
 *
 * When `bookies` is supplied only those wallets are funded and every other wallet is zeroed, so
 * the reset matches the selection in My Wallets. Each funded wallet gets an opening deposit in
 * the cash-flow ledger, and the Momo reserve restarts at 0: the unallocated part of the bankroll
 * is derived from the plan on the client, so storing it here too would count it twice.
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

  // Lower-cased names of the bookies picked in My Wallets; null keeps the legacy "every wallet".
  const requestedBookies = Array.isArray(body?.bookies)
    ? body.bookies.filter((name) => typeof name === "string" && name.trim() !== "")
    : null;
  const selected =
    requestedBookies === null
      ? null
      : new Set(requestedBookies.map((name) => name.toLowerCase().trim()));

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
      );

      if (selected === null) {
        statements.push(
          db
            .prepare("UPDATE wallets SET balance = ? WHERE is_simulation = ?")
            .bind(openingBalance, flag),
        );
      } else {
        // Only the selected bookies share the bankroll; the rest are left empty.
        statements.push(
          db.prepare("UPDATE wallets SET balance = 0 WHERE is_simulation = ?").bind(flag),
        );
        for (const name of selected) {
          statements.push(
            db
              .prepare(
                "UPDATE wallets SET balance = ? WHERE is_simulation = ? AND lower(bookie_name) = ?",
              )
              .bind(openingBalance, flag, name),
          );
        }
      }

      // Initial deposits land in the cash-flow ledger so the opening balances are visible, dated
      // an hour back so they never trip the 10-minute transfer cooldown.
      const rows = await db
        .prepare("SELECT id, bookie_name FROM wallets WHERE is_simulation = ?")
        .bind(flag)
        .all();
      for (const wallet of rows?.results ?? []) {
        const funded =
          selected === null || selected.has(String(wallet.bookie_name).toLowerCase());
        if (!funded || openingBalance <= 0) continue;
        statements.push(
          db
            .prepare(
              `INSERT INTO wallet_transfers
                 (id, wallet_id, bookie_name, kind, amount, is_simulation, created_at)
               VALUES (?, ?, ?, 'deposit', ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))`,
            )
            .bind(crypto.randomUUID(), wallet.id, wallet.bookie_name, openingBalance, flag),
        );
      }
    }

    await db.batch(statements);

    // Momo is derived from the plan on the client (unallocated bankroll) plus the real cash that
    // has moved in and out, so the reserve itself starts empty and only tracks transfers.
    for (const mode of modes) {
      await setCashReserve(db, mode, 0);
    }

    return json(await walletPayload(db, simulation));
  } catch (error) {
    return dbError(error);
  }
}
