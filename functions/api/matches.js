const KV_BINDING = "FOOTBALL_DATA";
const HOT_KEY = "feed-matches";
const HORIZON_KEY = "feed-matches-horizon";

function parseFeed(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${key} is not valid JSON: ${message}`);
  }
}

/**
 * Merges the two feeds: the 2-day hot feed (refreshed every 15 minutes) and the 6-day
 * horizon feed (refreshed every 3 hours). The hot entry always wins when a fixture appears
 * in both, so live prices stay fresh while far-out fixtures stay visible.
 */
function mergeFeeds(hot, horizon) {
  const byId = new Map();

  for (const match of horizon?.matches ?? []) {
    byId.set(String(match.fixture?.id), match);
  }
  for (const match of hot?.matches ?? []) {
    byId.set(String(match.fixture?.id), match);
  }

  const matches = [...byId.values()].sort(
    (a, b) => new Date(a.fixture?.date ?? 0).getTime() - new Date(b.fixture?.date ?? 0).getTime(),
  );
  const base = hot ?? horizon;

  return {
    ...base,
    match_count: matches.length,
    window: {
      from: matches[0]?.fixture?.date?.slice(0, 10) ?? base?.window?.from ?? null,
      to: matches.at(-1)?.fixture?.date?.slice(0, 10) ?? base?.window?.to ?? null,
    },
    sources: {
      hot: hot?.generated_at ?? null,
      horizon: horizon?.generated_at ?? null,
    },
    matches,
  };
}

/**
 * Serves the match feed written by the `Odds refresh` workflow.
 *
 * Returns 404 when KV has nothing yet so the client can fall back to the static
 * `/matches.json` bundled at build time.
 */
export async function onRequestGet({ env }) {
  const kv = env?.[KV_BINDING];

  if (!kv) {
    return Response.json(
      { error: `${KV_BINDING} KV binding is not configured.` },
      { status: 503 },
    );
  }

  let hotRaw;
  let horizonRaw;
  try {
    [hotRaw, horizonRaw] = await Promise.all([kv.get(HOT_KEY), kv.get(HORIZON_KEY)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `KV read failed: ${message}` }, { status: 502 });
  }

  if (!hotRaw && !horizonRaw) {
    return Response.json({ error: "No match feed in KV yet." }, { status: 404 });
  }

  let body = hotRaw ?? horizonRaw;
  if (hotRaw && horizonRaw) {
    try {
      body = JSON.stringify(
        mergeFeeds(parseFeed(hotRaw, HOT_KEY), parseFeed(horizonRaw, HORIZON_KEY)),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: 502 });
    }
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json",
      // Short cache: the hot feed refreshes every 15 minutes.
      "Cache-Control": "public, max-age=60",
    },
  });
}
