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
  const totalStake = round2(Number(bet.bookie_a_stake) + Number(bet.bookie_b_stake));
  const credits = [];

  if (outcome === "win") {
    const side = body?.winner;
    if (side !== "a" && side !== "b") return { error: '`winner` must be "a" or "b".' };

    const won = legOf(bet, side);
    const payout = round2(won.stake * won.odds);
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
          { bookie: a.bookie, amount: a.stake },
          { bookie: b.bookie, amount: b.stake },
        ],
        winningBookie: null,
        netProfit: 0,
        settlementType: "void",
      };
    }

    const voidedLeg = legOf(bet, voided);
    const liveLeg = legOf(bet, voided === "a" ? "b" : "a");
    const refund = [{ bookie: voidedLeg.bookie, amount: voidedLeg.stake }];
    const remaining = body?.remaining;

    if (remaining === "lost") {
      return {
        credits: refund,
        winningBookie: null,
        netProfit: round2(voidedLeg.stake - totalStake),
        settlementType: "void",
      };
    }

    if (remaining === "won") {
      const payout = round2(liveLeg.stake * liveLeg.odds);
      return {
        credits: [...refund, { bookie: liveLeg.bookie, amount: payout }],
        winningBookie: liveLeg.bookie,
        netProfit: round2(voidedLeg.stake + payout - totalStake),
        settlementType: "void",
      };
    }

    if (remaining === "cashed") {
      const amount = amountFrom(body?.cashOutAmount);
      if (amount === null) return { error: "`cashOutAmount` must be a valid amount." };

      return {
        credits: [...refund, { bookie: liveLeg.bookie, amount }],
        winningBookie: liveLeg.bookie,
        netProfit: round2(voidedLeg.stake + amount - totalStake),
        settlementType: "void",
      };
    }

    return { error: '`remaining` must be "won", "lost" or "cashed".' };
  }

  return { error: '`outcome` must be "win", "void" or "cashout".' };
}

/**
 * POST /api/active-bets/:id/settle
 *
 * Body: `{ outcome: "win" | "void" | "cashout", … , simulation?: boolean }`.
 *   - win:     `{ winner: "a" | "b" }` → pays the winning bookie `stake × odds`.
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

    const totalStake = round2(Number(bet.bookie_a_stake) + Number(bet.bookie_b_stake));

    // Every credited bookie needs a wallet in this mode, otherwise the move would silently no-op.
    const bookies = [...new Set(plan.credits.map((credit) => credit.bookie))];
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
             bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake, total_stake
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ),
      db
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
