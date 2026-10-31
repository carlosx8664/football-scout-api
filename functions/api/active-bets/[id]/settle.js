import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../../../shared/wallets.js";

const MAX_AMOUNT = 1_000_000;

const legOf = (bet, side) =>
  side === "a"
    ? {
        bookie: bet.bookie_a_name,
        stake: Number(bet.bookie_a_stake),
        odds: Number(bet.bookie_a_odds),
      }
    : {
        bookie: bet.bookie_b_name,
        stake: Number(bet.bookie_b_stake),
        odds: Number(bet.bookie_b_odds),
      };

function amountFrom(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_AMOUNT ? round2(amount) : null;
}

/**
 * Turns a settlement request into wallet credits, the winning bookie and the net profit.
 *
 * Stakes left the wallets at placement, so only *credits* are returned here: a normal win pays
 * `stake × odds`, a void refunds the cancelled stake(s), and a cash out returns the manual
 * amount. `netProfit` is always credits − total outlay.
 */
function planSettlement(bet, outcome, body) {
  // A free bet's leg A never left the wallet, so only real stakes count as outlay/refunds.
  const freeA = Number(bet.is_free_bet) === 1 || bet.kind === "free";
  const stakeOf = (side) => {
    const leg = legOf(bet, side);
    return freeA && side === "a" ? 0 : leg.stake;
  };
  const totalStake = round2(stakeOf("a") + stakeOf("b"));
  const credits = [];

  if (outcome === "loss") {
    // Mug bets: the acca lost, so nothing is credited back — only the history row is written.
    return {
      credits: [],
      winningBookie: null,
      netProfit: round2(-totalStake),
      settlementType: "loss",
    };
  }

  if (outcome === "win") {
    const side = body?.winner;
    if (side !== "a" && side !== "b") return { error: '`winner` must be "a" or "b".' };

    const won = legOf(bet, side);
    // A muggy acca's return is whatever the bookie actually paid, not stake × odds.
    const manual = body?.payoutAmount === undefined ? null : amountFrom(body.payoutAmount);
    if (body?.payoutAmount !== undefined && manual === null) {
      return { error: "`payoutAmount` must be a valid amount." };
    }
    const payout = manual === null ? round2(won.stake * won.odds) : manual;
    return {
      credits: [{ bookie: won.bookie, amount: payout }],
      winningBookie: won.bookie,
      netProfit: round2(payout - totalStake),
      settlementType: "win",
    };
  }

  if (outcome === "cashout") {
    const side = body?.winner;
    if (side !== "a" && side !== "b") {
      return { error: '`winner` must name the bookie you cashed out on.' };
    }

    const amount = amountFrom(body?.cashOutAmount);
    if (amount === null) return { error: "`cashOutAmount` must be a valid amount." };

    const cashed = legOf(bet, side);
    return {
      credits: [{ bookie: cashed.bookie, amount }],
      winningBookie: cashed.bookie,
      netProfit: round2(amount - totalStake),
      settlementType: "cashout",
    };
  }

  if (outcome === "void") {
    const voided = body?.voided;
    if (voided !== "a" && voided !== "b" && voided !== "both") {
      return { error: '`voided` must be "a", "b" or "both".' };
    }

    if (voided === "both") {
      const a = legOf(bet, "a");
      const b = legOf(bet, "b");
      return {
        credits: [
          { bookie: a.bookie, amount: stakeOf("a") },
          { bookie: b.bookie, amount: stakeOf("b") },
        ].filter((credit) => credit.amount > 0),
        winningBookie: null,
        netProfit: 0,
        settlementType: "void",
      };
    }

    const voidedLeg = legOf(bet, voided);
    const liveLeg = legOf(bet, voided === "a" ? "b" : "a");
    const refundAmount = stakeOf(voided);
    const refund = refundAmount > 0 ? [{ bookie: voidedLeg.bookie, amount: refundAmount }] : [];
    const remaining = body?.remaining;

    if (remaining === "lost") {
      return {
        credits: refund,
        winningBookie: null,
        netProfit: round2(refundAmount - totalStake),
        settlementType: "void",
      };
    }

    if (remaining === "won") {
      const payout = round2(liveLeg.stake * liveLeg.odds);
      return {
        credits: [...refund, { bookie: liveLeg.bookie, amount: payout }],
        winningBookie: liveLeg.bookie,
        netProfit: round2(refundAmount + payout - totalStake),
        settlementType: "void",
      };
    }

    if (remaining === "cashed") {
      const amount = amountFrom(body?.cashOutAmount);
      if (amount === null) return { error: "`cashOutAmount` must be a valid amount." };

      return {
        credits: [...refund, { bookie: liveLeg.bookie, amount }],
        winningBookie: liveLeg.bookie,
        netProfit: round2(refundAmount + amount - totalStake),
        settlementType: "void",
      };
    }

    return { error: '`remaining` must be "won", "lost" or "cashed".' };
  }

  return { error: '`outcome` must be "win", "loss", "void" or "cashout".' };
}

/**
 * POST /api/active-bets/:id/settle
 *
 * Body: `{ outcome: "win" | "loss" | "void" | "cashout", … , simulation?: boolean }`.
 *   - win:     `{ winner: "a" | "b", payoutAmount?: number }` → pays the winning bookie
 *              `stake × odds`, or `payoutAmount` when given (muggy accas, where the return is
 *              whatever the bookie actually paid).
 *   - loss:    `{}` → nothing is credited; the stakes are already gone, so only the `history`
 *              row records the loss.
 *   - void:    `{ voided: "a" | "b" | "both", remaining?: "won" | "lost" | "cashed",
 *                 cashOutAmount?: number }` → refunds the cancelled stake(s), then applies what
 *                 happened to the live leg.
 *   - cashout: `{ winner: "a" | "b", cashOutAmount: number }` → credits the manual cash out.
 *
 * The credits, the `history` row and the `active_bets` delete run as one D1 batch, so a failure
 * leaves the ledger intact.
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

    const plan = planSettlement(bet, body?.outcome ?? "win", body);
    if (plan.error) return json({ error: plan.error }, 400);

    const totalStake = round2(
      (Number(bet.is_free_bet) === 1 || bet.kind === "free" ? 0 : Number(bet.bookie_a_stake)) +
        Number(bet.bookie_b_stake),
    );

    // Every credited bookie needs a wallet in this mode, otherwise the move would silently no-op.
    const bookies = [...new Set(plan.credits.map((credit) => credit.bookie))];

    if (bookies.length > 0) {
      const wallets = await db
        .prepare(
          `SELECT bookie_name FROM wallets
          WHERE is_simulation = ? AND bookie_name IN (${bookies.map(() => "?").join(", ")})`,
        )
        .bind(mode, ...bookies)
        .all();

      const found = new Set((wallets.results ?? []).map((row) => row.bookie_name));
      const missing = bookies.find((bookie) => !found.has(bookie));
      if (missing) {
        return json(
          { error: `Missing ${simulation ? "simulation" : "real"} wallet for ${missing}.` },
          409,
        );
      }
    }

    const historyId = crypto.randomUUID();

    await db.batch([
      ...plan.credits.map((credit) =>
        db
          .prepare(
            "UPDATE wallets SET balance = balance + ? WHERE bookie_name = ? AND is_simulation = ?",
          )
          .bind(credit.amount, credit.bookie, mode),
      ),
      db
        .prepare(
          `INSERT INTO history (
             id, event_name, winning_bookie, net_profit, is_simulation, settlement_type,
             bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake, total_stake, kind,
             is_free_bet, logged_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          historyId,
          bet.event_name,
          plan.winningBookie,
          plan.netProfit,
          mode,
          plan.settlementType,
          bet.bookie_a_name,
          Number(bet.bookie_a_stake),
          bet.bookie_b_name,
          Number(bet.bookie_b_stake),
          totalStake,
          bet.kind ?? "arb",
          Number(bet.is_free_bet) === 1 ? 1 : 0,
          // When the bet was placed, so the daily mug gate never mistakes a late settlement
          // for a fresh mug bet.
          bet.created_at ?? null,
        ),      db
        .prepare("DELETE FROM active_bets WHERE id = ? AND is_simulation = ?")
        .bind(id, mode),
    ]);

    return json({
      id: historyId,
      eventName: bet.event_name,
      settlementType: plan.settlementType,
      winningBookie: plan.winningBookie,
      credits: plan.credits,
      netProfit: plan.netProfit,
      simulation,
    });
  } catch (error) {
    return dbError(error);
  }
}
