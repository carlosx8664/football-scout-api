import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  loadCashReserve,
  loadWallets,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../shared/wallets.js";

/** POST /api/wallets/capital-injection — add external capital to MOMO without touching history. */
export async function onRequestPost({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const amount = round2(Number(body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "Enter an amount greater than 0." }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const wallets = await loadWallets(db, simulation);
    const ledgerWallet = wallets[0];
    if (!ledgerWallet) {
      return json({ error: "No wallet is available for this capital injection." }, 409);
    }

    const reserve = await loadCashReserve(db, simulation);
    const nextReserve = round2(reserve + amount);

    await db.batch([
      db
        .prepare(
          `INSERT INTO wallet_transfers
             (id, wallet_id, bookie_name, kind, transfer_type, amount, is_simulation)
           VALUES (?, ?, 'MOMO', 'deposit', 'CAPITAL_INJECTION', ?, ?)`,
        )
        .bind(crypto.randomUUID(), ledgerWallet.id, amount, mode),
      db
        .prepare(
          `INSERT INTO cash_reserve (is_simulation, balance, updated_at)
           VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
           ON CONFLICT (is_simulation) DO UPDATE SET
             balance = excluded.balance,
             updated_at = excluded.updated_at`,
        )
        .bind(mode, nextReserve),
    ]);

    return json(
      {
        ...(await walletPayload(db, simulation)),
        capitalInjection: { amount, reserve: nextReserve },
      },
      201,
    );
  } catch (error) {
    return dbError(error);
  }
}
