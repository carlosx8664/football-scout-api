const KV_BINDING = "FOOTBALL_DATA";
const FEED_KEY = "feed-matches";

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

  let raw;
  try {
    raw = await kv.get(FEED_KEY);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `KV read failed: ${message}` }, { status: 502 });
  }

  if (!raw) {
    return Response.json({ error: "No match feed in KV yet." }, { status: 404 });
  }

  return new Response(raw, {
    headers: {
      "Content-Type": "application/json",
      // Short cache: the workflow refreshes every 15 minutes.
      "Cache-Control": "public, max-age=60",
    },
  });
}
