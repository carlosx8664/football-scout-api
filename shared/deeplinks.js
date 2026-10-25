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

const SEARCH_SITES = {
  [SPORTY]: "sportybet.com",
  [MSPORT]: "msport.com",
  [BETBORO]: "betboro.com.gh",
  [BOLTBET]: "boltbet.com.gh",
  [BETPAWA]: "betpawa.com.gh",
};

/** "Premier League" -> "Premier_League"; encoded so accents survive the path. */
function slugify(value) {
  const text = String(value ?? "").trim();
  return text ? encodeURIComponent(text.replace(/\s+/g, "_")) : "";
}

/** Tier 1 path segment: `{league}/{home}_vs_{away}`. Null when any piece is missing. */
function fixturePath(context) {
  const league = slugify(context?.league);
  const home = slugify(context?.home);
  const away = slugify(context?.away);
  if (!league || !home || !away) return null;
  return `${league}/${home}_vs_${away}`;
}

/** Tier 3: a Google site search, which always opens something useful. */
function searchUrl(bookmaker, home, away) {
  const site = SEARCH_SITES[bookmaker];
  if (!site || !home || !away) return null;
  const query = encodeURIComponent(`site:${site} "${home}" "${away}"`);
  return `https://www.google.com/search?q=${query}`;
}

/**
 * Fixture URL on a bookmaker, in three tiers:
 *
 *   1. slug path  .../football/{league}/{home}_vs_{away}/sr:match:{id}
 *   2. bare id    .../football/sr:match:{id}                  (old shape; often 404s)
 *   3. Google     site:bookmaker.com "{home}" "{away}"        (always opens something)
 *
 * Returns null only for bookmakers with neither a URL pattern nor a search site.
 *
 * @param {string} bookmaker
 * @param {string | null | undefined} eventId Sportradar id, e.g. "sr:match:72478654"
 * @param {{
 *   home?: string | null,
 *   away?: string | null,
 *   league?: string | null,
 *   betBoroId?: string | number,
 *   regionId?: string | number,
 *   competitionId?: string | number,
 * }} [context]
 * @returns {string | null}
 */
export function directUrl(bookmaker, eventId, context = {}) {
  const id = srMatchId(eventId);
  const { home, away } = context ?? {};

  if (bookmaker === SPORTY || bookmaker === MSPORT) {
    if (id) {
      const base =
        bookmaker === SPORTY
          ? "https://www.sportybet.com/gh/sport/football"
          : "https://www.msport.com/gh/web/sports/Soccer";
      const path = fixturePath(context);
      return path ? `${base}/${path}/sr:match:${id}` : `${base}/sr:match:${id}`;
    }

    // No Sportradar id: fall straight through to the search that always resolves.
    return searchUrl(bookmaker, home, away);
  }

  if (bookmaker === BETBORO) {
    const { betBoroId, regionId, competitionId } = context ?? {};
    if (betBoroId && regionId && competitionId) {
      return `https://betboro.com.gh/pre-sports/1/region/${regionId}/competition/${competitionId}/fixture/${betBoroId}`;
    }
  }

  return null;
}

/**
 * Link used in the arbitrage feed: `directUrl`, then a site search for every bookmaker, so an
 * arbs.json row always has something clickable.
 *
 * @param {string} bookmaker
 * @param {string | null | undefined} eventId
 * @param {string} home
 * @param {string} away
 * @param {{ league?: string | null, betBoroId?: string | number, regionId?: string | number, competitionId?: string | number }} [rawFixture]
 * @returns {string | null}
 */
export function buildUrl(bookmaker, eventId, home, away, rawFixture = {}) {
  return (
    directUrl(bookmaker, eventId, { ...rawFixture, home, away }) ??
    searchUrl(bookmaker, home, away)
  );
}
