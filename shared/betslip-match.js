/**
 * Bet-builder matcher: resolves the legs a vision model read off a betslip screenshot against
 * the local `matches.json` feed.
 *
 * Dependency-free and pure, so the same module runs in the Vite bundle and in Node scripts.
 *
 *   import { matchBetslipLegs } from "../shared/betslip-match.js";
 *   const { matched, unresolved } = matchBetslipLegs(parsed.legs, feed.matches);
 *
 * Each `matched` entry:
 *   { status: "matched", leg, match, confidence, teamScore, oddsScore, flipped, links }
 *     leg       the original extracted leg
 *     match     the matches.json fixture it resolved to
 *     flipped   true when the slip printed the teams in the opposite order to the feed
 *     links     { sportybet, msport, betpawa, boltbet, betboro } deep links (null when not
 *               buildable) — the local books the slip is converted to
 *
 * Each `unresolved` entry:
 *   { leg, reason, candidates: [top 3] }
 *     reason    "missing-teams" | "no-candidates" | "low-confidence" | "ambiguous"
 *     candidates are the same shape as `matched` minus `status`, so the UI can offer a picker.
 */

import { normalizeTeam } from "./teams.js";
import { BETBORO, BETPAWA, BOLTBET, MSPORT, SPORTY, directUrl } from "./deeplinks.js";

/** Confidence at or above this is auto-matched. */
const MATCH_THRESHOLD = 0.72;
/** Below this a fixture is not even offered as a candidate. */
const CANDIDATE_THRESHOLD = 0.45;
/** If the runner-up is this close, the leg goes to the picker instead of auto-matching. */
const AMBIGUITY_GAP = 0.03;
/** Weights: team names dominate, odds only confirm. */
const TEAM_WEIGHT = 0.78;
const ODDS_WEIGHT = 0.22;
/** A price this close counts as the same quote. */
const ODDS_TOLERANCE = 0.06;
/** Prices further than this from the slip's price stop contributing. */
const ODDS_DECAY = 0.35;
const MAX_CANDIDATES = 3;

const squash = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const round = (value) => Number(value.toFixed(3));

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length];
}

const ratio = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/** Words `normalizeTeam` strips: a name that differs only by these is the same club. */
const CLUB_TOKENS = new Set([
  "fc", "sc", "afc", "cf", "united", "utd", "city", "club", "women", "wom", "wfc", "lfc",
  "sl", "ss", "rc", "ca", "as", "ac", "cd", "ud", "sv", "bk", "fk", "nk", "sk",
]);

const tokensOf = (value) =>
  String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Club-form words that never tell two teams apart ("BK", "Boldklub", "SC"). Unlike `CLUB_TOKENS`
 * these are dropped from token comparison as well, so "Odense BK" and "Odense Boldklub" agree —
 * while "United" and "City" keep counting, since those *do* separate Manchester's two clubs.
 */
const FORM_TOKENS = new Set([
  "fc", "afc", "sc", "cf", "ac", "as", "cd", "ud", "ca", "rc", "ss", "sl", "sv",
  "bk", "fk", "nk", "sk", "if", "ff", "ik", "boldklub", "club", "wfc", "lfc", "wom", "women",
]);

/**
 * Both names' tokens with club-form words removed. Applied only when each side keeps the same
 * number of tokens: "Odense BK" then agrees with "Odense Boldklub", while "AC Milan" cannot
 * collapse onto "Inter Milan" (1 significant token against 2).
 */
function formTokens(a, b) {
  const allLeft = tokensOf(a);
  const allRight = tokensOf(b);
  const left = allLeft.filter((token) => !FORM_TOKENS.has(token));
  const right = allRight.filter((token) => !FORM_TOKENS.has(token));

  const usable = left.length > 0 && right.length > 0 && left.length === right.length;
  return usable ? [left, right] : [allLeft, allRight];
}

/** "utd" is a subsequence of "united"; used to spot bookmaker abbreviations. */
function isSubsequence(short, long) {
  if (short.length < 3) return false;
  let index = 0;
  for (const char of long) {
    if (char === short[index]) index += 1;
    if (index === short.length) return true;
  }
  return false;
}

/** Token-level agreement, tolerant of abbreviations ("Man Utd" vs "Manchester United"). */
function tokenScore(a, b) {
  const [left, right] = formTokens(a, b);
  if (left.length === 0 || right.length === 0) return 0;

  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  // A bare "United" or "City" carries no information on its own.
  if (short.length === 1 && CLUB_TOKENS.has(short[0])) return 0;

  let total = 0;
  for (const token of short) {
    let best = 0;
    for (const other of long) {
      if (other === token) {
        best = 1;
        break;
      }
      if (token.length >= 3 && other.startsWith(token)) best = Math.max(best, 0.85);
      else if (isSubsequence(token, other)) best = Math.max(best, 0.7);
      else best = Math.max(best, ratio(token, other));
    }
    if (best >= 0.6) total += best;
  }

  return total / short.length;
}

/**
 * Similarity of two team names, 0..1. Tolerates OCR slips, bookmaker abbreviations and the
 * club suffixes `normalizeTeam` strips, without letting two different clubs collide.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function teamSimilarity(a, b) {
  const left = squash(a);
  const right = squash(b);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const leftTokens = tokensOf(a);
  const rightTokens = tokensOf(b);

  // A single generic word ("United", "City") cannot identify a club on its own.
  if (leftTokens.length === 1 && CLUB_TOKENS.has(leftTokens[0])) return 0;
  if (rightTokens.length === 1 && CLUB_TOKENS.has(rightTokens[0])) return 0;

  // Edit distance on the squashed names: catches typos and OCR splits.
  const raw = ratio(left, right);
  const tokens = tokenScore(a, b);

  // Abbreviation of a single-token name: "Man" against "Manchester".
  const shorter = left.length <= right.length ? left : right;
  const longer = shorter === left ? right : left;
  const prefix =
    shorter.length >= 3 && longer.startsWith(shorter)
      ? 0.8 + 0.15 * (shorter.length / longer.length)
      : 0;

  // Whole-name abbreviation: "manutd" is a subsequence of "manchesterunited".
  const abbrev = isSubsequence(shorter, longer) ? 0.8 : 0;

  // Suffix-only difference ("Arsenal" / "Arsenal FC"): the stripped names agree AND the tokens
  // line up. The token gate is what keeps "Manchester United" off "Manchester City", since both
  // strip down to "manchester".
  const normLeft = normalizeTeam(a);
  const normRight = normalizeTeam(b);
  const alias = normLeft && normLeft === normRight && tokens >= 0.75 ? 0.94 : 0;

  let score = Math.max(raw, tokens, prefix, abbrev, alias);

  // Two multi-word names whose words mostly disagree: the shared prefix inflates the edit
  // distance ("manchesterunited" vs "manchestercity" reads as 0.75), so trust the tokens.
  if (leftTokens.length >= 2 && rightTokens.length >= 2 && tokens < 0.6) {
    score = Math.min(score, 0.55);
  }

  return score;
}

/** Best team score for one leg against one fixture, plus whether the sides are reversed. */
function teamScoreFor(leg, match) {
  const homeName = match?.teams?.home?.name;
  const awayName = match?.teams?.away?.name;
  if (!homeName || !awayName) return { score: 0, flipped: false };

  const legHome = squash(leg?.home) ? leg.home : null;
  const legAway = squash(leg?.away) ? leg.away : null;
  if (!legHome && !legAway) return { score: 0, flipped: false };

  // One side only (header cropped): score against whichever feed side it resembles most.
  if (!legHome || !legAway) {
    const single = legHome ?? legAway;
    return {
      score: Math.max(teamSimilarity(single, homeName), teamSimilarity(single, awayName)),
      flipped: false,
    };
  }

  const straight = (teamSimilarity(legHome, homeName) + teamSimilarity(legAway, awayName)) / 2;
  const reversed = (teamSimilarity(legHome, awayName) + teamSimilarity(legAway, homeName)) / 2;

  return reversed > straight + 1e-9
    ? { score: reversed, flipped: true }
    : { score: straight, flipped: false };
}

/** How well the slip's price matches any price the feed quotes for this fixture (null = unknown). */
function oddsScoreFor(leg, match) {
  const wanted = Number(leg?.odds);
  if (!Number.isFinite(wanted)) return null;

  // `book_odds` only carries 1X2 prices, so a totals/BTTS/handicap leg has nothing to compare
  // against. Treating it as unknown keeps a correct team-name match from being dragged under
  // the threshold by an unrelated price comparison.
  if (!selectionSide(leg, match)) return null;

  const prices = [];
  const sides = match?.book_odds;
  if (sides) {
    for (const side of ["home", "draw", "away"]) {
      for (const price of Object.values(sides[side]?.books ?? {})) prices.push(Number(price));
    }
  }
  if (prices.length === 0 && Array.isArray(match?.odds)) {
    for (const entry of match.odds) prices.push(Number(entry?.odd));
  }

  let closest = Number.POSITIVE_INFINITY;
  for (const price of prices) {
    if (Number.isFinite(price)) closest = Math.min(closest, Math.abs(price - wanted));
  }
  if (!Number.isFinite(closest)) return null;
  if (closest <= ODDS_TOLERANCE) return 1;

  return Math.max(0, 1 - (closest - ODDS_TOLERANCE) / ODDS_DECAY);
}

function buildLinks(match) {
  const eventId = match?.sr_id ?? null;
  // League + team names let `directUrl` build the full slug path (tier 1).
  const context = {
    home: match?.teams?.home?.name ?? null,
    away: match?.teams?.away?.name ?? null,
    league: match?.league?.name ?? null,
    ...(match?.book_ids?.betboro ?? {}),
    ...(match?.book_ids?.boltbet ?? {}),
    ...(match?.book_ids?.betpawa ?? {}),
  };

  // Every book we can actually place the bet on. The source bookmaker of the screenshot is
  // irrelevant: the slip is being converted to these local books.
  return {
    sportybet: directUrl(SPORTY, eventId, context),
    msport: directUrl(MSPORT, eventId, context),
    betpawa: directUrl(BETPAWA, eventId, context),
    boltbet: directUrl(BOLTBET, eventId, context),
    betboro: directUrl(BETBORO, eventId, context),
  };
}

/* ------------------------------------------------------------------ *
 * SportyBet betslip booking (share code)
 * ------------------------------------------------------------------ */

/** Markets whose selection is not one of the 1X2 outcomes that `book_odds` carries. */
const NON_RESULT_MARKET =
  /over|under|total|goal|handicap|corner|card|booking|both teams|btts|double chance|clean sheet|correct score|odd\/even|odd or even|multi ?goal|half|win to nil|penalt/i;

/**
 * Which 1X2 outcome a leg is on, or null when the market is not a plain match result.
 *
 * @param {{ market?: string, selection?: string }} leg
 * @param {{ teams?: { home?: { name?: string }, away?: { name?: string } } }} match
 * @returns {"home" | "draw" | "away" | null}
 */
export function selectionSide(leg, match) {
  if (NON_RESULT_MARKET.test(leg?.market ?? "")) return null;

  const selection = (leg?.selection ?? "").trim().toLowerCase();
  if (!selection) return null;
  // "Draw or Away (X2)" and friends cannot be priced from a single 1X2 column.
  if (/\bor\b/.test(selection)) return null;

  if (selection === "1" || /^home\b/.test(selection)) return "home";
  if (selection === "x" || selection === "tie" || /^draw\b/.test(selection)) return "draw";
  if (selection === "2" || /^away\b/.test(selection)) return "away";

  // Some slips print the team name instead of Home/Away.
  const picked = normalizeTeam(selection);
  if (picked) {
    const home = normalizeTeam(match?.teams?.home?.name);
    const away = normalizeTeam(match?.teams?.away?.name);
    if (picked === home) return "home";
    if (picked === away) return "away";

    // Abbreviations the slip prints instead of the full name ("PSG", "Spurs"): fall back to
    // the shared scorer, but only when one side wins clearly so a bad read cannot flip a bet.
    const homeScore = teamSimilarity(selection, match?.teams?.home?.name);
    const awayScore = teamSimilarity(selection, match?.teams?.away?.name);
    const best = Math.max(homeScore, awayScore);
    if (best >= 0.8 && best - Math.min(homeScore, awayScore) >= 0.15) {
      return homeScore > awayScore ? "home" : "away";
    }
  }

  return null;
}

/**
 * SportyBet booking ids, verified against `data/sportybet.json`:
 *
 *   market 1    1X2              outcomes 1 Home / 2 Draw / 3 Away
 *   market 18   Over/Under       outcomes 12 Over / 13 Under,  specifier total=<line>
 *   market 166  Corners O/U      outcomes 12 Over / 13 Under,  specifier total=<line>
 *   market 139  Bookings O/U     outcomes 12 Over / 13 Under,  specifier total=<line>
 *   market 10   Double Chance    outcomes 9 1X / 10 12 / 11 X2
 *   market 11   Draw No Bet      outcomes 4 Home / 5 Away
 *   market 29   GG/NG            outcomes 74 Yes / 76 No
 *
 * Unlisted markets are skipped rather than guessed: a wrong outcome id silently books the
 * wrong bet.
 */
const RESULT_OUTCOME = { home: "1", draw: "2", away: "3" };

function overUnderOutcome(selection) {
  const text = String(selection ?? "").toLowerCase();
  if (/\bover\b/.test(text)) return "12";
  if (/\bunder\b/.test(text)) return "13";
  return null;
}

/** "Over 2.5" -> "2.5"; falls back to the market label, then to the raw slip row. */
function totalLine(leg) {
  const number = /(\d+(?:\.\d+)?)/;

  const fromSelection = number.exec(String(leg?.selection ?? ""));
  if (fromSelection) return fromSelection[1];

  const fromMarket = number.exec(String(leg?.market ?? ""));
  if (fromMarket) return fromMarket[1];

  // OCR sometimes leaves the line only in the raw row text: "Over 2.5 @ 1.85".
  const raw = String(leg?.rawText ?? "");
  const fromRawOverUnder = /(?:over|under)\s*(\d+(?:\.\d+)?)/i.exec(raw);
  if (fromRawOverUnder) return fromRawOverUnder[1];

  const fromRaw = number.exec(raw);
  return fromRaw ? fromRaw[1] : null;
}

function doubleChanceOutcome(selection) {
  const text = String(selection ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (text === "1x" || text.includes("homeordraw")) return "9";
  if (text === "12" || text.includes("homeoraway")) return "10";
  if (text === "x2" || text.includes("draworaway")) return "11";
  return null;
}

/** One leg -> `{ marketId, outcomeId, specifier }`, or null if it cannot be booked reliably. */
function sportybetSelection(leg, match) {
  const market = String(leg?.market ?? "").toLowerCase();
  const selection = String(leg?.selection ?? "").toLowerCase();

  // Order matters: corners/bookings are also "over/under".
  if (/corner/.test(market)) {
    const outcomeId = overUnderOutcome(selection);
    const line = totalLine(leg);
    return outcomeId && line ? { marketId: "166", outcomeId, specifier: `total=${line}` } : null;
  }

  if (/booking|card/.test(market)) {
    const outcomeId = overUnderOutcome(selection);
    const line = totalLine(leg);
    return outcomeId && line ? { marketId: "139", outcomeId, specifier: `total=${line}` } : null;
  }

  // SportyBet prints match totals as "Total Goals" and puts the line in the selection
  // ("Over 1.5"), so the over/under word can sit on either field. Team totals ("Home Team
  // Goals") are a different market and must not be booked as match O/U.
  const teamTotal = /\b(?:home|away)\s+team\b|\bteam\s+(?:total|goals?)\b/.test(market);
  const matchTotal =
    /\bover\b|\bunder\b/.test(market) ||
    (/\btotal|\bgoals?\b/.test(market) && /\bover\b|\bunder\b/.test(selection));

  if (!teamTotal && matchTotal) {
    const outcomeId = overUnderOutcome(selection);
    const line = totalLine(leg);
    return outcomeId && line ? { marketId: "18", outcomeId, specifier: `total=${line}` } : null;
  }

  if (/double chance/.test(market)) {
    const outcomeId = doubleChanceOutcome(selection);
    return outcomeId ? { marketId: "10", outcomeId, specifier: "" } : null;
  }

  if (/draw no bet/.test(market)) {
    const side = selectionSide(leg, match);
    if (side === "home") return { marketId: "11", outcomeId: "4", specifier: "" };
    if (side === "away") return { marketId: "11", outcomeId: "5", specifier: "" };
    return null;
  }

  if (/gg\/ng|both teams/.test(market)) {
    if (/\byes\b/.test(selection)) return { marketId: "29", outcomeId: "74", specifier: "" };
    if (/\bno\b/.test(selection)) return { marketId: "29", outcomeId: "76", specifier: "" };
    return null;
  }

  const side = selectionSide(leg, match);
  if (side) return { marketId: "1", outcomeId: RESULT_OUTCOME[side], specifier: "" };

  return null;
}

/**
 * Maps matched legs to SportyBet's booking payload.
 *
 * `bookings` is index-aligned with the input, so a caller can hang each leg's own booking on the
 * leg the user picked instead of booking the whole slip.
 *
 * @param {Array<{ leg: object, match: object }>} matchedLegs entries from `matchBetslipLegs`
 * @returns {{ selections: Array<{ eventId: string, marketId: string, outcomeId: string, specifier: string }>, skipped: Array<{ leg: object, reason: string }>, bookings: Array<{ eventId: string, marketId: string, outcomeId: string, specifier: string } | null> }}
 */
export function toSportyBetSelections(matchedLegs) {
  const selections = [];
  const skipped = [];
  const bookings = [];
  const seen = new Set();

  for (const entry of Array.isArray(matchedLegs) ? matchedLegs : []) {
    const leg = entry?.leg ?? entry;
    const eventId = entry?.match?.sr_id ?? null;

    bookings.push(null);

    if (!eventId) {
      skipped.push({ leg, reason: "missing-event-id" });
      continue;
    }

    const mapped = sportybetSelection(leg, entry?.match);
    if (!mapped) {
      skipped.push({ leg, reason: "unsupported-market" });
      continue;
    }

    const booking = { eventId, ...mapped };
    bookings[bookings.length - 1] = booking;

    const key = `${eventId}|${mapped.marketId}|${mapped.outcomeId}|${mapped.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);

    selections.push(booking);
  }

  return { selections, skipped, bookings };
}

function toCandidate(leg, scored) {
  return {
    status: "candidate",
    leg,
    match: scored.match,
    confidence: round(scored.confidence),
    teamScore: round(scored.teamScore),
    oddsScore: scored.oddsScore === null ? null : round(scored.oddsScore),
    flipped: scored.flipped,
    links: buildLinks(scored.match),
  };
}

/**
 * @param {Array<{ home?: string|null, away?: string|null, odds?: number|null }>} extractedLegs
 * @param {Array<object>} matches fixtures from `matches.json`
 * @param {{ matchThreshold?: number, candidateThreshold?: number, maxCandidates?: number }} [options]
 * @returns {{ matched: Array<object>, unresolved: Array<object> }}
 */
export function matchBetslipLegs(extractedLegs, matches, options = {}) {
  const fixtures = Array.isArray(matches) ? matches : [];
  const legs = Array.isArray(extractedLegs) ? extractedLegs : [];
  const matchThreshold = Number(options.matchThreshold ?? MATCH_THRESHOLD);
  const candidateThreshold = Number(options.candidateThreshold ?? CANDIDATE_THRESHOLD);
  const maxCandidates = Number(options.maxCandidates ?? MAX_CANDIDATES);

  const matched = [];
  const unresolved = [];

  for (const leg of legs) {
    if (!squash(leg?.home) && !squash(leg?.away)) {
      unresolved.push({ leg, reason: "missing-teams", candidates: [] });
      continue;
    }

    const scored = fixtures
      .map((match) => {
        const team = teamScoreFor(leg, match);
        const odds = oddsScoreFor(leg, match);
        const confidence =
          odds === null ? team.score : team.score * TEAM_WEIGHT + odds * ODDS_WEIGHT;
        return { match, confidence, teamScore: team.score, oddsScore: odds, flipped: team.flipped };
      })
      .filter((candidate) => candidate.confidence >= candidateThreshold)
      .sort((a, b) => b.confidence - a.confidence);

    const [best, runnerUp] = scored;
    const clearWinner =
      best !== undefined &&
      best.confidence >= matchThreshold &&
      (runnerUp === undefined || best.confidence - runnerUp.confidence > AMBIGUITY_GAP);

    if (clearWinner) {
      matched.push({ ...toCandidate(leg, best), status: "matched" });
      continue;
    }

    unresolved.push({
      leg,
      reason: best === undefined ? "no-candidates" : runnerUp ? "ambiguous" : "low-confidence",
      candidates: scored.slice(0, maxCandidates).map((candidate) => toCandidate(leg, candidate)),
    });
  }

  return { matched, unresolved };
}
