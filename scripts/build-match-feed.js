#!/usr/bin/env node
/**
 * Builds `public/matches.json` from the SportyBet and MSport snapshots so the site no
 * longer needs API-Football.
 *
 * Each source is normalised to { home, away, startTime, tournament, logos, odds }, merged
 * across bookmakers, filtered to the tracked leagues and the today+tomorrow window, and
 * written in the shape the React app already consumes (SnapshotData).
 *
 * Optionally asks DeepSeek for a two-sentence preview per match that has odds:
 *   DEEPSEEK_API_KEY=... node scripts/build-match-feed.js
 *
 * Usage:
 *   node scripts/build-match-feed.js                 # build public/matches.json
 *   node scripts/build-match-feed.js --no-ai         # skip DeepSeek
 *   node scripts/build-match-feed.js --days 3        # widen the window
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { LEAGUES } from "../shared/leagues.js";

const OUTPUT_FILE = "public/matches.json";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";
const AI_CONCURRENCY = 3;

const SOURCES = [
  { name: "SportyBet", file: "data/sportybet.json", readEvents: readSportyEvents },
  { name: "MSport", file: "data/msport.json", readEvents: readMsportEvents },
];

/**
 * API-Football league id -> `<country> <competition>` as named by both bookmakers.
 * Country scoping matters: "Championship", "Premier League" and "Serie A" exist in many
 * countries, so a tournament-only match mislabels foreign fixtures.
 */
const LEAGUE_ALIASES = {
  2: ["international clubs uefa champions league"],
  39: ["england premier league"],
  40: ["england championship"],
  45: ["england fa cup"],
  48: ["england efl cup", "england carabao cup"],
  61: ["france ligue 1"],
  71: ["brazil brasileiro serie a"],
  78: ["germany bundesliga"],
  88: ["netherlands eredivisie"],
  94: ["portugal liga portugal"],
  135: ["italy serie a"],
  140: ["spain laliga"],
  144: ["belgium pro league"],
  848: ["international clubs uefa conference league"],
};

const OUTCOMES = [
  { key: "home", label: "Home", short: "1" },
  { key: "draw", label: "Draw", short: "X" },
  { key: "away", label: "Away", short: "2" },
];

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 1 ? parsed : Number.NaN;
}

function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Stable numeric id so `/match/:id` links keep working across rebuilds. */
function fixtureId(key) {
  return Number.parseInt(createHash("sha1").update(key).digest("hex").slice(0, 8), 16);
}

function readMarketOdds(markets, marketId, resolveOutcome) {
  const market = (markets ?? []).find((entry) => String(entry?.id) === String(marketId));
  const odds = { home: Number.NaN, draw: Number.NaN, away: Number.NaN };

  for (const outcome of market?.outcomes ?? []) {
    const key = resolveOutcome(outcome);
    if (key) odds[key] = toNumber(outcome?.odds);
  }

  return odds;
}

function readSportyEvents(json) {
  const tournaments = json?.data?.tournaments ?? [];
  const events = [];

  for (const tournament of tournaments) {
    for (const event of tournament?.events ?? []) {
      events.push({
        home: event.homeTeamName,
        away: event.awayTeamName,
        startTime: Number(event.estimateStartTime),
        competition: normalize(`${tournament.categoryName} ${tournament.name}`),
        logos: { home: "", away: "" },
        odds: readMarketOdds(event.markets, 1, (outcome) => {
          const label = normalize(outcome?.desc);
          return OUTCOMES.find((entry) => normalize(entry.label) === label)?.key ?? null;
        }),
      });
    }
  }

  return events;
}

function readMsportEvents(json) {
  const tournaments = json?.data?.tournaments ?? [];
  const events = [];

  for (const tournament of tournaments) {
    for (const event of tournament?.events ?? []) {
      events.push({
        home: event.homeTeam,
        away: event.awayTeam,
        startTime: Number(event.startTime),
        competition: normalize(`${tournament.category} ${tournament.tournament}`),
        logos: { home: event.homeTeamIcon ?? "", away: event.awayTeamIcon ?? "" },
        odds: readMarketOdds(event.markets, 1, (outcome) => {
          const byId = { 1: "home", 2: "draw", 3: "away" };
          return byId[String(outcome?.id)] ?? null;
        }),
      });
    }
  }

  return events;
}

function buildLeagueIndex() {
  const index = new Map();

  for (const [id, aliases] of Object.entries(LEAGUE_ALIASES)) {
    const league = LEAGUES.find((entry) => entry.id === Number(id));
    if (!league) continue;
    for (const alias of aliases) index.set(normalize(alias), league);
  }

  return index;
}

function bestPrice(books, outcome) {
  let best = null;

  for (const [bookmaker, odds] of Object.entries(books)) {
    const price = odds?.[outcome];
    if (!Number.isFinite(price)) continue;
    if (!best || price > best.price) best = { price, bookmaker };
  }

  return best;
}

function roundPrice(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function toBookOdds(books) {
  const result = {};

  for (const outcome of OUTCOMES) {
    const best = bestPrice(books, outcome.key);
    result[outcome.key] = {
      sportybet: roundPrice(books.SportyBet?.[outcome.key]),
      msport: roundPrice(books.MSport?.[outcome.key]),
      best: best ? roundPrice(best.price) : null,
      bookmaker: best?.bookmaker ?? null,
    };
  }

  return result;
}

function toOddsArray(bookOdds) {
  const odds = OUTCOMES.flatMap((outcome) => {
    const price = bookOdds[outcome.key]?.best;
    return price === null ? [] : [{ value: outcome.label, odd: price.toFixed(2) }];
  });

  return odds.length === 3 ? odds : null;
}

/** Words that add no identifying value when comparing team names across bookmakers. */
const NAME_STOP_WORDS = new Set([
  "fc",
  "cf",
  "sc",
  "afc",
  "club",
  "the",
  "city",
  "town",
  "united",
  "utd",
]);

function nameTokens(name) {
  return normalize(name)
    .split(" ")
    .filter((token) => token && !NAME_STOP_WORDS.has(token));
}

/** Dice coefficient over identifying tokens: "Ipswich Town"/"Ipswich" -> 1. */
function similarity(left, right) {
  const a = new Set(nameTokens(left));
  const b = new Set(nameTokens(right));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Minimum average team similarity required to treat two events as the same fixture. */
const MERGE_THRESHOLD = 0.5;

function mergeEvents(events) {
  const [first] = events;
  const entry = {
    key: "",
    home: first.home,
    away: first.away,
    startTime: first.startTime,
    league: first.league,
    logos: { home: "", away: "" },
    books: {},
  };

  for (const event of events) {
    entry.books[event.source] = event.odds;
    entry.logos = {
      home: entry.logos.home || event.logos.home,
      away: entry.logos.away || event.logos.away,
    };
    // Bookmakers abbreviate differently; keep the longest spelling for display.
    if (event.home.length > entry.home.length) entry.home = event.home;
    if (event.away.length > entry.away.length) entry.away = event.away;
  }

  entry.key = `${normalize(entry.home)}|${normalize(entry.away)}|${first.startTime}`;
  return entry;
}

function buildPrompt(match) {
  const price = (label) =>
    match.odds?.find((entry) => entry.value === label)?.odd ?? "unknown";
  return (
    `You are a football betting analyst. The match is ${match.teams.home.name} vs ` +
    `${match.teams.away.name} in the ${match.league.name}. Current 1X2 odds: ` +
    `home ${price("Home")}, draw ${price("Draw")}, away ${price("Away")}. ` +
    "Write a two-sentence preview and no preamble."
  );
}

async function analyzeMatch(match, { apiKey, model, timeoutMs = 25_000 }) {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a concise football betting analyst. Reply with two short sentences and no preamble.",
        },
        { role: "user", content: buildPrompt(match) },
      ],
      reasoning_effort: "low",
      max_tokens: 400,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);

  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek returned an empty completion");
  return content;
}

async function mapLimit(items, limit, task) {
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

async function addAnalysis(matches, { apiKey, model, log }) {
  const targets = matches.filter((match) => match.odds);
  if (targets.length === 0) return;

  if (!apiKey) {
    log("::warning::DEEPSEEK_API_KEY is not set; skipping AI analysis.");
    return;
  }

  log(`Requesting AI analysis for ${targets.length} matches (${model})...`);
  let done = 0;

  await mapLimit(targets, AI_CONCURRENCY, async (match) => {
    try {
      match.ai_analysis = await analyzeMatch(match, { apiKey, model });
      done += 1;
    } catch (error) {
      match.ai_analysis = `AI analysis unavailable: ${error.message}`;
      log(`  AI failed for ${match.teams.home.name} vs ${match.teams.away.name}: ${error.message}`);
    }
  });

  log(`AI analyses: ${done}/${targets.length}.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "2" },
      out: { type: "string", default: OUTPUT_FILE },
      "no-ai": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const log = (line) => console.log(line);

  if (values.help) {
    console.log(
      "Usage: node scripts/build-match-feed.js [--days 2] [--out public/matches.json] [--no-ai]\n\n" +
        "Reads data/sportybet.json and data/msport.json.\n" +
        "Optional env: DEEPSEEK_API_KEY, DEEPSEEK_MODEL",
    );
    return;
  }

  const windowDays = Math.max(1, Number(values.days) || 2);
  const leagueIndex = buildLeagueIndex();
  // Same league + same kickoff time, so name variants can be paired by similarity.
  const buckets = new Map();

  for (const source of SOURCES) {
    let json;
    try {
      json = JSON.parse(await readFile(source.file, "utf8"));
    } catch (error) {
      log(`::warning::Could not read ${source.file}: ${error.message}`);
      continue;
    }

    const events = source.readEvents(json);
    let kept = 0;

    for (const event of events) {
      if (!event.home || !event.away || !Number.isFinite(event.startTime)) continue;

      const league = leagueIndex.get(event.competition);
      if (!league) continue;

      const bucketKey = `${league.id}|${event.startTime}`;
      const bucket = buckets.get(bucketKey) ?? { SportyBet: [], MSport: [] };
      bucket[source.name].push({ ...event, league, source: source.name });
      buckets.set(bucketKey, bucket);
      kept += 1;
    }

    log(`${source.name}: ${events.length} events, ${kept} in tracked leagues.`);
  }

  const merged = [];
  let paired = 0;

  for (const bucket of buckets.values()) {
    const available = [...bucket.MSport];

    for (const event of bucket.SportyBet) {
      let bestIndex = -1;
      let bestScore = 0;

      available.forEach((candidate, index) => {
        const score =
          (similarity(event.home, candidate.home) + similarity(event.away, candidate.away)) / 2;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      });

      if (bestIndex >= 0 && bestScore >= MERGE_THRESHOLD) {
        const partner = available.splice(bestIndex, 1)[0];
        merged.push(mergeEvents([event, partner]));
        paired += 1;
      } else {
        merged.push(mergeEvents([event]));
      }
    }

    for (const event of available) merged.push(mergeEvents([event]));
  }

  log(`Paired ${paired} fixtures across both bookmakers.`);

  if (merged.length === 0) {
    // Never replace a good feed with an empty one when the source dumps are absent.
    log(`::warning::No fixtures parsed; leaving ${values.out} untouched.`);
    return;
  }

  const start = todayUtc();
  const windowEnd = new Date(`${addDays(start, windowDays - 1)}T23:59:59.999Z`).getTime();
  const windowStart = new Date(`${start}T00:00:00.000Z`).getTime();

  const matches = merged
    .filter((entry) => entry.startTime >= windowStart && entry.startTime <= windowEnd)
    .sort((a, b) => a.startTime - b.startTime)
    .map((entry) => {
      const bookOdds = toBookOdds(entry.books);

      return {
        fixture: { id: fixtureId(entry.key), date: new Date(entry.startTime).toISOString() },
        league: entry.league,
        teams: {
          home: { name: entry.home, logo: entry.logos.home },
          away: { name: entry.away, logo: entry.logos.away },
        },
        goals: null,
        odds: toOddsArray(bookOdds),
        book_odds: bookOdds,
        ai_analysis: null,
      };
    });

  log(`Matches in ${start} + ${windowDays - 1} day window: ${matches.length}.`);

  if (matches.length === 0) {
    log(`::warning::No fixtures in the sync window; leaving ${values.out} untouched.`);
    return;
  }

  if (!values["no-ai"]) {
    await addAnalysis(matches, {
      apiKey: (process.env.DEEPSEEK_API_KEY ?? "").trim(),
      model: (process.env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL,
      log,
    });
  }

  const payload = {
    status: "success",
    date: start,
    window: { from: start, to: addDays(start, windowDays - 1) },
    generated_at: new Date().toISOString(),
    match_count: matches.length,
    analysed_count: matches.filter((match) => match.odds && match.ai_analysis).length,
    matches,
  };

  await writeFile(values.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  log(`Wrote ${values.out} (${matches.length} matches).`);
}

main().catch((error) => {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
});
