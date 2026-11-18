import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  loadCashReserve,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../shared/wallets.js";

/**
 * DELETE /api/transfers/:id?simulation=1|0
 *
 * Reverses a capital injection logged by mistake: the `wallet_transfers` row is deleted and the
 * amount is taken back out of the MOMO reserve. Only injections can be reversed — bookie moves
 * and profit withdrawals have both legs to consider — and the reserve must still hold the cash,
 * so an injection already spent on bookies is refused instead of going negative.
 */
export async function onRequestDelete({ request, env, params }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));
  const mode = modeValue(simulation);

  try {
    const transfer = await db
      .prepare(
        `SELECT id, transfer_type, amount FROM wallet_transfers
          WHERE id = ? AND is_simulation = ?`,
      )
      .bind(id, mode)
      .first();

    if (!transfer) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} transfer with id "${id}".` }, 404);
    }

    if ((transfer.transfer_type ?? "BOOKIE_TRANSFER") !== "CAPITAL_INJECTION") {
      return json({ error: "Only capital injections can be reversed." }, 409);
    }

    const amount = round2(Number(transfer.amount));
    const reserve = await loadCashReserve(db, simulation);
    if (reserve + 0.0001 < amount) {
      return json(
        {
          error:
            `MOMO only holds ${round2(reserve)} of this ${amount} injection — the rest has ` +
            "already moved to bookies. Recycle it back to MOMO first.",
        },
        409,
      );
    }

    const nextReserve = round2(reserve - amount);

    await db.batch([
      db
        .prepare("DELETE FROM wallet_transfers WHERE id = ? AND is_simulation = ?")
        .bind(id, mode),
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

    return json({
      ...(await walletPayload(db, simulation)),
      reversed: { id, amount, reserve: nextReserve },
    });
  } catch (error) {
    return dbError(error);
  }
}
