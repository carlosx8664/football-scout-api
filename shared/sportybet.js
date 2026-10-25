/**
 * SportyBet booking (share code) helper.
 *
 * SportyBet mints the code, so the only way to produce one is to POST the selections to their
 * internal endpoint. Shared by:
 *   - POST /api/bet-builder/extract   (all matched betslip legs)
 *   - POST /api/arbs/share            (one arb's SportyBet leg)
 *
 * Selection shape: `{ eventId: "sr:match:123", marketId: "1", outcomeId: "2", specifier: "" }`.
 * Ids are captured by `scripts/find-arbs.js` / `shared/betslip-match.js`, never invented here.
 */

export const SHARE_URL = "https://www.sportybet.com/api/gh/orders/share";
export const SHARE_TIMEOUT_MS = 15_000;
/** SportyBet rejects very long betslips; also caps what one request can cost us. */
export const MAX_SHARE_SELECTIONS = 20;

const EVENT_ID = /^sr:match:\d+$/;
const NUMERIC_ID = /^\d+$/;
/** e.g. `total=2.5`, `hcp=-1`; empty string when the market has no line. */
const SPECIFIER = /^[a-z]+=-?\d+(?:\.\d+)?$/;

/**
 * Validates and normalises a selection array. Anything malformed is dropped rather than sent,
 * so a bad client payload cannot book a different bet than the user saw.
 *
 * @param {unknown} input
 * @returns {{ selections: Array<{ eventId: string, marketId: string, outcomeId: string, specifier: string }>, dropped: number }}
 */
export function normaliseSelections(input) {
  const rows = Array.isArray(input) ? input : [];
  const selections = [];
  const seen = new Set();
  let dropped = 0;

  for (const row of rows) {
    const eventId = String(row?.eventId ?? "").trim();
    const marketId = String(row?.marketId ?? "").trim();
    const outcomeId = String(row?.outcomeId ?? "").trim();
    const specifier = String(row?.specifier ?? "").trim();

    const valid =
      EVENT_ID.test(eventId) &&
      NUMERIC_ID.test(marketId) &&
      NUMERIC_ID.test(outcomeId) &&
      (specifier === "" || SPECIFIER.test(specifier));

    if (!valid) {
      dropped += 1;
      continue;
    }

    const key = `${eventId}|${marketId}|${outcomeId}|${specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    selections.push({ eventId, marketId, outcomeId, specifier });
  }

  return { selections: selections.slice(0, MAX_SHARE_SELECTIONS), dropped };
}

/**
 * Trades selections for a share code. Returns `{ url, code, unavailable }`.
 * Throws with a user-safe message when SportyBet refuses (odds suspended, blocked, etc.).
 *
 * @param {Array<{ eventId: string, marketId: string, outcomeId: string, specifier: string }>} selections
 * @returns {Promise<{ url: string, code: string | null, unavailable: unknown[] }>}
 */
export async function createSportyBetShare(selections) {
  const response = await fetch(SHARE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // SportyBet answers 403 without a browser-ish origin.
      Origin: "https://www.sportybet.com",
      Referer: "https://www.sportybet.com/gh/sport/football",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({
      selections: selections.map(({ eventId, marketId, outcomeId, specifier }) => ({
        eventId,
        marketId,
        outcomeId,
        specifier,
      })),
    }),
    signal: AbortSignal.timeout(SHARE_TIMEOUT_MS),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SportyBet rejected the betslip (HTTP ${response.status}).`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("SportyBet returned a non-JSON booking response.");
  }

  const data = body?.data ?? body ?? {};
  const url = data.shareURL ?? data.shareUrl ?? null;
  const code = data.shareCode ?? null;
  const unavailable = Array.isArray(data.unavailableOutcomes) ? data.unavailableOutcomes : [];

  if (!url) {
    throw new Error("SportyBet did not return a share link; the odds may have been suspended.");
  }

  return { url: String(url), code: code == null ? null : String(code), unavailable };
}
