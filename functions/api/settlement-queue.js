import {
  DB_UNAVAILABLE_MESSAGE,
  dbError,
  getDb,
  json,
  modeValue,
  parseSimulation,
} from "../../shared/wallets.js";

const KV_BINDING = "FOOTBALL_DATA";
const LIVE_KEY = "feed-live-scores";

/**
 * GET /api/settlement-queue?simulation=1
 *
 * Joins the finished matches the live-scores Worker resolved against the unsettled bets in the
 * requested mode. Only bets that stored their Sportradar id can match; everything else stays
 * manual in the ledger.
 */
export async function onRequestGet({ request, env }) {
  const db = getDb(env);
  if (!db) return json({ error: DB_UNAVAILABLE_MESSAGE }, 503);

  const simulation = parseSimulation(new URL(request.url).searchParams.get("simulation"));

  let finished = [];
  try {
    const raw = env?.[KV_BINDING] ? await env[KV_BINDING].get(LIVE_KEY) : null;
    if (raw) {
      const body = JSON.parse(raw);
      if (Array.isArray(body?.finished)) finished = body.finished;
    }
  } catch {
    // A malformed or missing feed just means "nothing has finished yet".
    finished = [];
  }

  if (finished.length === 0) return json({ simulation, items: [] });

  const byEventId = new Map(
    finished
      .filter((match) => match?.eventId)
      .map((match) => [String(match.eventId), match]),
  );
  const eventIds = [...byEventId.keys()];
  const placeholders = eventIds.map(() => "?").join(", ");

  try {
    const { results } = await db
      .prepare(
        `SELECT id, event_name, sr_event_id
           FROM active_bets
          WHERE is_simulation = ? AND sr_event_id IN (${placeholders})`,
      )
      .bind(modeValue(simulation), ...eventIds)
      .all();

    const items = (results ?? []).map((row) => {
      const match = byEventId.get(String(row.sr_event_id));
      return {
        betId: row.id,
        eventName: row.event_name,
        srEventId: String(row.sr_event_id),
        home: match?.home ?? "",
        away: match?.away ?? "",
        finalScore: match?.score ?? "",
        matchStatus: match?.matchStatus ?? "Ended",
      };
    });

    return json({ simulation, items });
  } catch (error) {
    return dbError(error);
  }
}
