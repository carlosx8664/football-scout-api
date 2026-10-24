const KV_BINDING = "FOOTBALL_DATA";
const HOT_KEY = "feed-arbs";
const HORIZON_KEY = "feed-arbs-horizon";

function parseFeed(raw, key) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${key} is not valid JSON: ${message}`);
  }
}

/** Hot arbs win over horizon arbs for the same event+market; horizon only adds far-out ones. */
const arbKey = (arb) => `${arb.eventId ?? ""}|${arb.market ?? ""}`;

function mergeFeeds(hot, horizon) {
  const byId = new Map();

  for (const arb of horizon?.arbs ?? []) {
    byId.set(arbKey(arb), arb);
  }
  for (const arb of hot?.arbs ?? []) {
    byId.set(arbKey(arb), arb);
  }

  const arbs = [...byId.values()].sort((a, b) => b.profitPct - a.profitPct);
  const base = hot ?? horizon;

  return {
    ...base,
    arbs,
    stats: {
      ...(hot?.stats ?? horizon?.stats ?? {}),
      arbs: arbs.length,
      sources: {
        hot: hot?.generatedAt ?? null,
        horizon: horizon?.generatedAt ?? null,
      },
    },
  };
}

/**
 * Serves the arbitrage feed written by the `Odds refresh` workflow.
 *
 * Returns 404 when KV has nothing yet so the client can fall back to the static
 * `/arbs.json` bundled at build time.
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
    return Response.json({ error: "No arbitrage feed in KV yet." }, { status: 404 });
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
      "Cache-Control": "public, max-age=60",
    },
  });
}
