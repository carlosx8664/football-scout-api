const KV_BINDING = "FOOTBALL_DATA";
const LATEST_SNAPSHOT_KEY = "snapshot-latest";
const UNAVAILABLE_MESSAGE = "Today's matches are not available yet. The next sync will refresh them shortly.";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function unavailableBody(date, message) {
  return { status: "pending", date, message, match_count: 0, matches: [] };
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serves the snapshot produced by the sync job. This handler never calls API-Football
 * or DeepSeek, so page views cannot consume the upstream quota.
 *
 * The sync runs four times a day over a rolling 7-day window, so `snapshot-latest` always
 * holds usable data; there is no date-key lookup or staleness handling here.
 */
export async function onRequest({ env }) {
  const date = new Date().toISOString().slice(0, 10);
  const kv = env && env[KV_BINDING];

  if (!kv) {
    return json(
      unavailableBody(
        date,
        `${UNAVAILABLE_MESSAGE} The ${KV_BINDING} KV binding is not configured for this environment.`,
      ),
    );
  }

  let raw;
  try {
    raw = await kv.get(LATEST_SNAPSHOT_KEY);
  } catch (error) {
    return json(unavailableBody(date, `${UNAVAILABLE_MESSAGE} (KV read failed: ${describe(error)})`));
  }

  if (!raw) {
    return json(unavailableBody(date, UNAVAILABLE_MESSAGE), 200, {
      "Cache-Control": "public, max-age=60",
    });
  }

  try {
    return json(JSON.parse(raw), 200, { "Cache-Control": "public, max-age=60, s-maxage=300" });
  } catch {
    return json(
      unavailableBody(date, `${UNAVAILABLE_MESSAGE} (the stored snapshot could not be parsed.)`),
    );
  }
}
