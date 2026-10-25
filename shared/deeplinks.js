/**
 * Bookmaker identity + deep links, shared by scripts/find-arbs.js and the bet-builder.
 *
 * The SportyBet, MSport and BetBoro patterns below are verified against live fixtures:
 *   https://www.sportybet.com/gh/sport/football/sr:match:72478654
 *   https://www.msport.com/gh/web/sports/Soccer/sr:match:72478654
 *   https://betboro.com.gh/pre-sports/1/region/16/competition/92/fixture/91668574
 *
 * Sportradar ids ("sr:match:...") are shared by every bookmaker, so one id is enough to
 * link to the same fixture everywhere. BetBoro additionally needs its own region /
 * competition / fixture ids, which only its raw dump carries.
 */

export const SPORTY = "SportyBet";
export const MSPORT = "MSport";
export const BETBORO = "BetBoro";
export const BOLTBET = "BoltBet";
export const BETPAWA = "BetPawa";

/**
 * Numeric part of a Sportradar id: "sr:match:72478654" -> "72478654".
 *
 * @param {string | null | undefined} eventId
 * @returns {string | null}
 */
export function srMatchId(eventId) {
  const id = String(eventId ?? "").replace("sr:match:", "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Direct fixture URL on a bookmaker that supports deep linking. Returns null instead of a
 * search fallback, so callers can hide the button rather than send users somewhere vague.
 *
 * @param {string} bookmaker
 * @param {string | null | undefined} eventId Sportradar id, e.g. "sr:match:72478654"
 * @param {{ betBoroId?: string | number, regionId?: string | number, competitionId?: string | number }} [rawFixture]
 * @returns {string | null}
 */
export function directUrl(bookmaker, eventId, rawFixture = {}) {
  const id = srMatchId(eventId);

  if (bookmaker === SPORTY && id) {
    return `https://www.sportybet.com/gh/sport/football/sr:match:${id}`;
  }

  if (bookmaker === MSPORT && id) {
    return `https://www.msport.com/gh/web/sports/Soccer/sr:match:${id}`;
  }

  if (bookmaker === BETBORO) {
    const { betBoroId, regionId, competitionId } = rawFixture ?? {};
    if (betBoroId && regionId && competitionId) {
      return `https://betboro.com.gh/pre-sports/1/region/${regionId}/competition/${competitionId}/fixture/${betBoroId}`;
    }
  }

  return null;
}

/**
 * Link used in the arbitrage feed. Same as `directUrl`, but falls back to a site search for
 * bookmakers without a stable per-fixture URL (BoltBet, BetPawa) or when BetBoro's raw ids
 * are missing, so existing arbs.json links never disappear.
 *
 * @param {string} bookmaker
 * @param {string | null | undefined} eventId
 * @param {string} home
 * @param {string} away
 * @param {{ betBoroId?: string | number, regionId?: string | number, competitionId?: string | number }} [rawFixture]
 * @returns {string | null}
 */
export function buildUrl(bookmaker, eventId, home, away, rawFixture = {}) {
  const direct = directUrl(bookmaker, eventId, rawFixture);
  if (direct) return direct;

  const searchQuery = encodeURIComponent(`"${home}" "${away}"`);

  if (bookmaker === BETBORO) {
    return `https://www.google.com/search?q=site:betboro.com.gh+${searchQuery}`;
  }
  if (bookmaker === BOLTBET) {
    return `https://www.google.com/search?q=site:boltbet.com.gh+${searchQuery}`;
  }
  if (bookmaker === BETPAWA) {
    return `https://www.google.com/search?q=site:betpawa.com.gh+${searchQuery}`;
  }

  return null;
}
