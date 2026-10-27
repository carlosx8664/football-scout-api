import {
  DB_UNAVAILABLE_MESSAGE,
  MAX_TRANSFER,
  MIN_TRANSFER,
  TRANSFER_COOLDOWN_MS,
  TRANSFER_STEP,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../../shared/wallets.js";

/**
 * POST /api/wallets/:id/transfers
 *
 * Body: `{ kind: "deposit" | "withdrawal", amount: number, simulation?: boolean }`
 *
 * Logs a human-looking cash movement: the amount must be a round multiple of 50 between 50 and
 * 500, and one movement per bookie is allowed every 10 minutes, so a burst can never look like
 * an automated bot. The balance update and the ledger row are written as one batch.
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

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: "`amount` must be a positive number." }, 400);
  }
  if (amount < MIN_TRANSFER || amount > MAX_TRANSFER) {
    return json(
      {
        error:
          `Keep transfers between GHS ${MIN_TRANSFER} and GHS ${MAX_TRANSFER} — ` +
          "bigger or smaller amounts stand out.",
      },
      400,
    );
  }
  if (amount % TRANSFER_STEP !== 0) {
    return json(
      { error: `Use a round figure in steps of GHS ${TRANSFER_STEP} (e.g. 50, 100, 150).` },
      400,
    );
  }

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
          error: `${wallet.bookie_name} only holds GHS ${balance}; cannot withdraw GHS ${amount}.`,
        },
        409,
      );
    }

    // Spacing guard: repeat movements in quick succession are the main bot signal.
    const last = await db
      .prepare(
        `SELECT created_at FROM wallet_transfers
          WHERE is_simulation = ? AND bookie_name = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(mode, wallet.bookie_name)
      .first();

    if (last?.created_at) {
      const elapsed = Date.now() - Date.parse(last.created_at);
      if (Number.isFinite(elapsed) && elapsed < TRANSFER_COOLDOWN_MS) {
        const minutes = Math.ceil((TRANSFER_COOLDOWN_MS - elapsed) / 60_000);
        return json(
          {
            error:
              `Space out transfers to ${wallet.bookie_name}: try again in about ${minutes} ` +
              "minute(s) so the activity looks natural.",
          },
          429,
        );
      }
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
