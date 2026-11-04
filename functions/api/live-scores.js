const KV_BINDING = "FOOTBALL_DATA";
const LIVE_KEY = "feed-live-scores";

/**
 * Serves the in-play feed written by the `oddtor-live-scores` Worker every minute.
 *
 * Returns 404 before the Worker has run once, so the client can simply show no live state
 * rather than a broken scoreline.
 */
export async function onRequestGet({ env }) {
  const kv = env?.[KV_BINDING];

  if (!kv) {
    return Response.json(
      { error: `${KV_BINDING} KV binding is not configured.` },
      { status: 503 },
    );
  }

  let raw;
  try {
    raw = await kv.get(LIVE_KEY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `KV read failed: ${message}` }, { status: 502 });
  }

  if (!raw) {
    return Response.json({ error: "No live feed in KV yet." }, { status: 404 });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      // The Worker rewrites this key every minute.
      "Cache-Control": "public, max-age=30",
    },
  });
}
