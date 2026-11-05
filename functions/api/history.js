import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
  round2,
} from "../../shared/wallets.js";
import {
  loadMugBets,
  loadMugTotals,
} from "../../shared/mug-bets.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Monday of the current week (UTC), to match SQLite's date() output. */
const WEEK_START = "date('now', '-' || ((strftime('%w', 'now') + 6) % 7) || ' days')";
const MAX_ENTRIES = 500;

/**
 * Which day a settled row belongs to. Arbs follow the match, so a late settlement stays on the
 * day the match was played. Mug bets (and free bets) are logged by hand with no fixture attached,
 * so they always follow the day they were placed (`logged_at`, then `settled_at` as a last resort).
 */
const PLACED_TIME = "CAST(strftime('%s', COALESCE(logged_at, settled_at)) AS INTEGER) * 1000";
const MATCH_TIME_MS = `CASE WHEN COALESCE(kind, 'arb') = 'arb'
  THEN COALESCE(NULLIF(kickoff, 0), ${PLACED_TIME})
  ELSE ${PLACED_TIME}
END`;
const MATCH_DAY = `date((${MATCH_TIME_MS}) / 1000, 'unixepoch')`;

function toEntry(row) {
  const stakeA = row.bookie_a_stake === null ? null : round2(Number(row.bookie_a_stake));
  const stakeB = row.bookie_b_stake === null ? null : round2(Number(row.bookie_b_stake));
  const totalStake =
    row.total_stake !== null ? round2(Number(row.total_stake)) : round2((stakeA ?? 0) + (stakeB ?? 0));

  return {
    id: row.id,
    eventName: row.event_name,
    kind: row.kind ?? "arb",
    winningBookie: row.winning_bookie,
    bookieAName: row.bookie_a_name ?? null,
    bookieBName: row.bookie_b_name ?? null,
    totalStake,
    netProfit: round2(Number(row.net_profit ?? 0)),
    settledAt: row.settled_at,
    /** Grouping day in epoch ms: arb kickoff, or the placed time for mug bets. */
    kickoff: Number(row.kickoff_ms) || null,
    settlementType: row.settlement_type ?? "win",
  };
}

/**
 * GET /api/history?simulation=1&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Settled arbs for one mode, newest first, plus the weekly outlay metric:
 * stakes currently tied up in `active_bets` + stakes settled since Monday.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const url = new URL(request.url);
  const simulation = parseSimulation(url.searchParams.get("simulation"));
  const mode = modeValue(simulation);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if ((from && !DATE_PATTERN.test(from)) || (to && !DATE_PATTERN.test(to))) {
    return json({ error: "`from` and `to` must be YYYY-MM-DD dates." }, 400);
  }

  const where = ["is_simulation = ?"];
  const params = [mode];
  if (from) {
    where.push(`${MATCH_DAY} >= date(?)`);
    params.push(from);
  }
  if (to) {
    where.push(`${MATCH_DAY} <= date(?)`);
    params.push(to);
  }

  try {
    const [entries, totals, mugRows, mugTotals] = await Promise.all([
      db
        .prepare(
          `SELECT id, event_name, winning_bookie, net_profit, settled_at, settlement_type, kind,
                  bookie_a_name, bookie_a_stake, bookie_b_name, bookie_b_stake, total_stake,
                  ${MATCH_TIME_MS} AS kickoff_ms
             FROM history
            WHERE ${where.join(" AND ")}
            ORDER BY ${MATCH_TIME_MS} DESC
            LIMIT ${MAX_ENTRIES}`,
        )
        .bind(...params)
        .all(),
      db
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(bookie_a_stake + bookie_b_stake), 0)
                FROM active_bets WHERE is_simulation = ?) AS active_outlay,
             (SELECT COALESCE(SUM(COALESCE(total_stake, bookie_a_stake + bookie_b_stake, 0)), 0)
                FROM history
               WHERE is_simulation = ? AND settlement_type != 'cancelled'
                 AND date(settled_at) >= ${WEEK_START}) AS history_outlay`,
        )
        .bind(mode, mode)
        .first(),
      loadMugBets(db, simulation, { from, to }, 100),
      loadMugTotals(db, simulation, { from, to }),
    ]);

    const activeOutlay = round2(Number(totals?.active_outlay ?? 0));
    const historyOutlay = round2(Number(totals?.history_outlay ?? 0));

    return json({
      simulation,
      entries: (entries.results ?? []).map(toEntry),
      totals: {
        activeOutlay,
        historyOutlay,
        outlayThisWeek: round2(activeOutlay + historyOutlay),
      },
      // Mug bets sit alongside the arbs, not inside them: `entries` stays pure arbitrage.
      mugBets: mugRows,
      mugTotals,
    });
  } catch (error) {
    return dbError(error);
  }
}
