import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../../../shared/wallets.js";

/**
 * POST /api/active-bets/:id/settle
 *
 * Body: `{ winner: "a" | "b", simulation?: boolean }`.
 *
 * Both stakes were debited when the arb was logged, so settlement only credits the winning
 * bookie with `winningStake * winningOdds`, records the arb's net profit in `history` and removes
 * the row from `active_bets`. All three statements run as one D1 batch, so a failure leaves the
 * ledger intact.
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

  const winner = body?.winner;
  if (winner !== "a" && winner !== "b") {
    return json({ error: '`winner` must be "a" or "b".' }, 400);
  }

  const simulation = parseSimulation(body?.simulation);
  const mode = modeValue(simulation);

  try {
    const bet = await db
      .prepare("SELECT * FROM active_bets WHERE id = ? AND is_simulation = ?")
      .bind(id, mode)
      .first();

    if (!bet) {
      const label = simulation ? "simulation" : "real";
      return json({ error: `No ${label} active bet with id "${id}".` }, 404);
    }

    const aWins = winner === "a";
    const winningBookie = aWins ? bet.bookie_a_name : bet.bookie_b_name;
    const winningStake = Number(aWins ? bet.bookie_a_stake : bet.bookie_b_stake);
    const winningOdds = Number(aWins ? bet.bookie_a_odds : bet.bookie_b_odds);
    const losingBookie = aWins ? bet.bookie_b_name : bet.bookie_a_name;

    const payout = round2(winningStake * winningOdds);
    const totalStake = round2(Number(bet.bookie_a_stake) + Number(bet.bookie_b_stake));
    const netProfit = round2(payout - totalStake);
    const historyId = crypto.randomUUID();

    // The losing stake is already gone (debited at placement); only the payout moves now.
    const winningWallet = await db
      .prepare("SELECT balance FROM wallets WHERE bookie_name = ? AND is_simulation = ?")
      .bind(winningBookie, mode)
      .first();

    if (!winningWallet) {
      return json(
        { error: `Missing ${simulation ? "simulation" : "real"} wallet for ${winningBookie}.` },
        409,
      );
    }

    await db.batch([
      db
        .prepare(
          "UPDATE wallets SET balance = balance + ? WHERE bookie_name = ? AND is_simulation = ?",
        )
        .bind(payout, winningBookie, mode),
      db
        .prepare(
          `INSERT INTO history (
             id, event_name, winning_bookie, net_profit, is_simulation,
             bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake, total_stake
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          historyId,
          bet.event_name,
          winningBookie,
          netProfit,
          mode,
          bet.bookie_a_name,
          Number(bet.bookie_a_stake),
          bet.bookie_b_name,
          Number(bet.bookie_b_stake),
          totalStake,
        ),
      db
        .prepare("DELETE FROM active_bets WHERE id = ? AND is_simulation = ?")
        .bind(id, mode),
    ]);

    return json({
      id: historyId,
      eventName: bet.event_name,
      winningBookie,
      losingBookie,
      payout,
      netProfit,
      simulation,
    });
  } catch (error) {
    return dbError(error);
  }
}
