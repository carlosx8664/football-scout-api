import {
  createSportyBetShareSkippingUnavailable,
  normaliseSelections,
} from "../../../shared/sportybet.js";

/**
 * POST /api/bet-builder/share
 *
 * Body: `{ selections: [{ eventId, marketId, outcomeId, specifier }] }`
 *   → `200 { shareURL, shareCode, booked, skipped: [{ ...selection, reason }], dropped }`
 *
 * Mints a SportyBet share link for the legs the user ticked, dropping any outcome the book is not
 * currently offering instead of failing the whole betslip. The Bet Builder's own endpoint, kept
 * apart from `/api/arbs/share` so the arbitrage flow keeps its strict all-or-nothing behaviour.
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

  const { selections, dropped } = normaliseSelections(
    Array.isArray(payload) ? payload : payload?.selections,
  );

  if (selections.length === 0) {
    return json({ error: "No valid SportyBet selections in the request." }, 400);
  }

  try {
    const share = await createSportyBetShareSkippingUnavailable(selections);

    return json({
      shareURL: share.url,
      shareCode: share.code,
      booked: share.booked,
      skipped: share.skipped.map(({ selection, reason }) => ({ ...selection, reason })),
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
