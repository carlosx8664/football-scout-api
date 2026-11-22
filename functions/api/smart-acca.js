import { matchBetslipLegs, toSportyBetSelections } from "../../shared/betslip-match.js";

const FOOTYSTATS_URL = "https://footystats.org/predictions/1x2";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const KV_BINDING = "FOOTBALL_DATA";
const MATCHES_KEY = "feed-matches";
const POOL_KEY = "feed-matches-pool";
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
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

function divBlock(markup, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(
    `<div\\b(?=[^>]*class=['"][^'"]*\\b${escaped}\\b[^'"]*['"])[^>]*>`,
    "gi",
  ).exec(markup);
  if (!open) return "";

  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = open.index;
  let depth = 0;
  let tag;
  while ((tag = tags.exec(markup))) {
    if (/^<\/div/i.test(tag[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return markup.slice(open.index, tags.lastIndex);
  }
  return "";
}

function parsePredictions(html, day) {
  const predictionList = divBlock(html, "predictionsList");
  if (!predictionList) throw new Error("FootyStats predictions list was not found.");

  const starts = [...predictionList.matchAll(/<div class=['"]betWrapper\b[^>]*>/gi)].map(
    (match) => match.index,
  );
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const matches = [];
  const seenFixtures = new Set();

  for (const [index, start] of starts.entries()) {
    const card = predictionList.slice(start, starts[index + 1] ?? predictionList.length);
    const market = classTexts(card, "market")[0];
    if (!["Home Win", "Draw", "Away Win"].includes(market)) continue;

    const data = classTexts(divBlock(card, "matchData"), "data");
    const [fixture, dateText, league] = data;
    const pair = fixture?.split(/\s+vs\.?\s+/i);
    const dateParts = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)/i.exec(dateText ?? "");
    if (!dateParts || !date || !pair || pair.length !== 2) continue;
    const fixtureKey = `${pair[0].trim().toLowerCase()}|${pair[1].trim().toLowerCase()}`;
    if (seenFixtures.has(fixtureKey)) continue;

    const month = MONTHS[dateParts[2].toLowerCase()];
    if (Number(dateParts[1]) !== Number(date[3]) || month !== Number(date[2])) continue;

    const odds = Number(classTexts(card, "betHeaderMeta")[0]?.match(/\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(odds) || odds <= 1) continue;
    seenFixtures.add(fixtureKey);

    const statTitles = classTexts(card, "statTitle");
    const statValues = classTexts(card, "statData");
    const stats = {};
    for (let stat = 0; stat < statTitles.length; stat += 1) {
      stats[statTitles[stat]] = {
        home: statValues[stat * 2] ?? "",
        away: statValues[stat * 2 + 1] ?? "",
      };
    }

    matches.push({
      home: pair[0].trim(),
      away: pair[1].trim(),
      league: league ?? "",
      market,
      odds,
      kickoff: dateText,
      stats,
    });
  }

  return matches;
}

async function loadFixtures({ request, env }) {
  const kv = env?.[KV_BINDING];
  if (kv) {
    try {
      const raw = await kv.get(MATCHES_KEY);
      const feed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(feed?.matches)) return feed.matches;
    } catch {
      // The static feed below remains available if KV is empty or malformed.
    }
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
            "Select exactly four distinct football matches from the supplied FootyStats 1X2 predictions. " +
            "Rank for the strongest evidence using the supplied outcome, odds, and team stats. " +
            "Do not invent facts or change a match's outcome. Prefer evidence-backed selections and " +
            "reasonable odds, not simply the shortest price. Return JSON only: " +
            '{"picks":[{"index":0,"confidence":0,"reason":"brief evidence-based reason"}]}. ' +
            "Confidence is your comparative assessment, not a probability or guarantee.",
        },
        { role: "user", content: JSON.stringify(matches) },
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
    const response = await fetch(FOOTYSTATS_URL, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0 (compatible; Oddtor/1.0; +https://footystats.org)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`FootyStats returned HTTP ${response.status}.`);
    const html = await response.text();
    const matches = parsePredictions(html, day);
    if (matches.length < 4) {
      return json(
        { error: `FootyStats has only ${matches.length} readable 1X2 predictions for ${day}.` },
        422,
      );
    }

    const alternatives = matches.filter(
      (match) => !excluded.has(`${match.home}|${match.away}|${match.market}`),
    );
    const candidates = alternatives.length >= 4 ? alternatives : matches;
    const picks = await rankWithGroq(candidates, env.SMART_ACCA_GROQ_API_KEY);
    const fixtures = [...(await loadFixtures({ request, env })), ...(await loadPool(env))];
    const matchedPicks = picks.map((pick) => {
      const leg = {
        home: pick.home,
        away: pick.away,
        market: "1X2",
        selection: pick.market,
      };
      const result = matchBetslipLegs([leg], fixtures);
      const entry = result.matched[0];
      const booking = entry ? toSportyBetSelections([entry]).bookings[0] : null;
      return { ...pick, booking: booking ?? null };
    });

    return json({
      day,
      source: FOOTYSTATS_URL,
      scrapedCount: matches.length,
      analyzedCount: candidates.length,
      matches: matchedPicks,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
