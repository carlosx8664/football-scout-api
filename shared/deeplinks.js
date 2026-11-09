/**
 * Bookmaker identity + deep links, shared by scripts/find-arbs.js and the bet-builder.
 *
 * Verified live URL patterns:
 *   SportyBet: https://www.sportybet.com/gh/sport/football/sr:match:72478654
 *   MSport:    https://www.msport.com/gh/web/sports/Soccer/sr:match:72478654
 *   BetBoro:   https://betboro.com.gh/pre-sports/1/region/{regionId}/competition/{competitionId}/fixture/{betBoroId}
 *   BoltBet:   https://boltbet.com.gh/sports/match/football/{fixture.slug}
 *   Soccabet:  Google fallback until a verified fixture route is captured                         
 *   BetPawa:   https://www.betpawa.com.gh/event/{numeric event id} *
 *   Market selection rides along as `?marketId=&outcomeId=&specifier=` (SportyBet only, best-effort);
 *   see MARKET_QUERY_SUPPORT for why the other books keep the plain fixture link.
 * Sportradar ids ("sr:match:...") are shared by every bookmaker, so one id is enough to
 * link to the same fixture everywhere. BetBoro and BoltBet each need their own ids,
 * which only their raw dumps carry.
 */

export const SPORTY = 'SportyBet';
export const MSPORT = 'MSport';
export const BETBORO = 'BetBoro';
export const BOLTBET = 'BoltBet';
export const BETPAWA = 'BetPawa';
export const SOCCABET = 'Soccabet';

/**
 * Every bookmaker the scanner can read. Wallet management provisions one wallet per entry, so
 * adding a bookie here is all it takes for it to appear on the wallets page.
 */
export const BOOKMAKERS = [SPORTY, MSPORT, BETBORO, BOLTBET, BETPAWA, SOCCABET];

/**
 * Numeric part of a Sportradar id: "sr:match:72478654" -> "72478654".
 */
export function srMatchId(eventId) {
  const id = String(eventId ?? '').replace('sr:match:', '').trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Whether a bookmaker's public fixture route can pre-select a market, i.e. whether appending
 * `?marketId=…&outcomeId=…&specifier=…` does anything.
 *
 *   - SportyBet: best-effort. The route is a client-side SPA, so the ids are simply carried in the
 *     query string; the same ids the booking API uses. A route that ignores them still lands on the
 *     fixture page, so the link never gets worse.
 *   - Everyone else: unsupported. BetBoro's pre-sports route is fixture-only and its feed carries no
 *     market/outcome ids at all; the remaining books expose neither ids nor a market route.
 */
const MARKET_QUERY_SUPPORT = {
  [SPORTY]: 'best-effort',
  [MSPORT]: 'unsupported',
  [BETBORO]: 'unsupported',
  [BOLTBET]: 'unsupported',
  [BETPAWA]: 'unsupported',
  [SOCCABET]: 'unsupported',
};

/** One warning per bookmaker per run — an arb feed would otherwise drown in them. */
const warnedMarketLinks = new Set();

function warnMarketNotPreselected(bookmaker, reason) {
  if (warnedMarketLinks.has(bookmaker)) return;
  warnedMarketLinks.add(bookmaker);
  console.warn(
    `[deeplinks] ${bookmaker}: market pre-selection not supported (${reason}); linking the match page only.`,
  );
}

const SEARCH_SITES = {
  [SPORTY]: 'sportybet.com',
  [MSPORT]: 'msport.com',
  [BETBORO]: 'betboro.com.gh',
  [BOLTBET]: 'boltbet.com.gh',
  [BETPAWA]: 'betpawa.com.gh',
  [SOCCABET]: 'soccabet.com',
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

/** Plain (unscoped) Google search, used where a bookmaker has no verified fixture route. */
function plainSearchUrl(bookmaker, home, away) {
  if (!home || !away) return null;
  return `https://www.google.com/search?q=${bookmaker.toLowerCase()}+${encodeURIComponent(
    home,
  )}+vs+${encodeURIComponent(away)}`;
}

/** True when `url` points at the bookmaker itself rather than a Google fallback. */
function isFixtureUrl(bookmaker, url) {
  const site = SEARCH_SITES[bookmaker];
  if (!site) return false;
  try {
    return new URL(url).hostname.endsWith(site);
  } catch {
    return false;
  }
}

/**
 * Query string for a pre-selected selection, or null when the bookmaker's route cannot take one
 * (in which case the reason is logged once).
 *
 * @param {string} bookmaker
 * @param {Record<string, unknown>} context
 * @returns {URLSearchParams | null}
 */
function marketQuery(bookmaker, context) {
  const marketId = String(context?.marketId ?? '').trim();
  const outcomeId = String(context?.outcomeId ?? '').trim();

  if (!/^\d+$/.test(marketId) || !/^\d+$/.test(outcomeId)) {
    warnMarketNotPreselected(bookmaker, 'the feed carries no market/outcome id');
    return null;
  }
  if (MARKET_QUERY_SUPPORT[bookmaker] !== 'best-effort') {
    warnMarketNotPreselected(bookmaker, 'its URL has no market parameter');
    return null;
  }

  const params = new URLSearchParams({ marketId, outcomeId });
  const specifier = String(context?.specifier ?? '').trim();
  if (specifier) params.set('specifier', specifier);
  return params;
}

/**
 * Adds the market selection to a fixture URL when the route understands it, otherwise returns the
 * plain fixture URL. Only called when the caller passed a `market` label, so bookmakers that are
 * never asked to pre-select (e.g. the bet-builder) stay silent.
 */
function withMarketSelection(bookmaker, url, context) {
  if (!url || !context?.market) return url;
  if (!isFixtureUrl(bookmaker, url)) {
    warnMarketNotPreselected(bookmaker, 'the link is a search fallback, not a fixture page');
    return url;
  }
  const params = marketQuery(bookmaker, context);
  if (!params) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
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
 *   betpawaId?: string | null,
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

  // -------------------------------------------------------------------------
  // BetPawa — fixture pages are /event/{numeric id}, taken from the scraped href.
  // -------------------------------------------------------------------------
  if (bookmaker === BETPAWA) {
    const betPawaId = String(context?.betpawaId ?? "").replace(/^betpawa:/, '').trim();
    if (/^\d+$/.test(betPawaId)) {
      return `https://www.betpawa.com.gh/event/${betPawaId}`;
    }
    return searchUrl(bookmaker, home, away);
  }

  // -------------------------------------------------------------------------
  // Soccabet — isd.js exposes numeric match ids (soccabetId) but the public fixture route is
  // unverified, so link to a plain Google search until we capture a real href. A raw
  // `soccabetUrl` wins when a future fetcher starts storing the deep link.
  // -------------------------------------------------------------------------
  if (bookmaker === SOCCABET) {
    const direct = context?.soccabetUrl ?? context?.url;
    if (typeof direct === 'string' && /^https?:\/\//.test(direct)) return direct;
    return plainSearchUrl(bookmaker, home, away);
  }

  return searchUrl(bookmaker, home, away);
}

/**
 * Link used in the arbitrage feed: `directUrl` then a site search for every
 * bookmaker, so an arbs.json row always has something clickable.
 *
 * Pass `market` (plus `marketId` / `outcomeId` / `specifier` when the feed carries them) to ask for
 * the market to be pre-selected; bookmakers whose route cannot do that keep the fixture URL and log
 * a one-time warning.
 */
export function buildUrl(bookmaker, eventId, home, away, rawFixture = {}) {
  const context = { ...rawFixture, home, away };
  const url = directUrl(bookmaker, eventId, context) ?? searchUrl(bookmaker, home, away);
  return withMarketSelection(bookmaker, url, context);
}