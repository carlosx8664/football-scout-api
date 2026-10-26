import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../shared/wallets.js";

/**
 * PATCH /api/wallets/:id
 *
 * Body: `{ balance: number, simulation?: boolean }` to set a new total (deposit/withdrawal
 * logging), or `{ delta: number }` to apply a relative change. The wallet must belong to the
 * requested mode, so an edit made in simulation mode can never touch a real balance.
 */
export async function onRequestPatch({ request, env, params }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const simulation = parseSimulation(
    body?.simulation ?? new URL(request.url).searchParams.get("simulation"),
  );
  const mode = modeValue(simulation);

  const hasBalance = body?.balance !== undefined && body?.balance !== null;
  const hasDelta = body?.delta !== undefined && body?.delta !== null;
  if (!hasBalance && !hasDelta) {
    return json({ error: "Provide `balance` (new total) or `delta` (deposit/withdrawal)." }, 400);
  }

  const amount = Number(hasBalance ? body.balance : body.delta);
  if (!Number.isFinite(amount)) {
    return json({ error: "`balance`/`delta` must be a number." }, 400);
  }
  if (hasBalance && amount < 0) {
    return json({ error: "Balance cannot be negative." }, 400);
  }

  try {
    const current = await db
      .prepare("SELECT balance FROM wallets WHERE id = ? AND is_simulation = ?")
      .bind(id, mode)
      .first();

    if (!current) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} wallet with id "${id}".` }, 404);
    }

    const next = round2(hasBalance ? amount : Number(current.balance ?? 0) + amount);
    if (next < 0) {
      return json(
        { error: `Insufficient balance: only GHS ${round2(Number(current.balance ?? 0))} left.` },
        409,
      );
    }

    await db
      .prepare("UPDATE wallets SET balance = ? WHERE id = ? AND is_simulation = ?")
      .bind(next, id, mode)
      .run();

    const payload = await walletPayload(db, simulation);
    return json({ ...payload, updated: payload.wallets.find((wallet) => wallet.id === id) ?? null });
  } catch (error) {
    return dbError(error);
  }
}
