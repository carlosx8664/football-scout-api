import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  ensureWallets,
  getDb,
  json,
  loadLockedByBookie,
  modeValue,
  parseSimulation,
  round2,
  walletPayload,
} from "../../../shared/wallets.js";

/** Money is compared in cents so a hand-typed amount cannot drift by a float ulp. */
const cents = (value) => Math.round(Number(value) * 100);

/**
 * POST /api/wallets/cash-out
 *
 * Body: `{ simulation?: boolean, allocations: [{ walletId, amount }], bankroll?: number }`
 *
 * Takes realised profit out of individual bookie wallets. Three rules gate every amount:
 * - a bookie can only give up `balance - locked`, where `locked` is the cash still at risk in its
 *   unsettled bets;
 * - the whole sweep cannot exceed `SUM(history.net_profit)` for the mode;
 * - the cash left in the wallets must stay at or above the bankroll, so a profit take can never
 *   gut the float the plan is sized against.
 *
 * The money leaves the system (it is profit banked elsewhere), so the Momo reserve and the
 * bankroll plan are untouched. Each draw is logged as a `PROFIT_TAKE` withdrawal in the cash-flow
 * ledger, which is what keeps the ledger and the wallet balances in step.
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

  const rawAllocations = Array.isArray(body?.allocations) ? body.allocations : [];
  if (rawAllocations.length === 0) {
    return json({ error: "Pick at least one bookie to withdraw from." }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);
  const bankroll = Math.max(0, round2(Number(body?.bankroll) || 0));

  try {
    await ensureWallets(db, simulation);

    const { results } = await db
      .prepare("SELECT id, bookie_name, balance FROM wallets WHERE is_simulation = ?")
      .bind(mode)
      .all();

    const wallets = results ?? [];
    const lockedByBookie = new Map(
      (await loadLockedByBookie(db, simulation)).map((entry) => [
        String(entry.bookie).toLowerCase(),
        entry.locked,
      ]),
    );

    const withdrawals = [];
    for (const raw of rawAllocations) {
      const walletId = typeof raw?.walletId === "string" ? raw.walletId : "";
      const amount = round2(Number(raw?.amount));
      if (!Number.isFinite(amount) || amount <= 0) {
        return json({ error: "Every withdrawal amount must be greater than 0." }, 400);
      }

      const wallet = wallets.find((row) => row.id === walletId);
      if (!wallet) {
        const label = simulation ? "simulation" : "real";
        return json({ error: `No ${label} wallet with id "${walletId}".` }, 404);
      }

      const balance = round2(Number(wallet.balance ?? 0));
      const locked = round2(lockedByBookie.get(String(wallet.bookie_name).toLowerCase()) ?? 0);
      const available = round2(Math.max(0, balance - locked));

      if (amount > available + 0.0001) {
        return json(
          {
            error:
              `${wallet.bookie_name} can only release ${available} — it holds ${balance} ` +
              `with ${locked} still locked in active bets.`,
          },
          409,
        );
      }

      withdrawals.push({
        id: walletId,
        bookie: wallet.bookie_name,
        amount,
      });
    }

    const total = round2(withdrawals.reduce((sum, entry) => sum + entry.amount, 0));

    const profit = await db
      .prepare(
        "SELECT COALESCE(SUM(net_profit), 0) AS total FROM history WHERE is_simulation = ?",
      )
      .bind(mode)
      .first();
    const taken = await db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM wallet_transfers
          WHERE is_simulation = ? AND transfer_type = 'PROFIT_TAKE'`,
      )
      .bind(mode)
      .first();
    // Profit already banked cannot be taken twice, so the cap is what is left of it.
    const withdrawable = round2(
      Number(profit?.total ?? 0) - Number(taken?.total ?? 0),
    );
    if (cents(total) > cents(withdrawable)) {
      return json(
        {
          error:
            `You can only withdraw up to the available profit of ${withdrawable}, ` +
            `and this would take ${total}.`,
        },
        409,
      );
    }

    const cashInWallets = round2(
      wallets.reduce((sum, row) => sum + round2(Number(row.balance ?? 0)), 0),
    );
    const portfolioAfter = round2(cashInWallets - total);
    if (portfolioAfter < bankroll) {
      return json(
        {
          error:
            `This would leave ${portfolioAfter} in the wallets, below the ${bankroll} bankroll. ` +
            "Withdraw less so the portfolio never drops under the plan.",
        },
        409,
      );
    }

    const statements = [];
    for (const entry of withdrawals) {
      statements.push(
        db
          .prepare("UPDATE wallets SET balance = balance - ? WHERE id = ? AND is_simulation = ?")
          .bind(entry.amount, entry.id, mode),
        db
          .prepare(
            `INSERT INTO wallet_transfers
               (id, wallet_id, bookie_name, kind, transfer_type, amount, is_simulation)
             VALUES (?, ?, ?, 'withdrawal', 'PROFIT_TAKE', ?, ?)`,
          )
          .bind(crypto.randomUUID(), entry.id, entry.bookie, entry.amount, mode),
      );
    }

    await db.batch(statements);

    return json({
      ...(await walletPayload(db, simulation)),
      cashOut: {
        total,
        bookies: withdrawals.map(({ bookie, amount }) => ({ bookie, amount })),
        portfolio: portfolioAfter,
      },
    });
  } catch (error) {
    return dbError(error);
  }
}
