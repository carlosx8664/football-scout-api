const KV_BINDING = "FOOTBALL_DATA";
const LATEST_SNAPSHOT_KEY = "snapshot-latest";
const NOT_READY_MESSAGE = "Data for today is not ready yet. The daily sync runs at 9 AM.";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function pendingPayload(date, message) {
  return { status: "pending", date, message, match_count: 0, matches: [] };
}

function parseErrorPayload(date) {
  return pendingPayload(date, `${NOT_READY_MESSAGE} (the stored snapshot could not be parsed.)`);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serves the snapshot produced by the daily sync. This handler never calls API-Football
 * or DeepSeek, so page views cannot consume the upstream quota.
 *
 * Today's key wins; when it does not exist yet (any time before the 09:00 UTC sync) the
 * most recent slate is served and flagged `stale: true`.
 */
export async function onRequest({ env }) {
  const date = new Date().toISOString().slice(0, 10);
  const kv = env && env[KV_BINDING];

  if (!kv) {
    return json(
      pendingPayload(
        date,
        `${NOT_READY_MESSAGE} The ${KV_BINDING} KV binding is not configured for this environment.`,
      ),
    );
  }

  let todayRaw;
  try {
    todayRaw = await kv.get(`snapshot-${date}`);
  } catch (error) {
    return json(pendingPayload(date, `${NOT_READY_MESSAGE} (KV read failed: ${describe(error)})`));
  }

  if (todayRaw) {
    try {
      return json(JSON.parse(todayRaw), 200, {
        "Cache-Control": "public, max-age=60, s-maxage=300",
      });
    } catch {
      return json(parseErrorPayload(date));
    }
  }

  let latestRaw;
  try {
    latestRaw = await kv.get(LATEST_SNAPSHOT_KEY);
  } catch (error) {
    return json(pendingPayload(date, `${NOT_READY_MESSAGE} (KV read failed: ${describe(error)})`));
  }

  if (!latestRaw) {
    return json(pendingPayload(date, NOT_READY_MESSAGE), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  try {
    const latest = JSON.parse(latestRaw);
    return json(
      {
        ...latest,
        stale: true,
        message: `Showing the most recent slate (${latest.date}). Today's sync runs at 9 AM.`,
      },
      200,
      { "Cache-Control": "public, max-age=60" },
    );
  } catch {
    return json(parseErrorPayload(date));
  }
}
