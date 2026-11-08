/**
 * Server clock for the live-score anchor.
 *
 * The live-scores Worker used to re-write `feed-live-scores` every few minutes just to keep its
 * `serverNow` field fresh, which spent a large slice of the KV write quota on nothing. Reading the
 * time from a Function costs no KV operations at all, so the heartbeat can stay slow.
 */
export async function onRequestGet() {
  return Response.json(
    { now: Date.now() },
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
