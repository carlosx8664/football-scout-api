/**
 * Bookmaker identity + deep links, shared by scripts/find-arbs.js and the bet-builder.
 *
 * Verified live URL patterns:
 *   SportyBet: https://www.sportybet.com/gh/sport/football/sr:match:72478654
 *   MSport:    https://www.msport.com/gh/web/sports/Soccer/sr:match:72478654
 *   BetBoro:   https://betboro.com.gh/pre-sports/1/region/{regionId}/competition/{competitionId}/fixture/{betBoroId}
 *   BoltBet:   https://boltbet.com.gh/sports/match/football/{fixture.slug}
 *
 * Sportradar ids ("sr:match:...") are shared by every bookmaker, so one id is enough to
 * link to the same fixture everywhere. BetBoro and BoltBet each need their own ids,
 * which only their raw dumps carry.
 */

export const SPORTY = 'SportyBet';
export const MSPORT = 'MSport';
export const BETBORO = 'BetBoro';
export const BOLTBET = 'BoltBet';
export const BETPAWA = 'BetPawa';

/**
 * Numeric part of a Sportradar id: "sr:match:72478654" -> "72478654".
 */
export function srMatchId(eventId) {
  const id = String(eventId ?? '').replace('sr:match:', '').trim();
  return /^\d+$/.test(id) ? id : null;
}

const SEARCH_SITES = {
  [SPORTY]: 'sportybet.com',
  [MSPORT]: 'msport.com',
  [BETBORO]: 'betboro.com.gh',
  [BOLTBET]: 'boltbet.com.gh',
  [BETPAWA]: 'betpawa.com.gh',
};

/** "Premier League" -> "Premier_League"; encoded so accents survive the path. */
function slugify(value) {
  const text = String(value ?? '').trim();
  return text ? encodeURIComponent(text.replace(/\s+/g, '_')) : '';
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
 *   1. bookmaker-specific slug/id  (SportyBet, MSport, BetBoro, BoltBet)
 *   2. Google site-search fallback
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
 *   region_id?: string | number,
 *   competitionId?: string | number,
 *   competition_id?: string | number,
 *   boltbetSlug?: string | null,
 *   slug?: string | null,
 * }} [context]
 * @returns {string | null}
 */
export function directUrl(bookmaker, eventId, context = {}) {
  const id = srMatchId(eventId);
  const { home, away } = context ?? {};

  // -------------------------------------------------------------------------
  // SportyBet + MSport — both use sr:match:ID at the tail of the URL.
  // -------------------------------------------------------------------------
  if (bookmaker === SPORTY || bookmaker === MSPORT) {
    if (id) {
      const base =
        bookmaker === SPORTY
          ? 'https://www.sportybet.com/gh/sport/football'
          : 'https://www.msport.com/gh/web/sports/Soccer';
      const path = fixturePath(context);
      return path ? `${base}/${path}/sr:match:${id}` : `${base}/sr:match:${id}`;
    }
    return searchUrl(bookmaker, home, away);
  }

  // -------------------------------------------------------------------------
  // BetBoro — needs region / competition / fixture ids from the raw dump.
  // Accept both camelCase and snake_case because source payload uses snake.
  // -------------------------------------------------------------------------
  if (bookmaker === BETBORO) {
    const betBoroId = context?.betBoroId;
    const regionId = context?.regionId ?? context?.region_id;
    const competitionId = context?.competitionId ?? context?.competition_id;

    if (betBoroId && regionId && competitionId) {
      return `https://betboro.com.gh/pre-sports/1/region/${regionId}/competition/${competitionId}/fixture/${betBoroId}`;
    }
    return searchUrl(bookmaker, home, away);
  }

  // -------------------------------------------------------------------------
  // BoltBet — uses fixture.slug from the raw dump, e.g.
  //   https://boltbet.com.gh/sports/match/football/murcia-promises-cf-wom-valencia-b-wom-23906
  // -------------------------------------------------------------------------
  if (bookmaker === BOLTBET) {
    const slug = context?.boltbetSlug ?? context?.slug;
    if (slug) {
      return `https://boltbet.com.gh/sports/match/football/${slug}`;
    }
    return searchUrl(bookmaker, home, away);
  }

  return searchUrl(bookmaker, home, away);
}

/**
 * Link used in the arbitrage feed: `directUrl` then a site search for every
 * bookmaker, so an arbs.json row always has something clickable.
 */
export function buildUrl(bookmaker, eventId, home, away, rawFixture = {}) {
  return (
    directUrl(bookmaker, eventId, { ...rawFixture, home, away }) ??
    searchUrl(bookmaker, home, away)
  );
}