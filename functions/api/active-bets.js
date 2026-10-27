import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../shared/wallets.js";

/** Anything beyond this is almost certainly a typo, and liquidity is derived from stakes. */
const MAX_STAKE = 1_000_000;

function toActiveBet(row) {
  return {
    id: row.id,
    eventName: row.event_name,
    legA: {
      name: row.bookie_a_name,
      odds: round2(Number(row.bookie_a_odds)),
      stake: round2(Number(row.bookie_a_stake)),
    },
    legB: {
      name: row.bookie_b_name,
      odds: round2(Number(row.bookie_b_odds)),
      stake: round2(Number(row.bookie_b_stake)),
    },
    profitPercent: round2(Number(row.profit_percent)),
    createdAt: row.created_at ?? null,
    /** Epoch ms from the arb feed; null for bets logged before kickoff was stored. */
    kickoff: Number.isFinite(Number(row.kickoff)) ? Number(row.kickoff) : null,
    isSimulation: row.is_simulation === 1,
  };
}

/** GET /api/active-bets?simulation=1 — every unsettled bet in the requested mode. */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));

  try {
    const { results } = await db
      .prepare(
        `SELECT id, event_name,
                bookie_a_name, bookie_a_odds, bookie_a_stake,
                bookie_b_name, bookie_b_odds, bookie_b_stake,
                profit_percent, is_simulation, created_at, kickoff
           FROM active_bets
          WHERE is_simulation = ?
          ORDER BY created_at DESC`,
      )
      .bind(modeValue(simulation))
      .all();

    return json({ simulation, activeBets: (results ?? []).map(toActiveBet) });
  } catch (error) {
    return dbError(error);
  }
}

/**
 * POST /api/active-bets
 *
 * Logs one two-leg arb into `active_bets` and immediately debits both stakes from the matching
 * bookie wallets — the money has left the account, so balances always show real cash on hand.
 * The client sends the (possibly hand-rounded) stakes; `profit_percent` is recomputed here from
 * the stakes and prices. `is_simulation` follows the current UI mode. The debits and the insert
 * run as one D1 batch, so a bet can never exist without its stakes having been taken.
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

  const eventName = typeof body?.eventName === "string" ? body.eventName.trim() : "";
  if (!eventName || eventName.length > 200) {
    return json({ error: "`eventName` is required (max 200 characters)." }, 400);
  }

  const rawLegs = Array.isArray(body?.legs) ? body.legs : [];
  if (rawLegs.length !== 2) {
    return json({ error: "An arb needs exactly two legs." }, 400);
  }

  const legs = [];
  for (const raw of rawLegs) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const odds = Number(raw?.odds);
    const stake = Number(raw?.stake);

    if (!name) return json({ error: "Every leg needs a bookmaker name." }, 400);
    if (!Number.isFinite(odds) || odds <= 1) {
      return json({ error: `${name}: odds must be greater than 1.` }, 400);
    }
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) {
      return json({ error: `${name}: stake must be between 0 and ${MAX_STAKE}.` }, 400);
    }

    legs.push({ name, odds: round2(odds), stake: round2(stake) });
  }

  const [legA, legB] = legs;
  const total = round2(legA.stake + legB.stake);
  const worstPayout = Math.min(legA.stake * legA.odds, legB.stake * legB.odds);
  const profitPercent = round2(((worstPayout - total) / total) * 100);
  const simulation = parseSimulation(body?.simulation);
  const id = crypto.randomUUID();
  // Kickoff comes from the arb feed so the card can show when the match starts.
  const kickoff = Number(body?.kickoff);
  const kickoffValue = Number.isFinite(kickoff) && kickoff > 0 ? Math.round(kickoff) : null;

  try {
    // A bookie can appear on both legs; group the stakes before checking the balance.
    const required = new Map();
    for (const leg of legs) {
      required.set(leg.name, round2((required.get(leg.name) ?? 0) + leg.stake));
    }

    const { results } = await db
      .prepare(
        `SELECT bookie_name, balance FROM wallets
          WHERE is_simulation = ? AND bookie_name IN (?, ?)`,
      )
      .bind(modeValue(simulation), legA.name, legB.name)
      .all();

    const balances = new Map(
      (results ?? []).map((row) => [row.bookie_name, Number(row.balance)]),
    );

    for (const [name, stake] of required) {
      const balance = balances.get(name);
      if (balance === undefined) {
        return json(
          { error: `Missing ${simulation ? "simulation" : "real"} wallet for ${name}.` },
          409,
        );
      }
      if (balance < stake) {
        return json(
          {
            error:
              `${name} only holds GHS ${round2(balance)} but the stake is GHS ` +
              `${round2(stake)}. Top the wallet up first.`,
          },
          409,
        );
      }
    }

    await db.batch([
      ...legs.map((leg) =>
        db
          .prepare(
            "UPDATE wallets SET balance = balance - ? WHERE bookie_name = ? AND is_simulation = ?",
          )
          .bind(leg.stake, leg.name, modeValue(simulation)),
      ),
      db
        .prepare(
          `INSERT INTO active_bets (
             id, event_name,
             bookie_a_name, bookie_a_odds, bookie_a_stake,
             bookie_b_name, bookie_b_odds, bookie_b_stake,
             profit_percent, is_simulation, kickoff
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          eventName,
          legA.name,
          legA.odds,
          legA.stake,
          legB.name,
          legB.odds,
          legB.stake,
          profitPercent,
          modeValue(simulation),
          kickoffValue,
        ),
    ]);

    return json(
      {
        id,
        eventName,
        profitPercent,
        totalStake: total,
        kickoff: kickoffValue,
        simulation,
        legs: [
          { name: legA.name, odds: legA.odds, stake: legA.stake },
          { name: legB.name, odds: legB.odds, stake: legB.stake },
        ],
      },
      201,
    );
  } catch (error) {
    return dbError(error);
  }
}
