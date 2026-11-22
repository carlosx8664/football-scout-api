import {
  matchBetslipLegs,
  selectionSide,
  teamSimilarity,
  toSportyBetSelections,
} from "../../shared/betslip-match.js";

const SPORTYTRADER_URL = "https://www.sportytrader.com/en/betting-tips/football/today/";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq shut down llama-3.3-70b-versatile on 2026-08-16 (404 model_not_found); gpt-oss-120b is its
// documented replacement. SMART_ACCA_GROQ_MODEL overrides it without a deploy.
const GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
const KV_BINDING = "FOOTBALL_DATA";
const MATCHES_KEY = "feed-matches";
const HORIZON_KEY = "feed-matches-horizon";
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function text(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function classTexts(markup, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<([a-z][\\w:-]*)\\b(?=[^>]*class=['"][^'"]*\\b${escaped}\\b[^'"]*['"])[^>]*>([\\s\\S]*?)<\\/\\1>`,
    "gi",
  );
  return [...markup.matchAll(pattern)].map((match) => text(match[2]));
}

const DIV_TAG = /<\/?div\b(?:"[^"]*"|'[^']*'|[^>])*>/gi;
const CARD_DATE = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4}),\s*(\d{2}:\d{2})/;

function tagEnd(markup, index) {
  let quote = null;
  for (let cursor = index; cursor < markup.length; cursor += 1) {
    const char = markup[cursor];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return cursor + 1;
    }
  }
  return -1;
}

function divBlock(markup, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`class=['"][^'"]*\\b${escaped}\\b[^'"]*['"]`, "i").exec(markup);
  if (!marker) return "";

  const open = markup.lastIndexOf("<div", marker.index);
  if (open === -1) return "";
  const openEnd = tagEnd(markup, open);
  if (openEnd === -1) return "";

  const tags = new RegExp(DIV_TAG.source, "gi");
  tags.lastIndex = open;
  let depth = 0;
  let tag;
  while ((tag = tags.exec(markup))) {
    if (/^<\/div/i.test(tag[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return markup.slice(open, tags.lastIndex);
  }
  return markup.slice(open, openEnd);
}

function resultSelection(tip, home, away) {
  const normalize = (value) =>
    String(value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  const prediction = normalize(tip);
  if (["draw", "matchdraw", "endsinadraw"].includes(prediction)) return "Draw";
  if (["homewin", "homewins", "hometowin", "1"].includes(prediction)) return "Home Win";
  if (["awaywin", "awaywins", "awaytowin", "2"].includes(prediction)) return "Away Win";

  const team = prediction.replace(/(?:wins?|towin)$/, "");
  if (team && team === normalize(home)) return "Home Win";
  if (team && team === normalize(away)) return "Away Win";
  return null;
}

const OU_LINE = /^(over|under)\s+(\d+(?:\.\d+)?)/;

/**
 * A SportyTrader tip -> the SportyBet market/selection that books it.
 *
 * Only single markets are accepted: "BTTS & over 2.5 goals" needs a same-game multi, which the
 * share endpoint cannot book, so those cards are skipped rather than guessed.
 */
function tipMarket(tip, home, away) {
  const raw = text(tip);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (/\s(?:&|and)\s/.test(lower) || /\bbtts\b.*\bover\b/.test(lower)) return null;

  if (/\bbtts\b|both teams to score/.test(lower)) {
    return { market: "Both Teams to Score", selection: /\bno\b/.test(lower) ? "No" : "Yes" };
  }

  const ou = OU_LINE.exec(lower);
  if (ou) {
    const market = /corner/.test(lower)
      ? "Corners"
      : /\bcard|booking/.test(lower)
        ? "Bookings"
        : "Over/Under";
    const side = ou[1] === "over" ? "Over" : "Under";
    return { market, selection: `${side} ${ou[2]}` };
  }

  const teamOrDraw = /^(.*\S)\s+or\s+draw$/i.exec(raw) ?? /^draw\s+or\s+(.+)$/i.exec(raw);
  if (teamOrDraw) {
    const team = teamOrDraw[1].trim();
    const homeScore = teamSimilarity(team, home);
    const awayScore = teamSimilarity(team, away);
    if (Math.max(homeScore, awayScore) < 0.6) return null;
    return {
      market: "Double Chance",
      selection: homeScore >= awayScore ? "Home or Draw" : "Draw or Away",
    };
  }

  const side = resultSelection(raw, home, away);
  return side ? { market: "1X2", selection: side } : null;
}

function sameDay(dateParts, date) {
  if (!dateParts || !date) return false;
  const month = MONTHS[dateParts[2].toLowerCase()];
  return (
    Number(dateParts[1]) === Number(date[3]) &&
    month === Number(date[2]) &&
    Number(dateParts[3]) === Number(date[1])
  );
}

/** The "SportyTrader 1X2 model" table below the cards: many more fixtures, model-derived pick. */
function modelTablePredictions(html, day) {
  const start = html.indexOf('id="auto-predictions"');
  if (start === -1) return [];

  const outcomes = { "1": "Home Win", X: "Draw", "2": "Away Win" };
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const rows = html
    .slice(start)
    .split(/class="[^"]*\bborder-primary-grayborder\b[^"]*"/i)
    .slice(1);
  const matches = [];

  for (const row of rows) {
    const [home, away] = [...row.matchAll(/alt="([^"]+)"/g)].map((match) => text(match[1]));
    const pickMatch = /class="[^"]*\bbg-primary-green\b[^"]*"[^>]*>\s*([^<]*?)\s*</i.exec(row);
    const selection = pickMatch ? outcomes[pickMatch[1].toUpperCase()] ?? null : null;
    const dateText = classTexts(row, "text-xs").find((value) => CARD_DATE.test(value)) ?? "";
    const league = classTexts(row, "text-sm")[0] ?? "";
    const probability = /Probability of\s*(\d+)%/i.exec(row);

    if (!home || !away || !selection) continue;
    if (!sameDay(CARD_DATE.exec(dateText), date)) continue;

    matches.push({
      home,
      away,
      league,
      market: "1X2",
      selection,
      sourceTip: `SportyTrader 1X2 model${probability ? ` (${probability[1]}%)` : ""}`,
      modelProbability: probability ? Number(probability[1]) : null,
      kickoff: dateText,
    });
  }

  return matches;
}

function parsePredictions(html, day) {
  if (/cf-chl-|Just a moment\.\.\.|Enable JavaScript and cookies/i.test(html)) {
    throw new Error("SportyTrader blocked the server-side page request.");
  }

  const predictionList = divBlock(html, "pronostics-wrapper");
  const cards = predictionList
    .split(/data-navigation-url-value=['"][^'"]*\/en\/betting-tips\//i)
    .slice(1);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const matches = [];
  // One card per fixture, but a fixture can offer several markets, and the same market can
  // appear twice; keep the fixture+market+selection triple unique instead.
  const seen = new Set();

  for (const card of cards) {
    const [home, away] = classTexts(card, "font-semibold");
    const dateText = classTexts(card, "font-bold").find((value) => CARD_DATE.test(value)) ?? "";
    const metaText = classTexts(card, "text-sm").find((value) => CARD_DATE.test(value)) ?? "";
    const league = metaText.replace(/^.*?\d{2}:\d{2}\s*/, "").trim();
    const tipMatch =
      /<a\b[^>]*data-trans=['"]tips\.our\.tip\.card[^'"]*['"][^>]*>[\s\S]*?<\/a>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(
        card,
      );
    const tip = tipMatch ? text(tipMatch[1]) : "";
    const market = tipMarket(tip, home, away);
    if (!home || !away || !market) continue;
    if (!sameDay(CARD_DATE.exec(dateText), date)) continue;

    const key = `${home.toLowerCase()}|${away.toLowerCase()}|${market.market}|${market.selection}`;
    if (seen.has(key)) continue;
    seen.add(key);

    matches.push({
      home,
      away,
      league,
      market: market.market,
      selection: market.selection,
      sourceTip: tip,
      kickoff: dateText,
    });
  }

  for (const pick of modelTablePredictions(html, day)) {
    const key = `${pick.home.toLowerCase()}|${pick.away.toLowerCase()}|${pick.market}|${pick.selection}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(pick);
  }

  if (matches.length === 0 && !predictionList) {
    throw new Error("SportyTrader's today's predictions list was not found.");
  }
  return matches;
}

function hasPrice(match) {
  return Boolean(match?.book_odds) || (Array.isArray(match?.odds) && match.odds.length > 0);
}

const squashName = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The hot/horizon feed and the booking pool can describe the same fixture. Feeding both to the
 * matcher makes every duplicate pair score identically, which the matcher rejects as ambiguous —
 * so collapse them, keeping the copy that actually carries odds.
 */
function uniqueFixtures(lists) {
  const byKey = new Map();
  for (const match of lists.flat()) {
    const key =
      `${squashName(match?.teams?.home?.name)}|${squashName(match?.teams?.away?.name)}` ||
      String(match?.fixture?.id ?? "");
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing || (!hasPrice(existing) && hasPrice(match))) byKey.set(key, match);
  }
  return [...byKey.values()];
}

async function kvMatches(kv, key) {
  try {
    const raw = await kv.get(key);
    const feed = raw ? JSON.parse(raw) : null;
    return Array.isArray(feed?.matches) ? feed.matches : [];
  } catch {
    return [];
  }
}

async function loadFixtures({ request, env }) {
  const kv = env?.[KV_BINDING];
  if (kv) {
    const [hot, horizon] = await Promise.all([
      kvMatches(kv, MATCHES_KEY),
      kvMatches(kv, HORIZON_KEY),
    ]);
    const byId = new Map();
    for (const match of horizon) byId.set(String(match?.fixture?.id ?? `${match?.teams?.home?.name}|${match?.teams?.away?.name}`), match);
    for (const match of hot) byId.set(String(match?.fixture?.id ?? `${match?.teams?.home?.name}|${match?.teams?.away?.name}`), match);
    if (byId.size) return [...byId.values()];
  }

  const response = await fetch(new URL("/matches.json", request.url), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Match feed unavailable (HTTP ${response.status}).`);

  const feed = await response.json().catch(() => null);
  if (!Array.isArray(feed?.matches)) throw new Error("Match feed is malformed.");
  return feed.matches;
}

/**
 * The booking pool (`feed-matches-pool`) is deliberately not used here: its rows carry no 1X2
 * prices, so they could never survive the odds step, and their duplicate team names only made
 * the matcher reject the priced copy as ambiguous.
 */

const STANDINGS_COMPETITIONS = {
  1: "WC",
  2: "CL",
  39: "PL",
  40: "ELC",
  61: "FL1",
  71: "BSA",
  78: "BL1",
  88: "DED",
  94: "PPL",
  135: "SA",
  140: "PD",
};
const STANDINGS_BASE = "https://api.football-data.org/v4";
const STANDINGS_CACHE_PREFIX = "smartacca-standings-v1-";
const USED_PREFIX = "smart-acca-used-";

/* ---------------------------------------------------------------- SportyBet prices
 *
 * `book_odds` in the match feed is 1X2 only, so goals/corners/bookings/BTTS/double-chance tips
 * had no price. SportyBet's event endpoint lists every market this panel can book, so only the
 * fixtures with a non-1X2 tip are fetched, and only the bookable outcomes are cached.
 */
const SPORTYBET_EVENT_URL = "https://www.sportybet.com/api/gh/factsCenter/event";
const EVENT_CACHE_PREFIX = "sb-event-odds-v1-";
const EVENT_CACHE_TTL = 300;
const EVENT_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en",
  Clientid: "web",
  Operid: "3",
  Platform: "web",
  Cookie: "sb_country=gh; locale=en;",
  Referer: "https://www.sportybet.com/gh/sport/football",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

const priceKey = (marketId, outcomeId, specifier) =>
  `${marketId}|${outcomeId}|${specifier || ""}`;

/** Every outcome the panel can book, keyed by market/outcome/specifier, with the book's own price. */
function indexEventOdds(body) {
  const markets = Array.isArray(body?.data?.markets) ? body.data.markets : [];
  const prices = {};
  for (const market of markets) {
    const marketId = String(market?.id ?? "");
    if (!marketId) continue;
    const specifier = String(market?.specifier ?? "");
    for (const outcome of market?.outcomes ?? []) {
      const odds = Number(outcome?.odds);
      if (!Number.isFinite(odds) || odds <= 1) continue;
      const key = priceKey(marketId, String(outcome?.id ?? ""), specifier);
      if (!prices[key]) prices[key] = odds;
    }
  }
  return prices;
}

async function loadEventOdds(env, eventIds) {
  const kv = env?.[KV_BINDING];
  const prices = new Map();
  const pending = [];

  for (const eventId of eventIds) {
    const cacheKey = `${EVENT_CACHE_PREFIX}${eventId}`;
    if (kv) {
      try {
        const cached = await kv.get(cacheKey);
        if (cached) {
          prices.set(eventId, JSON.parse(cached));
          continue;
        }
      } catch {
        // Fall through to the network.
      }
    }
    pending.push(eventId);
  }

  const CONCURRENCY = 4;
  for (let index = 0; index < pending.length; index += CONCURRENCY) {
    const batch = pending.slice(index, index + CONCURRENCY);
    await Promise.all(
      batch.map(async (eventId) => {
        try {
          const response = await fetch(
            `${SPORTYBET_EVENT_URL}?eventId=${encodeURIComponent(eventId)}&productId=3`,
            { headers: EVENT_HEADERS, signal: AbortSignal.timeout(12_000) },
          );
          if (!response.ok) return;
          const body = await response.json().catch(() => null);
          const indexed = indexEventOdds(body);
          if (Object.keys(indexed).length === 0) return;
          prices.set(eventId, indexed);
          if (kv) {
            try {
              await kv.put(`${EVENT_CACHE_PREFIX}${eventId}`, JSON.stringify(indexed), {
                expirationTtl: EVENT_CACHE_TTL,
              });
            } catch {
              // A cache miss next time only costs one request.
            }
          }
        } catch {
          // An unpriced candidate is dropped later; the rest of the batch still prices.
        }
      }),
    );
  }

  return prices;
}

const STOP_WORDS = new Set([
  "fc", "cf", "sc", "afc", "club", "the", "city", "town", "united", "utd", "calcio", "ac", "as",
]);
const DAY_SECONDS = 24 * 60 * 60;

function nameTokens(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
}

function nameSimilarity(left, right) {
  const a = new Set(nameTokens(left));
  const b = new Set(nameTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

async function loadStandings(env, code) {
  const kv = env?.[KV_BINDING];
  const cacheKey = `${STANDINGS_CACHE_PREFIX}${code}`;
  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch {
      // A cache miss or hiccup only costs one request.
    }
  }

  const token = String(env?.FOOTBALL_DATA_ORG_TOKEN ?? "").trim();
  if (!token) return null;

  try {
    const response = await fetch(`${STANDINGS_BASE}/competitions/${code}/standings`, {
      headers: { "X-Auth-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const tables = Array.isArray(body?.standings) ? body.standings : [];
    const total = tables.find((entry) => entry?.type === "TOTAL") ?? tables[0];
    const table = (Array.isArray(total?.table) ? total.table : []).map((row) => ({
      name: String(row?.team?.name ?? ""),
      shortName: String(row?.team?.shortName ?? row?.team?.name ?? ""),
      position: Number(row?.position ?? 0),
      played: Number(row?.playedGames ?? 0),
      points: Number(row?.points ?? 0),
      form: String(row?.form ?? ""),
      goalsFor: Number(row?.goalsFor ?? 0),
      goalsAgainst: Number(row?.goalsAgainst ?? 0),
    }));

    if (kv && table.length) {
      try {
        await kv.put(cacheKey, JSON.stringify(table), { expirationTtl: 1800 });
      } catch {
        // Serving the table matters more than caching it.
      }
    }
    return table;
  } catch {
    return null;
  }
}

function standingFor(table, name) {
  if (!Array.isArray(table) || !name) return null;
  let best = null;
  let bestScore = 0;
  for (const row of table) {
    const score = Math.max(nameSimilarity(name, row.name), nameSimilarity(name, row.shortName));
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/** League position, points, form and goal record for both sides, when the competition is covered. */
async function addStandingsContext(env, matches) {
  const codes = new Set();
  for (const match of matches) {
    const code = STANDINGS_COMPETITIONS[Number(match.leagueId)];
    if (code) codes.add(code);
  }
  if (codes.size === 0) return matches;

  const tables = new Map();
  await Promise.all(
    [...codes].map(async (code) => {
      tables.set(code, await loadStandings(env, code));
    }),
  );

  return matches.map((match) => {
    const table = tables.get(STANDINGS_COMPETITIONS[Number(match.leagueId)]);
    const home = standingFor(table, match.home);
    const away = standingFor(table, match.away);
    if (!home && !away) return match;
    return {
      ...match,
      standings: {
        home: home
          ? { position: home.position, played: home.played, points: home.points, form: home.form, goalsFor: home.goalsFor, goalsAgainst: home.goalsAgainst }
          : null,
        away: away
          ? { position: away.position, played: away.played, points: away.points, form: away.form, goalsFor: away.goalsFor, goalsAgainst: away.goalsAgainst }
          : null,
      },
    };
  });
}

async function readUsed(kv, day) {
  if (!kv) return new Set();
  try {
    const raw = await kv.get(`${USED_PREFIX}${day}`);
    const parsed = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed?.keys) ? parsed.keys : []);
  } catch {
    return new Set();
  }
}

async function addUsed(kv, day, keys) {
  if (!kv || keys.length === 0) return 0;
  const used = await readUsed(kv, day);
  const before = used.size;
  for (const key of keys) used.add(key);
  try {
    await kv.put(`${USED_PREFIX}${day}`, JSON.stringify({ keys: [...used] }), {
      expirationTtl: DAY_SECONDS * 2,
    });
  } catch {
    return 0;
  }
  return used.size - before;
}

const pickKey = (match) => `${match.home}|${match.away}|${match.market ?? "1X2"}`;

async function rankWithGroq(matches, apiKey, preferredModel) {
  const messages = [
    {
      role: "system",
      content:
        "You are a football betting analyst picking the four best bets of the day, which are " +
        "combined into one accumulator. Candidates span several markets: 1X2, double chance, " +
        "both teams to score, and over/under on goals, corners and bookings. " +
        "For every candidate you receive the market and selection, the SportyTrader editorial tip " +
        "or model probability, the live SportyBet price, and — when the competition is covered — " +
        "both teams' league position, points, points-per-game, recent form string (most recent " +
        "last) and goal record. " +
        "Judge each selection independently and estimate its TRUE probability of winning, from 1 " +
        "to 99 percent. Weigh the tip, price, table gap, recent form, goals scored and conceded, " +
        "and how that fixture's profile fits the market (a leaky pair of defences lifts overs and " +
        "both-teams-to-score; a lopsided table gap lifts the favourite's result and double chance). " +
        "Then choose the four with the best combination of high win probability and value against " +
        "the price, one leg per fixture. Do not spread probabilities into a tidy sequence and do " +
        "not copy the example number. " +
        "You have no injury, suspension, team-news or head-to-head feed, so never claim to know " +
        "line-ups, injuries, transfers or past meetings — reason only from the data supplied. " +
        "Do not invent facts or change a selection. Return JSON only in this exact shape: " +
        '{"picks":[{"index":0,"probability":64}]}. ' +
        "Use each candidate's position in the input array as index, and probability as that " +
        "selection's estimated chance of winning in whole percent (never 0, 1 or a 0-1 fraction).",
    },
    {
      role: "user",
      content: JSON.stringify(
        matches.map(
          ({ home, away, league, market, selection, sourceTip, modelProbability, odds, kickoff, standings }) => ({
            home,
            away,
            league,
            market,
            selection,
            source: sourceTip,
            sportyTraderProbability: modelProbability ?? null,
            sportyBetOdds: odds,
            bookImpliedProbability: Number.isFinite(Number(odds))
              ? Number((100 / Number(odds)).toFixed(1))
              : null,
            kickoff,
            standings: standings ?? null,
          }),
        ),
      ),
    },
  ];

  const models = [...new Set([preferredModel, ...GROQ_MODELS].filter(Boolean))];

  const callGroq = async (extra) => {
    const send = extra ? [...messages, ...extra] : messages;
    let lastError = "";
    let response = null;

    // Groq retires model ids (404/400 model_not_found), so fall through the known-good list
    // instead of failing the whole refresh.
    for (const model of models) {
      response = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 1600,
          response_format: { type: "json_object" },
          messages: send,
        }),
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) break;

      const detail = await response.text().catch(() => "");
      lastError = detail.slice(0, 240);
      const modelProblem =
        (response.status === 404 || response.status === 400) && /model/i.test(detail);
      if (!modelProblem) break;
    }

    if (!response?.ok) {
      throw new Error(
        `Groq analysis failed (HTTP ${response?.status ?? 0})${lastError ? `: ${lastError}` : "."}`,
      );
    }
    const payload = await response.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Groq returned an empty analysis.");
    }

    try {
      return JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    } catch {
      throw new Error("Groq returned an unreadable analysis.");
    }
  };

  let result = await callGroq(null);
  let picks = toPicks(result);
  if (picks.every((pick) => pick.probability === picks[0].probability)) {
    // Four identical probabilities means the model ranked by position instead of judging each
    // selection; ask once more before showing a flat bar.
    try {
      const retried = toPicks(
        await callGroq([
          {
            role: "user",
            content:
              "Every pick was given the same probability. Estimate each selection's own chance of " +
              "winning separately from the data supplied, whole percent 1-99, and return the JSON again.",
          },
        ]),
      );
      if (!retried.every((pick) => pick.probability === retried[0].probability)) picks = retried;
    } catch {
      // Keep the first answer rather than failing the refresh.
    }
  }
  return picks;

  function toPicks(body) {
    if (!Array.isArray(body?.picks) || body.picks.length !== 4) {
      throw new Error("Groq did not return exactly four predictions. Refresh to try again.");
    }

    const seen = new Set();
    const seenFixtures = new Set();
    const normalizeProbability = (value) => {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return null;
      // Models sometimes answer on a 0-1 scale (or copy the example literally), so widen those.
      const scaled = raw > 0 && raw <= 1 ? raw * 100 : raw;
      return Math.min(99, Math.max(1, Math.round(scaled)));
    };

    return body.picks.map((pick) => {
      const index = Number(pick?.index);
      const probability = normalizeProbability(pick?.probability ?? pick?.confidence);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= matches.length ||
        seen.has(index) ||
        probability === null
      ) {
        throw new Error("Groq returned invalid or duplicate prediction indexes.");
      }
      const fixtureKey = `${matches[index].home.toLowerCase()}|${matches[index].away.toLowerCase()}`;
      if (seenFixtures.has(fixtureKey)) {
        throw new Error("Groq selected the same fixture more than once.");
      }
      seen.add(index);
      seenFixtures.add(fixtureKey);
      return { ...matches[index], probability };
    });
  }
}

export async function onRequestPost({ request, env }) {
  if (!env?.SMART_ACCA_GROQ_API_KEY) {
    return json(
      { error: "SmartACCA needs SMART_ACCA_GROQ_API_KEY configured on the dashboard server." },
      503,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body containing today's date." }, 400);
  }
  const day = typeof body?.day === "string" ? body.day : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    return json({ error: "A valid local date is required." }, 400);
  }
  const excluded = new Set(
    Array.isArray(body?.exclude)
      ? body.exclude.filter((item) => typeof item === "string").slice(0, 40)
      : [],
  );

  const mark = Array.isArray(body?.mark)
    ? body.mark.filter((item) => typeof item === "string").slice(0, 8)
    : [];
  const kv = env?.[KV_BINDING];

  if (body?.reset === true) {
    if (kv) {
      try {
        await kv.delete(`${USED_PREFIX}${day}`);
      } catch {
        return json({ error: "Could not reset today's used picks." }, 502);
      }
    }
    return json({ day, reset: true });
  }

  // The panel reports the batch it just slipped or logged, so refreshing moves on to the next
  // strongest picks instead of offering the same four again.
  if (mark.length > 0) {
    const added = await addUsed(kv, day, mark);
    return json({ day, marked: mark.length, added });
  }

  try {
    const response = await fetch(SPORTYTRADER_URL, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://www.sportytrader.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`SportyTrader returned HTTP ${response.status}.`);
    const html = await response.text();
    const scrapedMatches = parsePredictions(html, day);
    const fixtures = uniqueFixtures([await loadFixtures({ request, env })]);
    const now = Date.now();

    // 1. Book each tip against a feed fixture: this decides the SportyBet market/outcome pair.
    const booked = scrapedMatches.flatMap((pick) => {
      const leg = {
        home: pick.home,
        away: pick.away,
        market: pick.market,
        selection: pick.selection,
      };
      const entry = matchBetslipLegs([leg], fixtures).matched[0];
      if (!entry) return [];

      // A fixture that has kicked off can no longer be booked, so it never reaches the slip.
      const kickoffAt = Date.parse(entry.match?.fixture?.date ?? "");
      if (Number.isFinite(kickoffAt) && kickoffAt <= now) return [];

      const booking = toSportyBetSelections([entry]).bookings[0];
      if (!booking) return [];

      return [
        {
          ...pick,
          league: entry.match?.league?.name || pick.league,
          leagueId: entry.match?.league?.id ?? null,
          booking,
          kickoffAt,
          feedMatch: entry.match,
        },
      ];
    });

    // 2. Price them. 1X2 comes from the feed; deeper markets need SportyBet's own event book.
    const deeperEvents = [
      ...new Set(
        booked.filter((pick) => pick.booking.marketId !== "1").map((pick) => pick.booking.eventId),
      ),
    ];
    const eventOdds = await loadEventOdds(env, deeperEvents);

    const matches = booked.flatMap((pick) => {
      let odds = NaN;
      if (pick.booking.marketId === "1") {
        const side = selectionSide({ market: pick.market, selection: pick.selection }, pick.feedMatch);
        const feedOdds = (pick.feedMatch?.odds ?? []).find(
          (row) => String(row?.value ?? "").toLowerCase() === side,
        );
        odds =
          Number(pick.feedMatch?.book_odds?.[side]?.books?.SportyBet) ||
          Number(pick.feedMatch?.book_odds?.[side]?.best) ||
          Number(feedOdds?.odd);
      } else {
        const prices = eventOdds.get(pick.booking.eventId);
        odds = Number(
          prices?.[
            priceKey(pick.booking.marketId, pick.booking.outcomeId, pick.booking.specifier)
          ],
        );
      }
      if (!Number.isFinite(odds) || odds <= 1) return [];

      const { feedMatch, ...rest } = pick;
      return [{ ...rest, odds }];
    });

    if (matches.length < 4) {
      return json(
        {
          error:
            scrapedMatches.length === 0
              ? `SportyTrader's page had no readable predictions for ${day}. ` +
                "Most cards still use other markets, so try again later in the day."
              : `SportyTrader has ${scrapedMatches.length} readable tips for ${day}, but only ` +
                `${matches.length} are still unstarted and priced by SportyBet.`,
        },
        422,
      );
    }

    const used = await readUsed(kv, day);
    const unused = matches.filter(
      (match) => !excluded.has(pickKey(match)) && !used.has(pickKey(match)),
    );

    // Never repeat a batch that was already slipped or logged: report exhaustion instead, so the
    // panel can offer to reset the day's list rather than silently re-serving the same four.
    if (unused.length < 4) {
      return json(
        {
          error:
            `Only ${unused.length} fresh pick(s) left for ${day} — ${used.size} already slipped or logged. ` +
            "Refreshing later picks up newly published tips, or reset today's list to start over.",
          exhausted: true,
          usedCount: used.size,
          availableCount: unused.length,
        },
        409,
      );
    }

    const enriched = await addStandingsContext(env, unused);
    const picks = (
      await rankWithGroq(enriched, env.SMART_ACCA_GROQ_API_KEY, env.SMART_ACCA_GROQ_MODEL)
    ).map(({ standings, ...pick }) => pick);

    return json({
      day,
      source: SPORTYTRADER_URL,
      scrapedCount: scrapedMatches.length,
      analyzedCount: unused.length,
      usedCount: used.size,
      matches: picks,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
