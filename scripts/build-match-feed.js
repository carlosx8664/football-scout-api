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
  { name: "BetBoro", file: "data/betboro.json", readEvents: readBetBoroEvents },
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
  71: ["brazil brasileiro serie a", "brazil brasileirao serie a"],
  78: ["germany bundesliga"],
  88: ["netherlands eredivisie"],
  94: ["portugal liga portugal", "portugal primeira liga"],
  119: ["denmark superliga"],
  135: ["italy serie a"],
  140: ["spain laliga"],
  144: ["belgium pro league"],
  203: ["turkiye super lig", "turkey super lig"],
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
        srId: String(event.eventId ?? ""),
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
        srId: String(event.eventId ?? ""),
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

/** BetBoro writes `{ generatedAt, fixtures: [...] }`; the 1X2 market is `match_result`. */
function readBetBoroEvents(json) {
  const fixtures = Array.isArray(json?.fixtures) ? json.fixtures : [];
  const events = [];
  const bySlot = { 0: "home", 1: "draw", 2: "away" };

  for (const fixture of fixtures) {
    const odds = { home: Number.NaN, draw: Number.NaN, away: Number.NaN };

    for (const [slot, outcome] of Object.entries(fixture?.markets?.match_result ?? {})) {
      const key = bySlot[slot];
      if (!key) continue;
      if (outcome?.status && outcome.status !== "available") continue;
      odds[key] = toNumber(outcome?.price);
    }

    events.push({
      srId: String(fixture?.eventId ?? ""),
      home: fixture?.home,
      away: fixture?.away,
      startTime: Number(fixture?.kickoff),
      competition: normalize(`${fixture?.region} ${fixture?.competition}`),
      logos: {
        home: fixture?.logos?.home ?? "",
        away: fixture?.logos?.away ?? "",
      },
      // BetBoro is the only book that needs more than the Sportradar id to build a deep link.
      bookIds: {
        betboro: {
          regionId: fixture?.regionId ?? null,
          competitionId: fixture?.competitionId ?? null,
          betBoroId: fixture?.betBoroId ?? null,
        },
      },
      odds,
    });
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
    const quotes = {};

    for (const [bookmaker, odds] of Object.entries(books)) {
      const price = roundPrice(odds?.[outcome.key]);
      if (price !== null) quotes[bookmaker] = price;
    }

    const best = bestPrice(books, outcome.key);
    result[outcome.key] = {
      books: quotes,
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

/**
 * Words that add no identifying value when comparing team names across bookmakers. Covers the
 * club affixes in `shared/teams.js` plus the connectors BetPawa puts between them
 * ("Atletico de Rafaela" -> {atletico, rafaela}).
 */
const NAME_STOP_WORDS = new Set([
  "fc", "cf", "sc", "afc", "club", "the", "city", "town", "united", "utd",
  "women", "wom", "wfc", "lfc",
  "ca", "cd", "ud", "sv", "bk", "fk", "nk", "sk", "rc", "sl", "ss", "ac", "as", "if", "ff",
  "de", "del", "do", "da", "dos", "das", "la", "le", "los", "las",
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
    // Every bookmaker uses Sportradar ids, so any valid one identifies the fixture.
    srId: "",
    // Per-bookmaker ids needed for deep links beyond the Sportradar id (BetBoro only).
    bookIds: {},
    home: first.home,
    away: first.away,
    startTime: first.startTime,
    league: first.league,
    logos: { home: "", away: "" },
    books: {},
  };

  for (const event of events) {
    if (!entry.srId && /^sr:match:\d+$/.test(event.srId ?? "")) entry.srId = event.srId;
    const betboroIds = event.bookIds?.betboro;
    if (!entry.bookIds.betboro && betboroIds?.betBoroId) entry.bookIds.betboro = betboroIds;
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

/**
 * BetBoro needs region + competition + fixture ids for its verified deep link; emit the block
 * only when the full set is present, so the client can fall back cleanly when it is not.
 */
function toBookIds(entry) {
  const betboro = entry.bookIds?.betboro;
  if (!betboro?.betBoroId || !betboro.regionId || !betboro.competitionId) return null;
  return { betboro };
}

/** BoltBet's 1X2 market is `winner3`; other markets are not part of the feed. */
function boltBetOneXTwo(event) {
  const odds = { home: null, draw: null, away: null };

  for (const market of Object.values(event?.betting?.markets ?? {})) {
    if (market?.hidden || !market?.open || market.type !== "winner3") continue;
    for (const [optionKey, option] of Object.entries(market.options ?? {})) {
      if (option?.state !== "active" || !(optionKey in odds)) continue;
      const price = Number(option.odds);
      if (Number.isFinite(price) && price > 1) odds[optionKey] = price;
    }
  }

  return odds;
}

/** BetPawa's dump already stores 1X2 as `odds.home` / `odds.draw` / `odds.away`. */
function betPawaOneXTwo(event) {
  const odds = {};

  for (const key of ["home", "draw", "away"]) {
    const price = Number(event?.odds?.[key]);
    if (Number.isFinite(price) && price > 1) odds[key] = price;
  }

  return odds;
}

/**
 * Adds one bookmaker's 1X2 prices to an already-built match and re-derives the best price, so
 * the per-book breakdown can list every book that quotes the outcome.
 */
function addBookQuotes(match, bookmaker, odds) {
  const bookOdds = match?.book_odds;
  if (!bookOdds || !odds) return false;

  let added = false;

  for (const { key } of OUTCOMES) {
    const price = roundPrice(odds[key]);
    const side = bookOdds[key];
    if (price === null || !side) continue;

    side.books = { ...side.books, [bookmaker]: price };
    if (side.best === null || price > side.best) {
      side.best = price;
      side.bookmaker = bookmaker;
    }
    added = true;
  }

  if (!added) return false;

  const best = OUTCOMES.map(({ key }) => bookOdds[key]?.best);
  match.odds = best.every((price) => typeof price === "number")
    ? OUTCOMES.map(({ label }, index) => ({ value: label, odd: best[index].toFixed(2) }))
    : null;

  return true;
}

/**
 * BoltBet and BetPawa have fixture ids but no Sportradar ids, so they cannot join the merge
 * above. They are attached to the built matches by team names instead; BoltBet is confirmed by
 * kickoff too, BetPawa's dump has no kickoff (it is today-only). Their 1X2 prices come along so
 * the breakdown shows every bookmaker we track.
 */
async function attachBoltBetIds(matches, log) {
  let json;
  try {
    json = JSON.parse(await readFile("data/boltbet.json", "utf8"));
  } catch (error) {
    log(`::warning::Skipping BoltBet fixture links: ${error.message}`);
    return;
  }

  const events = [];
  for (const event of json?.events ?? []) {
    const fixture = event?.fixture;
    const names = fixture?.translations?.en?.[0]?.values;
    const startTime = new Date(fixture?.metadata?.startedAt ?? fixture?.startsAt ?? 0).getTime();
    if (!fixture?.slug || !names?.home || !names?.away) continue;
    if (!Number.isFinite(startTime) || startTime <= 0) continue;
    events.push({
      slug: fixture.slug,
      home: names.home,
      away: names.away,
      startTime,
      odds: boltBetOneXTwo(event),
    });
  }

  const KICKOFF_TOLERANCE_MS = 2 * 60 * 60 * 1000;
  let attached = 0;
  let priced = 0;

  for (const match of matches) {
    const kickoff = new Date(match.fixture.date).getTime();
    let best = null;
    let bestScore = 0;

    for (const event of events) {
      if (Math.abs(event.startTime - kickoff) > KICKOFF_TOLERANCE_MS) continue;
      const score =
        (similarity(match.teams.home.name, event.home) +
          similarity(match.teams.away.name, event.away)) /
        2;
      if (score > bestScore) {
        best = event;
        bestScore = score;
      }
    }

    if (best && bestScore >= MERGE_THRESHOLD) {
      match.book_ids = { ...(match.book_ids ?? {}), boltbet: { boltbetSlug: best.slug } };
      if (addBookQuotes(match, "BoltBet", best.odds)) priced += 1;
      attached += 1;
    }
  }

  log(`BoltBet fixture links: ${attached}/${matches.length} (${priced} with 1X2 prices).`);
}

async function attachBetPawaIds(matches, log) {
  let json;
  try {
    json = JSON.parse(await readFile("data/betpawa.json", "utf8"));
  } catch (error) {
    log(`::warning::Skipping BetPawa fixture links: ${error.message}`);
    return;
  }

  const events = [];
  for (const event of json?.events ?? []) {
    const id = String(event?.eventId ?? "").replace(/^betpawa:/, "");
    if (!/^\d+$/.test(id) || !event?.home || !event?.away) continue;
    events.push({
      id,
      home: event.home,
      away: event.away,
      odds: betPawaOneXTwo(event),
    });
  }

  // The dump has no kickoff, so a name match has to be unambiguous: a stray pairing would send
  // the user to the wrong fixture page. It only holds today + tomorrow at fetch time, which is
  // the feed window itself, so every built match is a candidate.
  const candidates = matches;
  const taken = new Set();
  let attached = 0;
  let priced = 0;

  for (const event of events) {
    let best = null;
    let bestScore = 0;
    let runnerUp = 0;

    for (const match of candidates) {
      if (taken.has(match.fixture.id)) continue;
      const score =
        (similarity(match.teams.home.name, event.home) +
          similarity(match.teams.away.name, event.away)) /
        2;
      if (score > bestScore) {
        runnerUp = bestScore;
        best = match;
        bestScore = score;
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    }

    if (best && bestScore >= 0.8 && bestScore - runnerUp >= 0.1) {
      best.book_ids = { ...(best.book_ids ?? {}), betpawa: { betpawaId: event.id } };
      if (addBookQuotes(best, "BetPawa", event.odds)) priced += 1;
      taken.add(best.fixture.id);
      attached += 1;
    }
  }

  log(`BetPawa fixture links: ${attached}/${candidates.length} (${priced} with 1X2 prices).`);
}

const ANALYSIS_SYSTEM_PROMPT = [
  "You are a football tipster texting a mate before kick-off.",
  "Sound like a person: casual, direct, a bit opinionated. No corporate language,",
  "no 'as an AI', no bullet-point marketing.",
  "You have no live feed: never state injuries, suspensions, line-ups, transfers or",
  "head-to-head records as fact. If the call depends on team news, say so plainly and tell",
  "them to check the lineup. Use only the odds you are given plus general knowledge of how",
  "these teams play.",
  "Max 160 words: a short read on the 1X2 prices, then three lines with other angles",
  "(BTTS, over/under 2.5, corners, cards). Be honest when you would swerve a market.",
].join(" ");

function buildPrompt(match) {
  const price = (label) =>
    match.odds?.find((entry) => entry.value === label)?.odd ?? "unknown";
  return (
    `Match: ${match.teams.home.name} vs ${match.teams.away.name}\n` +
    `Competition: ${match.league.name}\n` +
    `Kick-off: ${match.fixture.date}\n` +
    `1X2 odds: ${price("Home")} / ${price("Draw")} / ${price("Away")}`
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
        { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: buildPrompt(match) },
      ],
      temperature: 0.7,
      // Thinking mode is on by default and can consume the whole token budget, returning an
      // empty `content`. These short notes do not need it.
      thinking: { type: "disabled" },
      max_tokens: 900,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);

  const body = await response.json();
  const choice = body?.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    const finish = choice?.finish_reason ?? "unknown";
    throw new Error(`DeepSeek returned an empty completion (finish_reason=${finish})`);
  }
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
      suffix: { type: "string", default: "" },
      "no-ai": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const log = (line) => console.log(line);

  if (values.help) {
    console.log(
      "Usage: node scripts/build-match-feed.js [--days 2] [--out public/matches.json] [--suffix=-horizon] [--no-ai]\n\n" +
        "Reads data/sportybet.json, data/msport.json and data/betboro.json for fixtures and odds,\n" +
        "plus data/boltbet.json and data/betpawa.json for their fixture-page ids.\n" +
        "Optional env: DEEPSEEK_API_KEY, DEEPSEEK_MODEL",
    );
    return;
  }

  const windowDays = Math.max(1, Number(values.days) || 2);
  const leagueIndex = buildLeagueIndex();
  // `--suffix=-horizon` reads the horizon snapshots only, so a stale committed hot file
  // can never be merged into the horizon feed.
  const sources = SOURCES.map((source) => ({
    ...source,
    file: values.suffix ? source.file.replace(/\.json$/, `${values.suffix}.json`) : source.file,
  }));
  // Every bookmaker uses Sportradar ids ("sr:match:..."), so join on that. The league+kickoff
  // bucket with name similarity stays as a fallback for events without an id.
  const bySrId = new Map();
  const buckets = new Map();

  for (const source of sources) {
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

      const enriched = { ...event, league, source: source.name };
      const srId = String(event.srId ?? "");

      if (/^sr:match:\d+$/.test(srId)) {
        const group = bySrId.get(srId) ?? [];
        group.push(enriched);
        bySrId.set(srId, group);
      } else {
        const bucketKey = `${league.id}|${event.startTime}`;
        const bucket = buckets.get(bucketKey) ?? [];
        bucket.push(enriched);
        buckets.set(bucketKey, bucket);
      }

      kept += 1;
    }

    log(`${source.name}: ${events.length} events, ${kept} in tracked leagues.`);
  }

  const merged = [];
  let paired = 0;

  for (const group of bySrId.values()) {
    if (group.length > 1) paired += 1;
    merged.push(mergeEvents(group));
  }

  // Fallback for events without a Sportradar id: same league, same kickoff, similar names.
  for (const bucket of buckets.values()) {
    const taken = new Set();
    const placed = [];

    for (const event of bucket) {
      let partner = null;
      for (const candidate of bucket) {
        if (candidate === event || taken.has(candidate) || candidate.source === event.source) {
          continue;
        }
        const score =
          (similarity(event.home, candidate.home) + similarity(event.away, candidate.away)) / 2;
        if (score >= MERGE_THRESHOLD) {
          partner = candidate;
          break;
        }
      }

      if (placed.includes(event)) continue;
      placed.push(event);

      if (partner) {
        taken.add(partner);
        placed.push(partner);
        merged.push(mergeEvents([event, partner]));
        paired += 1;
      } else {
        merged.push(mergeEvents([event]));
      }
    }
  }

  log(`Paired ${paired} fixtures across bookmakers.`);

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
        // Sportradar id lets the client deep-link the same fixture on SportyBet / MSport.
        sr_id: /^sr:match:\d+$/.test(entry.srId) ? entry.srId : null,
        // Per-book ids for books that cannot be reached with the Sportradar id alone.
        book_ids: toBookIds(entry),
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

  await attachBoltBetIds(matches, log);
  await attachBetPawaIds(matches, log);

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
