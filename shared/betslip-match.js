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
 *     links     { sportybet, msport, betboro } deep links (null when not buildable)
 *
 * Each `unresolved` entry:
 *   { leg, reason, candidates: [top 3] }
 *     reason    "missing-teams" | "no-candidates" | "low-confidence" | "ambiguous"
 *     candidates are the same shape as `matched` minus `status`, so the UI can offer a picker.
 */

import { normalizeTeam } from "./teams.js";
import { BETBORO, MSPORT, SPORTY, directUrl } from "./deeplinks.js";

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
]);

const tokensOf = (value) =>
  String(value ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

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
  const left = tokensOf(a);
  const right = tokensOf(b);
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
  };

  return {
    sportybet: directUrl(SPORTY, eventId, context),
    msport: directUrl(MSPORT, eventId, context),
    betboro: directUrl(BETBORO, eventId, context),
  };
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
