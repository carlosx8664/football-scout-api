/**
 * Bet-builder -> BetBoro betslip mapper.
 *
 * BetBoro has no booking/share API, so a slip is loaded by the `Oddtor` extension clicking
 * each outcome on the fixture page. This module turns matched slip legs into the market/outcome
 * vocabulary of `extension/shared/betboro-markets.js`:
 *
 *   leg (free text from the model)          ->  BetBoro dictionary
 *   Over 2.5 Goals / Over 2.5              --->  Over/Under 2.5 Goals / Over
 *   Over 3.5 Cards / Over 3.5              --->  Over/Under 3.5 Bookings / Over
 *   BTTS / YES                             --->  Both Teams to Score / Yes
 *   Double Chance / Bosnia or Draw         --->  Double Chance / Home or Draw
 *   1X2 / Home                             --->  Match Result / Home
 *
 * Unknown markets are skipped rather than guessed: a wrong outcome tile books the wrong bet.
 */

import { selectionSide, teamSimilarity } from "./betslip-match.js";

const NUM = /(\d+(?:\.\d+)?)/;

/** Line of an over/under leg: selection first ("Over 2.5"), then the market, then the raw row. */
function lineOf(leg) {
  const fromSelection = NUM.exec(String(leg?.selection ?? ""));
  if (fromSelection) return fromSelection[1];

  const fromMarket = NUM.exec(String(leg?.market ?? ""));
  if (fromMarket) return fromMarket[1];

  const raw = String(leg?.rawText ?? "");
  const nearOverUnder = /(?:over|under)\s*(\d+(?:\.\d+)?)/i.exec(raw);
  if (nearOverUnder) return nearOverUnder[1];

  const fromRaw = NUM.exec(raw);
  return fromRaw ? fromRaw[1] : null;
}

function overUnder(totalLabel, leg) {
  const text = String(leg?.selection ?? "").toLowerCase();
  const side = /\bover\b/.test(text) ? "Over" : /\bunder\b/.test(text) ? "Under" : null;
  const line = lineOf(leg);
  if (!side || !line) return null;
  return { market: `Over/Under ${line} ${totalLabel}`, outcome: side };
}

/** "Bosnia or Draw" / "Draw or Austria" / "1X" -> the BetBoro double-chance label. */
function doubleChance(leg, match) {
  const selection = String(leg?.selection ?? "");
  const text = selection.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (text === "1x" || text.includes("homeordraw")) return "Home or Draw";
  if (text === "12" || text.includes("homeoraway")) return "Home or Away";
  if (text === "x2" || text.includes("draworaway")) return "Draw or Away";
  if (!text.includes("draw")) return null;

  const teamPart = selection
    .replace(/draw/gi, " ")
    .replace(/\bor\b|&|\/|\+/gi, " ")
    .trim();
  if (!teamPart) return null;

  const home = teamSimilarity(teamPart, match?.teams?.home?.name);
  const away = teamSimilarity(teamPart, match?.teams?.away?.name);
  if (Math.max(home, away) < 0.8 || Math.max(home, away) - Math.min(home, away) < 0.15) return null;
  return home > away ? "Home or Draw" : "Draw or Away";
}

function betboroMarket(leg, match) {
  const market = String(leg?.market ?? "").toLowerCase();
  const selection = String(leg?.selection ?? "").toLowerCase();

  if (/corner/.test(market)) return overUnder("Corners", leg);
  if (/booking|card/.test(market)) return overUnder("Bookings", leg);

  const teamTotal = /\b(?:home|away)\s+team\b|\bteam\s+(?:total|goals?)\b/.test(market);
  const matchTotal =
    /\bover\b|\bunder\b/.test(market) ||
    (/\btotal|\bgoals?\b/.test(market) && /\bover\b|\bunder\b/.test(selection));
  if (!teamTotal && matchTotal) return overUnder("Goals", leg);

  if (/double chance/.test(market)) {
    const outcome = doubleChance(leg, match);
    return outcome ? { market: "Double Chance", outcome } : null;
  }

  if (/draw no bet/.test(market)) {
    const side = selectionSide(leg, match);
    if (side === "home") return { market: "Draw No Bet: Home vs Away", outcome: "Home (DNB)" };
    if (side === "away") return { market: "Draw No Bet: Home vs Away", outcome: "Away (DNB)" };
    return null;
  }

  if (/gg\/ng|both teams|\bbtts\b/.test(market)) {
    if (/\byes\b/.test(selection)) return { market: "Both Teams to Score", outcome: "Yes" };
    if (/\bno\b/.test(selection)) return { market: "Both Teams to Score", outcome: "No" };
    if (/both teams|\bbtts\b/.test(selection)) return { market: "Both Teams to Score", outcome: "Yes" };
    return null;
  }

  const side = selectionSide(leg, match);
  if (side) {
    const outcome = side === "home" ? "Home" : side === "draw" ? "Draw" : "Away";
    return { market: "Match Result", outcome };
  }

  return null;
}

/**
 * @param {Array<{ leg: object, match: object, links?: { betboro?: string | null } }>} matchedLegs
 * @returns {{ legs: Array<{ url: string, market: string, outcome: string, odds: number | null, label: string }>, skipped: Array<{ leg: object, reason: string }> }}
 */
export function toBetBoroSelections(matchedLegs) {
  const legs = [];
  const skipped = [];

  for (const entry of Array.isArray(matchedLegs) ? matchedLegs : []) {
    const leg = entry?.leg ?? entry;
    const url = entry?.links?.betboro ?? null;

    if (!url) {
      skipped.push({ leg, reason: "missing-link" });
      continue;
    }

    const mapped = betboroMarket(leg, entry?.match);
    if (!mapped) {
      skipped.push({ leg, reason: "unsupported-market" });
      continue;
    }

    const odds = Number(leg?.odds);
    legs.push({
      url,
      market: mapped.market,
      outcome: mapped.outcome,
      odds: Number.isFinite(odds) && odds > 1 ? odds : null,
      label: `${leg?.market ?? ""} / ${leg?.selection ?? ""}`.trim(),
    });
  }

  return { legs, skipped };
}
