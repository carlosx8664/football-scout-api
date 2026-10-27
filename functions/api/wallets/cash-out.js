import {
  DB_UNAVAILABLE_MESSAGE,
  TRANSFER_STEP,
  dbError,
  ensureWallets,
  getDb,
  json,
  loadCashReserve,
  modeValue,
  parseSimulation,
  round2,
  setCashReserve,
  walletPayload,
} from "../../../shared/wallets.js";

/**
 * POST /api/wallets/cash-out
 *
 * Body: `{ simulation?: boolean, baseTarget: number }`
 *
 * "Withdraw weekly profits": every bookie keeps `baseTarget` (the plan's opening deposit) and
 * whatever it holds above that is withdrawn to the mobile-money wallet, rounded down to a
 * multiple of 50. A 1,750 balance against a 1,650 base withdraws 100 and leaves exactly 1,650.
 *
 * This deliberately skips the per-transfer 50–500 cap and the 10-minute cooldown that guard the
 * manual buttons: one deliberate weekly sweep across several bookies is not a bot pattern.
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

  const baseTarget = Number(body?.baseTarget);
  if (!Number.isFinite(baseTarget) || baseTarget <= 0) {
    return json(
      { error: "`baseTarget` must be the per-bookie deposit you want to keep (e.g. 1650)." },
      400,
    );
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    await ensureWallets(db, simulation);

    const { results } = await db
      .prepare("SELECT id, bookie_name, balance FROM wallets WHERE is_simulation = ?")
      .bind(mode)
      .all();

    const withdrawals = [];
    for (const row of results ?? []) {
      const balance = round2(Number(row.balance ?? 0));
      const excess = round2(balance - baseTarget);
      // Only whole 50s come out, so the sweep never leaves an odd remainder behind.
      const amount = Math.floor(excess / TRANSFER_STEP) * TRANSFER_STEP;
      if (amount >= TRANSFER_STEP) {
        withdrawals.push({ id: row.id, bookie: row.bookie_name, amount });
      }
    }

    if (withdrawals.length === 0) {
      return json({
        ...(await walletPayload(db, simulation)),
        cashOut: { total: 0, bookies: [], reserve: await loadCashReserve(db, simulation) },
      });
    }

    const total = round2(withdrawals.reduce((sum, entry) => sum + entry.amount, 0));
    const statements = [];

    for (const entry of withdrawals) {
      statements.push(
        db
          .prepare("UPDATE wallets SET balance = balance - ? WHERE id = ? AND is_simulation = ?")
          .bind(entry.amount, entry.id, mode),
        db
          .prepare(
            `INSERT INTO wallet_transfers
               (id, wallet_id, bookie_name, kind, amount, is_simulation)
             VALUES (?, ?, ?, 'withdrawal', ?, ?)`,
          )
          .bind(crypto.randomUUID(), entry.id, entry.bookie, entry.amount, mode),
      );
    }

    await db.batch(statements);

    // The swept cash lands in the mobile-money pot, so it never vanishes from the dashboard.
    const reserve = await setCashReserve(
      db,
      simulation,
      (await loadCashReserve(db, simulation)) + total,
    );

    return json({
      ...(await walletPayload(db, simulation)),
      cashOut: {
        total,
        bookies: withdrawals.map(({ bookie, amount }) => ({ bookie, amount })),
        reserve,
      },
    });
  } catch (error) {
    return dbError(error);
  }
}
