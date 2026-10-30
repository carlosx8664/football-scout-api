import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  loadCashReserve,
  modeValue,
  parseSimulation,
  round2,
  setCashReserve,
  walletPayload,
} from "../../../../shared/wallets.js";

/**
 * POST /api/wallets/:id/transfers
 *
 * Body: `{ kind: "deposit" | "withdrawal", amount: number, momo?: number, simulation?: boolean }`
 *
 * Logs a cash movement with no amount cap and no rate limit: a top-up is limited only by the Momo
 * reserve it draws from, and a withdrawal by the bookie balance it leaves. The balance update and
 * the ledger row are written as one batch, and the Momo cash reserve moves the other way (a
 * top-up subtracts from it, a withdrawal adds to it).
 */
export async function onRequestPost({ request, env, params }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const kind = body?.kind;
  if (kind !== "deposit" && kind !== "withdrawal") {
    return json({ error: '`kind` must be "deposit" or "withdrawal".' }, 400);
  }

  const amount = round2(Number(body?.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "Enter an amount greater than 0." }, 400);
  }

  // The Momo figure the client is showing: the plan leftover plus whatever has been withdrawn.
  const requestedMomo = Number(body?.momo);
  const momoBefore =
    Number.isFinite(requestedMomo) && requestedMomo >= 0 ? round2(requestedMomo) : null;

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const wallet = await db
      .prepare("SELECT id, bookie_name, balance FROM wallets WHERE id = ? AND is_simulation = ?")
      .bind(id, mode)
      .first();

    if (!wallet) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} wallet with id "${id}".` }, 404);
    }

    const balance = round2(Number(wallet.balance ?? 0));
    if (kind === "withdrawal" && balance < amount) {
      return json(
        {
          error: `${wallet.bookie_name} only holds ${balance}; cannot withdraw ${amount}.`,
        },
        409,
      );
    }

    /**
     * A top-up can only spend money that is sitting in Momo (plan leftover + withdrawn cash), so
     * the client's displayed total gates the amount while the stored reserve is what moves.
     */
    const stored = await loadCashReserve(db, simulation);
    const available = momoBefore ?? stored;
    if (kind === "deposit" && amount > available) {
      return json(
        {
          error:
            `Not enough cash in the reserves: Momo holds ${round2(available)}, ` +
            `so you cannot top up ${amount}.`,
        },
        409,
      );
    }

    const delta = kind === "deposit" ? amount : -amount;

    await db.batch([
      db
        .prepare("UPDATE wallets SET balance = balance + ? WHERE id = ? AND is_simulation = ?")
        .bind(delta, id, mode),
      db
        .prepare(
          `INSERT INTO wallet_transfers (id, wallet_id, bookie_name, kind, amount, is_simulation)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), id, wallet.bookie_name, kind, amount, mode),
    ]);

    // The money comes out of the Momo pot on a top-up and lands back in it on a withdrawal, on
    // top of whatever was already there.
    const nextReserve = Math.max(0, round2(stored - delta));
    await setCashReserve(db, simulation, nextReserve);

    const payload = await walletPayload(db, simulation);
    return json(
      {
        ...payload,
        transfer: {
          bookie: wallet.bookie_name,
          kind,
          amount,
          balance: round2(balance + delta),
        },
      },
      201,
    );
  } catch (error) {
    return dbError(error);
  }
}
