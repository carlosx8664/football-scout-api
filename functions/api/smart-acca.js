import { matchBetslipLegs, toSportyBetSelections } from "../../shared/betslip-match.js";

const SPORTYTRADER_URL = "https://www.sportytrader.com/en/betting-tips/football/today/";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const KV_BINDING = "FOOTBALL_DATA";
const MATCHES_KEY = "feed-matches";
const HORIZON_KEY = "feed-matches-horizon";
const POOL_KEY = "feed-matches-pool";
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
  const seenFixtures = new Set();

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
    const selection = resultSelection(tip, home, away);
    if (!home || !away || !selection) continue;
    if (!sameDay(CARD_DATE.exec(dateText), date)) continue;

    const fixtureKey = `${home.toLowerCase()}|${away.toLowerCase()}`;
    if (seenFixtures.has(fixtureKey)) continue;
    seenFixtures.add(fixtureKey);

    matches.push({
      home,
      away,
      league,
      market: "1X2",
      selection,
      sourceTip: tip,
      kickoff: dateText,
    });
  }

  for (const pick of modelTablePredictions(html, day)) {
    const fixtureKey = `${pick.home.toLowerCase()}|${pick.away.toLowerCase()}`;
    if (seenFixtures.has(fixtureKey)) continue;
    seenFixtures.add(fixtureKey);
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

async function loadPool(env) {
  const kv = env?.[KV_BINDING];
  if (!kv) return [];

  try {
    const raw = await kv.get(POOL_KEY);
    const pool = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(pool?.fixtures)) return [];
    return pool.fixtures.map((row) => ({
      fixture: { id: Number(row.id), date: row.kickoff ?? null },
      sr_id: row.sr_id ?? null,
      league: { id: null, name: row.league ?? "", logo: null },
      teams: {
        home: { name: row.home, logo: null },
        away: { name: row.away, logo: null },
      },
      odds: null,
      book_odds: null,
    }));
  } catch {
    return [];
  }
}

async function rankWithGroq(matches, apiKey) {
  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Select exactly four distinct football matches from the supplied SportyTrader predictions. " +
            "Rank the explicit 1X2 selections using the editorial tip and live SportyBet odds. " +
            "Do not invent facts or change a match's outcome. Prefer evidence-backed selections and " +
            "reasonable odds, not simply the shortest price. Return JSON only: " +
            '{"picks":[{"index":0,"confidence":0,"reason":"brief evidence-based reason"}]}. ' +
            "Confidence is your comparative assessment, not a probability or guarantee.",
        },
        {
          role: "user",
          content: JSON.stringify(
            matches.map(({ home, away, league, selection, sourceTip, odds, kickoff }) => ({
              home,
              away,
              league,
              selection,
              sourceTip,
              sportyBetOdds: odds,
              kickoff,
            })),
          ),
        },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`Groq analysis failed (HTTP ${response.status}).`);
  const payload = await response.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Groq returned an empty analysis.");
  }

  let result;
  try {
    result = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error("Groq returned an unreadable analysis.");
  }

  if (!Array.isArray(result?.picks) || result.picks.length !== 4) {
    throw new Error("Groq did not return exactly four predictions. Refresh to try again.");
  }

  const seen = new Set();
  const seenFixtures = new Set();
  return result.picks.map((pick) => {
    const index = Number(pick?.index);
    const confidence = Number(pick?.confidence);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= matches.length ||
      seen.has(index) ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 100
    ) {
      throw new Error("Groq returned invalid or duplicate prediction indexes.");
    }
    const fixtureKey = `${matches[index].home.toLowerCase()}|${matches[index].away.toLowerCase()}`;
    if (seenFixtures.has(fixtureKey)) {
      throw new Error("Groq selected the same fixture more than once.");
    }
    seen.add(index);
    seenFixtures.add(fixtureKey);
    return {
      ...matches[index],
      confidence,
      reason: typeof pick.reason === "string" ? pick.reason.slice(0, 240) : "",
    };
  });
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
      ? body.exclude.filter((item) => typeof item === "string").slice(0, 4)
      : [],
  );

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
    const fixtures = uniqueFixtures([await loadFixtures({ request, env }), await loadPool(env)]);
    const matches = scrapedMatches.flatMap((pick) => {
      const leg = {
        home: pick.home,
        away: pick.away,
        market: "1X2",
        selection: pick.selection,
      };
      const result = matchBetslipLegs([leg], fixtures);
      const entry = result.matched[0];
      if (!entry) return [];

      const side =
        pick.selection === "Home Win" ? "home" : pick.selection === "Away Win" ? "away" : "draw";
      const feedOdds = (entry.match?.odds ?? []).find(
        (row) => String(row?.value ?? "").toLowerCase() === side,
      );
      const odds =
        Number(entry.match?.book_odds?.[side]?.books?.SportyBet) ||
        Number(entry.match?.book_odds?.[side]?.best) ||
        Number(feedOdds?.odd);
      if (!Number.isFinite(odds) || odds <= 1) return [];

      const booking = toSportyBetSelections([entry]).bookings[0];
      if (!booking) return [];
      return [{ ...pick, odds, booking }];
    });
    if (matches.length < 4) {
      return json(
        {
          error:
            scrapedMatches.length === 0
              ? `SportyTrader's page had no readable 1X2 result tips for ${day}. ` +
                "Most cards still use other markets, so try again later in the day."
              : `SportyTrader has ${scrapedMatches.length} readable 1X2 tips for ${day}, but only ` +
                `${matches.length} also have matching SportyBet fixtures and prices.`,
        },
        422,
      );
    }

    const alternatives = matches.filter(
      (match) => !excluded.has(`${match.home}|${match.away}|${match.market}`),
    );
    const candidates = alternatives.length >= 4 ? alternatives : matches;
    const picks = await rankWithGroq(candidates, env.SMART_ACCA_GROQ_API_KEY);

    return json({
      day,
      source: SPORTYTRADER_URL,
      scrapedCount: scrapedMatches.length,
      analyzedCount: candidates.length,
      matches: picks,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
