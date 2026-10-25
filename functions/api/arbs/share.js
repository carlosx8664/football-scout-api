import { createSportyBetShare, normaliseSelections } from "../../../shared/sportybet.js";

/**
 * POST /api/arbs/share
 *
 * Body: `{ selections: [{ eventId, marketId, outcomeId, specifier }] }`
 *   → `200 { shareURL, shareCode, unavailableOutcomes, dropped }`
 *
 * Turns one arb's SportyBet leg into a booking code the user can open in a new tab. The ids come
 * from `scripts/find-arbs.js`, which captures them from the SportyBet feed at scan time — this
 * endpoint never guesses them.
 *
 * Only SportyBet selections are supported; other books stay on deep links. The share code is
 * minted by SportyBet, so a rejection (suspended odds, blocked egress) is reported as 502 with a
 * readable message rather than retried.
 */

const MAX_BODY_BYTES = 8 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request }) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "Request body too large." }, 413);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 415);
  }

  // Accept either `{ selections: [...] }` or a bare array.
  const { selections, dropped } = normaliseSelections(
    Array.isArray(payload) ? payload : payload?.selections,
  );

  if (selections.length === 0) {
    return json({ error: "No valid SportyBet selections in the request." }, 400);
  }

  try {
    const share = await createSportyBetShare(selections);

    return json({
      shareURL: share.url,
      shareCode: share.code,
      unavailableOutcomes: share.unavailable.length,
      dropped,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
        selections: selections.length,
      },
      502,
    );
  }
}
