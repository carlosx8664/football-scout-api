import {
  DB_UNAVAILABLE_MESSAGE,
  MAX_TRANSFER,
  MIN_TRANSFER,
  TRANSFER_STEP,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../shared/wallets.js";

/**
 * POST /api/wallets/recycle
 *
 * Body: `{ simulation?: boolean, fromWalletId: string, toWalletId: string, amount: number }`
 *
 * Moves capital from an overfunded bookie to an underfunded one: one withdrawal and one deposit
 * in the same batch, so the Cash Flow ledger shows the two sides of the transfer and the
 * portfolio total never changes.
 *
 * Like the weekly sweep, this skips the 50–500-per-movement rules' cooldown — it is a single
 * deliberate action, and the dashboard then asks the user to wait 15 minutes before the next arb.
 * The amount itself is still snapped to believable 50 GHS steps.
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

  const fromId = typeof body?.fromWalletId === "string" ? body.fromWalletId : "";
  const toId = typeof body?.toWalletId === "string" ? body.toWalletId : "";
  const amount = round2(Number(body?.amount));

  if (!fromId || !toId) {
    return json({ error: "Both a source and a destination wallet are required." }, 400);
  }
  if (fromId === toId) {
    return json({ error: "Pick two different bookies to recycle between." }, 400);
  }
  if (!Number.isFinite(amount) || amount < MIN_TRANSFER || amount > MAX_TRANSFER) {
    return json(
      {
        error:
          `Keep the move between GHS ${MIN_TRANSFER} and GHS ${MAX_TRANSFER} — ` +
          "bigger jumps stand out.",
      },
      400,
    );
  }
  if (amount % TRANSFER_STEP !== 0) {
    return json({ error: `Use a round figure in steps of GHS ${TRANSFER_STEP}.` }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const { results } = await db
      .prepare(
        "SELECT id, bookie_name, balance FROM wallets WHERE is_simulation = ? AND id IN (?, ?)",
      )
      .bind(mode, fromId, toId)
      .all();

    const from = (results ?? []).find((row) => row.id === fromId);
    const to = (results ?? []).find((row) => row.id === toId);

    if (!from || !to) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `Both wallets must exist in the ${label} ledger.` }, 404);
    }

    const fromBalance = round2(Number(from.balance ?? 0));
    if (fromBalance < amount) {
      return json(
        { error: `${from.bookie_name} only holds GHS ${fromBalance}; cannot move GHS ${amount}.` },
        409,
      );
    }

    await db.batch([
      db
        .prepare("UPDATE wallets SET balance = balance - ? WHERE id = ? AND is_simulation = ?")
        .bind(amount, from.id, mode),
      db
        .prepare("UPDATE wallets SET balance = balance + ? WHERE id = ? AND is_simulation = ?")
        .bind(amount, to.id, mode),
      db
        .prepare(
          `INSERT INTO wallet_transfers (id, wallet_id, bookie_name, kind, amount, is_simulation)
           VALUES (?, ?, ?, 'withdrawal', ?, ?)`,
        )
        .bind(crypto.randomUUID(), from.id, from.bookie_name, amount, mode),
      db
        .prepare(
          `INSERT INTO wallet_transfers (id, wallet_id, bookie_name, kind, amount, is_simulation)
           VALUES (?, ?, ?, 'deposit', ?, ?)`,
        )
        .bind(crypto.randomUUID(), to.id, to.bookie_name, amount, mode),
    ]);

    return json({
      ...(await walletPayload(db, simulation)),
      recycle: {
        amount,
        from: from.bookie_name,
        to: to.bookie_name,
        fromBalance: round2(fromBalance - amount),
        toBalance: round2(Number(to.balance ?? 0) + amount),
      },
    });
  } catch (error) {
    return dbError(error);
  }
}
