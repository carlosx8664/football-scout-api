/**
 * Live score + final result feed for the football-scout dashboard.
 *
 * Runs every minute on a Cloudflare Cron Trigger (the finest granularity Cloudflare offers) and
 * writes one KV key, `feed-live-scores`, that `/api/live-scores` serves to the client:
 *
 *   { generatedAt, liveAt, live: [...], finished: [...] }
 *
 * `live` is the in-play snapshot. `finished` is the set of final scores for matches the user
 * actually has a bet on — `liveOrPrematchEvents` drops a fixture the moment it ends, so a finished
 * match is only recoverable from `factsCenter/event`, which still answers days later.
 *
 * Writes are skipped when nothing changed, so a quiet overnight feed costs almost no KV quota.
 *
 * Deploy: npm run worker:live:deploy
 */

const KV_BINDING = "FOOTBALL_DATA";
const KV_KEY = "feed-live-scores";

const SPORTY_HOST = "https://www.sportybet.com";
const LIVE_URL =
  `${SPORTY_HOST}/api/gh/factsCenter/liveOrPrematchEvents` +
  "?sportId=sr%3Asport%3A1&marketId=1&pageSize=100&pageNum=1";

/** Mirrors scripts/fetch-odds.js: a bare fetch gets geo-resolved to the wrong market. */
const HEADERS = {
  Accept: "*/*",
  Clientid: "web",
  "Current-Country": "GH",
  Operid: "3",
  Platform: "web",
  Referer: "https://www.sportybet.com/gh/sport/football",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
  Cookie: "sb_country=gh; locale=en;",
};

const REQUEST_TIMEOUT_MS = 15_000;
/** A fixture needs to be at least this old before its result is polled. */
const SETTLE_AFTER_MS = 2 * 60 * 60 * 1000;
/** Stop polling results for fixtures older than this; older bets stay manual. */
const SETTLE_WITHIN_MS = 5 * 24 * 60 * 60 * 1000;
const FINISHED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Caps per-run subrequests; a punter rarely has more than a handful of live bets. */
const MAX_EVENT_LOOKUPS = 12;
/**
 * The clock is not stored as data: the client advances it from `serverNow`. A write is only
 * forced this often to re-anchor that clock and prove the Worker is still alive.
 */
const HEARTBEAT_MS = 5 * 60 * 1000;

const EMPTY_STATE = { generatedAt: 0, liveAt: 0, serverNow: 0, live: [], finished: [] };

function tournamentsOf(body) {
  const data = body?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tournaments)) return data.tournaments;
  return [];
}

function eventsOf(body) {
  return tournamentsOf(body).flatMap((tournament) =>
    Array.isArray(tournament?.events) ? tournament.events : [],
  );
}

function scoreOf(value) {
  return typeof value === "string" && value.includes(":") ? value : null;
}

function toLive(event) {
  return {
    eventId: String(event.eventId ?? ""),
    home: String(event.homeTeamName ?? ""),
    away: String(event.awayTeamName ?? ""),
    matchStatus: String(event.matchStatus ?? ""),
    score: scoreOf(event.setScore),
    playedSeconds: typeof event.playedSeconds === "string" ? event.playedSeconds : null,
    period: event.period == null ? null : String(event.period),
    status: Number(event.status) || 0,
    startTime: Number(event.estimateStartTime) || 0,
  };
}

/** The feed carries upcoming fixtures too; only keep the ones with a clock running. */
function isLive(event) {
  const status = Number(event?.status);
  if (status === 4 || event?.matchStatus === "Ended") return false;
  return status === 1 || Boolean(event?.playedSeconds);
}

async function fetchLive() {
  try {
    const response = await fetch(`${LIVE_URL}&_t=${Date.now()}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const body = await response.json().catch(() => null);
    if (!body) return null;

    return eventsOf(body)
      .filter((event) => event?.eventId && isLive(event))
      .map(toLive);
  } catch {
    // A blocked or slow scrape must never wipe the scores already on screen.
    return null;
  }
}

async function fetchEvent(eventId) {
  const url =
    `${SPORTY_HOST}/api/gh/factsCenter/event?eventId=${encodeURIComponent(eventId)}` +
    `&productId=3&_t=${Date.now()}`;

  try {
    const response = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return body?.data ?? null;
  } catch {
    return null;
  }
}

/** Event ids of the user's unsettled bets that have kicked off recently enough to be finished. */
async function trackedEventIds(env, now) {
  if (!env?.DB) return [];

  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT sr_event_id AS eventId
         FROM active_bets
        WHERE sr_event_id IS NOT NULL AND sr_event_id <> ''
          AND kickoff IS NOT NULL
          AND kickoff > ? AND kickoff < ?`,
    )
      .bind(now - SETTLE_WITHIN_MS, now - SETTLE_AFTER_MS)
      .all();

    return (results ?? []).map((row) => String(row.eventId)).filter(Boolean);
  } catch {
    return [];
  }
}

async function resolveFinished(env, now, known) {
  const ids = (await trackedEventIds(env, now))
    .filter((eventId) => !known.has(eventId))
    .slice(0, MAX_EVENT_LOOKUPS);

  const finished = [];

  for (const eventId of ids) {
    const event = await fetchEvent(eventId);
    if (!event) continue;
    if (Number(event.status) !== 4 && event.matchStatus !== "Ended") continue;

    finished.push({
      eventId,
      home: String(event.homeTeamName ?? ""),
      away: String(event.awayTeamName ?? ""),
      score: scoreOf(event.setScore),
      matchStatus: String(event.matchStatus ?? "Ended"),
      status: Number(event.status) || 4,
      startTime: Number(event.estimateStartTime) || 0,
      finishedAt: now,
    });
  }

  return finished;
}

function mergeFinished(previous, fresh, now) {
  const byId = new Map();

  for (const match of previous) {
    if (!match?.eventId) continue;
    if (now - Number(match.finishedAt ?? 0) > FINISHED_TTL_MS) continue;
    byId.set(String(match.eventId), match);
  }
  for (const match of fresh) byId.set(match.eventId, match);

  return [...byId.values()];
}

async function loadPrevious(env) {
  try {
    const raw = await env[KV_BINDING].get(KV_KEY);
    if (!raw) return EMPTY_STATE;

    const body = JSON.parse(raw);
    return {
      generatedAt: Number(body?.generatedAt) || 0,
      liveAt: Number(body?.liveAt) || 0,
      serverNow: Number(body?.serverNow) || 0,
      live: Array.isArray(body?.live) ? body.live : [],
      finished: Array.isArray(body?.finished) ? body.finished : [],
    };
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * What actually justifies a KV write: the score, the status, and which matches are live.
 * `playedSeconds` is deliberately excluded — it ticks every poll and would write 90 times a match.
 */
function signature(live, finished) {
  return JSON.stringify({
    live: live.map((match) => [match.eventId, match.score, match.matchStatus, match.status]),
    finished: finished.map((match) => [match.eventId, match.score, match.matchStatus]),
  });
}

async function refresh(env, now) {
  const previous = await loadPrevious(env);
  const known = new Set(previous.finished.map((match) => String(match.eventId)));

  const [live, fresh] = await Promise.all([
    fetchLive(),
    resolveFinished(env, now, known),
  ]);

  const finished = mergeFinished(previous.finished, fresh, now);
  const nextLive = live ?? previous.live;
  const liveAt = live === null ? previous.liveAt : now;
  // A failed scrape keeps the old anchor, so a stale clock is never re-based to "now".
  const serverNow = live === null ? previous.serverNow : now;

  const changed = signature(nextLive, finished) !== signature(previous.live, previous.finished);
  const heartbeatDue = now - previous.generatedAt >= HEARTBEAT_MS;

  if (!changed && !heartbeatDue) {
    return {
      live: nextLive.length,
      finished: finished.length,
      written: false,
      error: live === null ? "live feed unavailable" : undefined,
    };
  }

  await env[KV_BINDING].put(
    KV_KEY,
    JSON.stringify({ generatedAt: now, liveAt, serverNow, live: nextLive, finished }),
  );

  return { live: nextLive.length, finished: finished.length, written: true };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      refresh(env, Date.now()).then(
        (summary) => console.log(JSON.stringify(summary)),
        (error) => console.error(`live-scores run failed: ${error?.message ?? error}`),
      ),
    );
  },

  /** Manual run for testing: POST to this Worker's URL. */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("POST to run the live-scores refresh.\n", { status: 405 });
    }

    try {
      return Response.json(await refresh(env, Date.now()));
    } catch (error) {
      return Response.json({ error: error?.message ?? String(error) }, { status: 502 });
    }
  },
};
