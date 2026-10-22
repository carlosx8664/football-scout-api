#!/usr/bin/env node
/**
 * Today + tomorrow data sync (API-Football free-plan compatible).
 *
 * The free API-Football plan only allows a one-day-either-side window and rejects `from`/`to`
 * range queries for the current season, so each target league is queried separately for today
 * and tomorrow. Odds are requested per target-league fixture, capped by a per-run request
 * budget so two daily runs stay inside the 100 requests/day allowance.
 *
 * Today's matches older than the 4-hour grace period are dropped; future-day matches are kept.
 * Matches with odds get a DeepSeek analysis, and the result is stored in Cloudflare KV under
 * `snapshot-latest` (plus a dated copy). The site reads only from KV, so visitor traffic can
 * never consume the quota.
 *
 * Usage:
 *   node scripts/sync.js                 # sync + upload to KV
 *   node scripts/sync.js --dry-run       # sync, print a summary, skip the upload
 *   node scripts/sync.js --out file.json # also write the payload locally
 *   node scripts/sync.js --date 2026-10-20
 */
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import axios from "axios";
import { LEAGUES, LEAGUE_IDS } from "../shared/leagues.js";

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEEPSEEK_DIRECT_URL = "https://api.deepseek.com/chat/completions";
const SNAPSHOT_KEY_PREFIX = "snapshot-";
/** Mirrors the key the Pages Function reads. */
const LATEST_SNAPSHOT_KEY = "snapshot-latest";

export const DEFAULTS = {
  model: "deepseek-flash",
  /** Query fixtures for today and tomorrow. */
  windowDays: 2,
  maxFixtureRequestsPerRun: 32,
  gracePeriodMs: 4 * 60 * 60 * 1000,
  aiConcurrency: 3,
  peakWarningThreshold: 75,
  timeoutMs: 20000,
  retries: 2,
};

export class QuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hasErrors(errors) {
  if (!errors) return false;
  return Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0;
}

function isQuotaError(errors) {
  return /day|limit|quota|requests/i.test(JSON.stringify(errors));
}

function permanentError(message) {
  const error = new Error(message);
  error.noRetry = true;
  return error;
}

async function withRetry(
  task,
  { retries = DEFAULTS.retries, retryDelayMs = 2000, label = "request", log = () => {} } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (error instanceof QuotaError || error.noRetry || attempt >= retries) throw error;
      const waitMs = retryDelayMs * (attempt + 1);
      log(`  ${label} failed (${error.message}); retry ${attempt + 1}/${retries} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
}

async function mapLimit(items, limit, task) {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  let inFlight = 0;
  let peak = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        await task(items[index], index);
      } finally {
        inFlight -= 1;
      }
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
  return { peak };
}

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * @param {string} date YYYY-MM-DD
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * Match-winner (bet id 1) prices from the first bookmaker that offers them.
 * Takes a single entry of the `/odds` response.
 */
export function pickMatchWinnerOdds(entry) {
  const bookmakers = entry?.bookmakers ?? [];
  for (const bookmaker of bookmakers) {
    const bet = (bookmaker.bets ?? []).find((candidate) => candidate.id === 1);
    if (bet?.values?.length) return bet.values;
  }
  return null;
}

/**
 * Per-day match counts, average load and peak day for the synced window.
 */
export function dailyMetrics(matches) {
  const counts = new Map();
  for (const match of matches) {
    const day = String(match?.fixture?.date ?? "").slice(0, 10);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const days = [...counts.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const total = days.reduce((sum, entry) => sum + entry.count, 0);
  const peak = days.reduce(
    (best, entry) => (entry.count > best.count ? entry : best),
    { day: null, count: 0 },
  );

  return {
    total,
    activeDays: days.length,
    averagePerActiveDay: days.length ? total / days.length : 0,
    peakDay: peak.day,
    peakCount: peak.count,
    days,
  };
}

function buildPrompt({ homeTeam, awayTeam, odds }) {
  let oddsText = "Odds are not yet available for this match.";
  if (odds && odds.length >= 3) {
    const price = (label) => odds.find((entry) => entry.value === label)?.odd;
    const home = price("Home");
    const draw = price("Draw");
    const away = price("Away");
    if (home && draw && away) {
      oddsText = `The current odds are: ${homeTeam} to win: ${home}, Draw: ${draw}, ${awayTeam} to win: ${away}.`;
    }
  }
  return `You are a football betting analyst. The match is ${homeTeam} vs ${awayTeam}. ${oddsText} Based on your general knowledge, write a 2-sentence summary.`;
}

function publicMatch(match) {
  return {
    fixture: match.fixture,
    league: match.league,
    teams: match.teams,
    goals: match.goals ?? null,
    odds: match.odds ?? null,
    ai_analysis: match.ai_analysis ?? null,
  };
}

export function createApiFootball({
  apiKey,
  timeoutMs = DEFAULTS.timeoutMs,
  retries = DEFAULTS.retries,
  retryDelayMs = 2000,
  log = () => {},
}) {
  let apiRequestMade = false;
  const http = axios.create({
    baseURL: API_FOOTBALL_BASE,
    timeout: timeoutMs,
    headers: {
      "x-apisports-key": apiKey,
      "User-Agent": "football-scout-sync/1.0",
    },
    validateStatus: () => true,
  });

  async function request(path, params, label) {
    return withRetry(
      async () => {
        if (apiRequestMade) await sleep(6500);
        apiRequestMade = true;
        const response = await http.get(path, { params });
        if (path === "/odds") console.log(response.data);
        const payload = response.data ?? {};

        if (response.status === 429) {
          throw new QuotaError(`API-Football rate/quota limit reached for ${path} (HTTP 429)`);
        }
        if (hasErrors(payload.errors)) {
          const message = `API-Football rejected ${path}: ${JSON.stringify(payload.errors)}`;
          if (isQuotaError(payload.errors)) throw new QuotaError(message);
          // A rejected request will not succeed on retry (bad key, plan restriction, ...).
          throw permanentError(`${message} (HTTP ${response.status})`);
        }
        if (response.status >= 500) {
          // Retryable: transient API-Football outage.
          throw new Error(`API-Football HTTP ${response.status} for ${path}`);
        }
        if (response.status >= 400) {
          throw permanentError(`API-Football HTTP ${response.status} for ${path}`);
        }

        return {
          payload,
          remaining: response.headers["x-ratelimit-requests-remaining"] ?? null,
        };
      },
      { label, log, retries, retryDelayMs },
    );
  }

  return {
    fixturesByDate(date, page = 1) {
      const params = { date, timezone: "UTC", ...(page > 1 ? { page } : {}) };
      return request("/fixtures", params, `fixtures ${date} p${page}`);
    },
    oddsByFixture(fixtureId) {
      return request("/odds", { fixture: fixtureId }, `odds fixture ${fixtureId}`);
    },
  };
}

export function createDeepSeek({
  apiKey,
  model = DEFAULTS.model,
  accountId = "",
  gatewayId = "",
  aigToken = "",
  timeoutMs = DEFAULTS.timeoutMs,
  retries = DEFAULTS.retries,
  retryDelayMs = 2000,
  log = () => {},
}) {
  const useGateway = Boolean(accountId && gatewayId);
  const endpoint = useGateway
    ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/deepseek/chat/completions`
    : DEEPSEEK_DIRECT_URL;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (useGateway && aigToken) headers["cf-aig-authorization"] = `Bearer ${aigToken}`;

  const http = axios.create({ timeout: timeoutMs, validateStatus: () => true });

  async function analyze({ homeTeam, awayTeam, odds }) {
    return withRetry(
      async () => {
        const response = await http.post(
          endpoint,
          {
            model,
            messages: [
              {
                role: "system",
                content:
                  "You are a concise football betting analyst. Reply with two short sentences and no preamble.",
              },
              { role: "user", content: buildPrompt({ homeTeam, awayTeam, odds }) },
            ],
            reasoning_effort: "low",
            max_tokens: 400,
            stream: false,
          },
          { headers },
        );

        if (response.status === 429 || response.status >= 500) {
          throw new Error(`DeepSeek HTTP ${response.status}`);
        }
        if (response.status >= 400) {
          throw permanentError(
            `DeepSeek HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`,
          );
        }

        const content = response.data?.choices?.[0]?.message?.content?.trim();
        if (!content) throw new Error("DeepSeek returned an empty completion");
        return content;
      },
      { label: `${homeTeam} vs ${awayTeam}`, log, retries, retryDelayMs },
    );
  }

  return { analyze, endpoint, model, viaGateway: useGateway };
}

async function collectFixtures({ apiFootball, days, requestBudget, log }) {
  const fixtures = [];
  const seen = new Set();
  let requests = 0;
  let remaining = null;
  let quotaExhausted = false;
  const totalPagesByDay = new Map();
  const nextPageByDay = new Map();

  const fetchPage = async (day, page) => {
    requests += 1;
    const result = await apiFootball.fixturesByDate(day, page);
    remaining = result.remaining ?? remaining;
    totalPagesByDay.set(
      day,
      Math.max(1, Number(result.payload?.paging?.total ?? 1) || 1),
    );

    for (const fixture of result.payload?.response ?? []) {
      const id = fixture?.fixture?.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      fixtures.push(fixture);
    }
  };

  for (const day of days) {
    if (requests >= requestBudget) break;
    try {
      await fetchPage(day, 1);
      nextPageByDay.set(day, 2);
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      quotaExhausted = true;
      log(`::warning::${error.message}`);
      log("Stopping fixture requests for the rest of this run.");
      break;
    }
  }

  while (!quotaExhausted && requests < requestBudget) {
    let pageFetched = false;
    for (const day of days) {
      const page = nextPageByDay.get(day);
      if (page == null || page > (totalPagesByDay.get(day) ?? 1)) continue;
      if (requests >= requestBudget) break;

      try {
        await fetchPage(day, page);
        nextPageByDay.set(day, page + 1);
        pageFetched = true;
      } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
        quotaExhausted = true;
        log(`::warning::${error.message}`);
        log("Stopping fixture requests for the rest of this run.");
        break;
      }
    }
    if (quotaExhausted || !pageFetched) break;
  }

  const pagesAvailable = [...totalPagesByDay.values()].reduce((sum, total) => sum + total, 0);
  if (!quotaExhausted && requests < pagesAvailable) {
    log(
      `::warning::Fixture pagination reached its request cap after ${requests} page(s); ` +
        `${pagesAvailable - requests} page(s) remain.`,
    );
  }

  return { fixtures, requests, remaining, quotaExhausted, pagesAvailable };
}

async function collectOdds({ apiFootball, fixtures, stopOnQuota, log }) {
  const oddsByFixture = new Map();
  let requests = 0;
  let quotaExhausted = Boolean(stopOnQuota);

  const ingest = (payload) => {
    for (const entry of payload?.response ?? []) {
      const fixtureId = entry?.fixture?.id;
      if (fixtureId == null) continue;
      const values = pickMatchWinnerOdds(entry);
      if (values) oddsByFixture.set(fixtureId, values);
    }
  };

  for (const fixture of fixtures) {
    if (quotaExhausted) break;

    const fixtureId = fixture?.fixture?.id;
    if (fixtureId == null) continue;

    requests += 1;
    try {
      const { payload } = await apiFootball.oddsByFixture(fixtureId);
      ingest(payload);
    } catch (error) {
      if (!(error instanceof QuotaError)) throw error;
      quotaExhausted = true;
      log(`::warning::${error.message}`);
      log("Stopping odds requests for the rest of this run.");
    }
  }

  return { oddsByFixture, requests, quotaExhausted };
}

export async function buildSnapshot({
  date,
  apiFootball,
  deepseek = null,
  windowDays = DEFAULTS.windowDays,
  gracePeriodMs = DEFAULTS.gracePeriodMs,
  aiConcurrency = DEFAULTS.aiConcurrency,
  peakWarningThreshold = DEFAULTS.peakWarningThreshold,
  now = Date.now(),
  log = () => {},
}) {
  const days = Array.from({ length: windowDays }, (_, index) => addDays(date, index));

  const fixturesResult = await collectFixtures({
    apiFootball,
    days,
    requestBudget: DEFAULTS.maxFixtureRequestsPerRun,
    log,
  });
  let requestsUsed = fixturesResult.requests;
  let quotaExhausted = fixturesResult.quotaExhausted;
  const remaining = fixturesResult.remaining;

  console.log(
    "Sample league IDs:",
    fixturesResult.fixtures.slice(0, 5).map((fixture) => fixture.league?.id),
  );
  const inTargetLeagues = fixturesResult.fixtures.filter((match) =>
    LEAGUE_IDS.includes(match.league?.id),
  );
  console.log("Matches passed target league filter:", inTargetLeagues.length);

  log(
    `Fixtures: ${fixturesResult.fixtures.length} fetched from ${LEAGUES.length} target leagues over ${days.length} days ` +
      `(${inTargetLeagues.length} in target leagues; quota left: ${remaining ?? "unknown"}).`,
  );

  const cutoff = now - gracePeriodMs;
  const isInSyncWindow = (match) => {
    const kickoff = new Date(match.fixture.date).getTime();
    const fixtureDay = String(match.fixture.date).slice(0, 10);
    return fixtureDay > date || (fixtureDay === date && kickoff > cutoff);
  };
  const oddsCandidates = inTargetLeagues
    .filter(isInSyncWindow)
    .sort((a, b) => String(a.fixture.date).localeCompare(String(b.fixture.date)));
  const odds = await collectOdds({
    apiFootball,
    fixtures: oddsCandidates,
    stopOnQuota: quotaExhausted,
    log,
  });
  requestsUsed += odds.requests;
  quotaExhausted = odds.quotaExhausted;
  log(
    `Odds: ${odds.oddsByFixture.size} fixtures matched using ${odds.requests} per-fixture request(s) ` +
      `(${oddsCandidates.length} eligible target-league fixtures).`,
  );

  log(`API-Football requests used this run: ${requestsUsed}.`);

  const matches = inTargetLeagues
    .map((match) => ({ ...match, odds: odds.oddsByFixture.get(match.fixture?.id) ?? null }))
    .filter(isInSyncWindow)
    .sort((a, b) => String(a.fixture.date).localeCompare(String(b.fixture.date)));

  log(
    `Keeping ${matches.length} matches in the sync window (dropped ${inTargetLeagues.length - matches.length} past/expired).`,
  );

  const metrics = dailyMetrics(matches);
  log(`Total active matches in the ${windowDays}-day window: ${metrics.total}`);
  log(
    `Active days: ${metrics.activeDays} | average per active day: ${metrics.averagePerActiveDay.toFixed(1)}`,
  );
  if (metrics.peakDay) log(`Peak day: ${metrics.peakDay} with ${metrics.peakCount} matches`);

  for (const { day, count } of metrics.days) {
    if (count > peakWarningThreshold) {
      log(`⚠️ PEAK DAY WARNING: ${day} has ${count} matches. Manual review recommended.`);
    }
  }

  const analysable = matches.filter((match) => match.odds);
  let analysablePeak = 0;

  if (analysable.length === 0) {
    log("No matches with odds; skipping AI analysis.");
  } else if (!deepseek) {
    analysable.forEach((match) => {
      match.ai_analysis = "AI analysis skipped: DEEPSEEK_API_KEY is not configured.";
    });
    log("::warning::DEEPSEEK_API_KEY is not set; skipping AI analysis.");
  } else {
    log(`Requesting AI analysis for ${analysable.length} matches (${deepseek.model})...`);
    const { peak } = await mapLimit(analysable, aiConcurrency, async (match) => {
      try {
        match.ai_analysis = await deepseek.analyze({
          homeTeam: match.teams.home.name,
          awayTeam: match.teams.away.name,
          odds: match.odds,
        });
        match.aiOk = true;
      } catch (error) {
        match.ai_analysis = `AI analysis unavailable: ${error.message}`;
        log(`  AI failed for ${match.teams.home.name} vs ${match.teams.away.name}: ${error.message}`);
      }
    });
    analysablePeak = peak;
  }

  const analysedCount = analysable.filter((match) => match.aiOk).length;
  log(`AI analyses: ${analysedCount}/${analysable.length} (concurrency ${aiConcurrency}).`);

  return {
    status: "success",
    date,
    window: { from: date, to: addDays(date, windowDays - 1) },
    generated_at: new Date().toISOString(),
    quota_remaining: remaining ?? "Unknown",
    quota_exhausted: quotaExhausted,
    requests_used: requestsUsed,
    match_count: matches.length,
    odds_count: analysable.length,
    analysed_count: analysedCount,
    metrics,
    odds_requests: odds.requests,
    ai_concurrency: { limit: aiConcurrency, peak: analysablePeak },
    matches: matches.map(publicMatch),
  };
}

export async function uploadToKv({ accountId, namespaceId, apiToken, key, snapshot, log = () => {} }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;

  const response = await axios.put(url, JSON.stringify(snapshot), {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    timeout: DEFAULTS.timeoutMs,
    maxBodyLength: Infinity,
    validateStatus: () => true,
  });

  if (response.status >= 300 || response.data?.success === false) {
    const detail = JSON.stringify(response.data?.errors ?? response.data).slice(0, 300);
    throw new Error(`KV upload failed (HTTP ${response.status}): ${detail}`);
  }

  log(`Uploaded ${key} to KV (${snapshot.matches.length} matches).`);
  return response.data;
}

function required(env, name) {
  const value = (env[name] ?? "").trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function runSync({
  env = process.env,
  log = console.log,
  dryRun = false,
  outFile = null,
  date = (env.SYNC_DATE || "").trim() || todayUtc(),
  now = Date.now(),
} = {}) {
  const apiFootball = createApiFootball({ apiKey: required(env, "API_FOOTBALL_KEY"), log });
  const deepseekKey = (env.DEEPSEEK_API_KEY ?? "").trim();
  const deepseek = deepseekKey
    ? createDeepSeek({
        apiKey: deepseekKey,
        model: (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULTS.model,
        accountId: (env.CF_ACCOUNT_ID ?? "").trim(),
        gatewayId: (env.CF_GATEWAY_ID ?? "").trim(),
        aigToken: (env.CF_AIG_TOKEN ?? "").trim(),
        log,
      })
    : null;

  log(`Syncing ${date} + ${DEFAULTS.windowDays - 1} days...`);

  const snapshot = await buildSnapshot({
    date,
    apiFootball,
    deepseek,
    aiConcurrency: Number(env.AI_CONCURRENCY ?? DEFAULTS.aiConcurrency),
    now,
    log,
  });

  if (outFile) {
    await writeFile(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    log(`Wrote ${outFile}`);
  }

  const key = `${SNAPSHOT_KEY_PREFIX}${date}`;

  if (dryRun) {
    log(`Dry run: skipping the KV upload for ${LATEST_SNAPSHOT_KEY} and ${key}.`);
    return snapshot;
  }

  if (snapshot.matches.length === 0) {
    log("No matches found. Skipping KV upload to preserve previous data.");
    return snapshot;
  }

  const target = {
    accountId: required(env, "CF_ACCOUNT_ID"),
    namespaceId: required(env, "CF_KV_NAMESPACE_ID"),
    apiToken: required(env, "CF_API_TOKEN"),
    snapshot,
    log,
  };

  await uploadToKv({ ...target, key: LATEST_SNAPSHOT_KEY });
  // Dated copy kept as an archive; the site only reads snapshot-latest.
  await uploadToKv({ ...target, key });

  return snapshot;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      date: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(
      "Usage: node scripts/sync.js [--dry-run] [--out <file>] [--date <YYYY-MM-DD>]\n\n" +
        "Required env: API_FOOTBALL_KEY, CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID, CF_API_TOKEN\n" +
        "Optional env: DEEPSEEK_API_KEY, DEEPSEEK_MODEL, CF_GATEWAY_ID, CF_AIG_TOKEN,\n" +
        "              AI_CONCURRENCY, SYNC_DATE",
    );
    return;
  }

  await runSync({
    dryRun: values["dry-run"],
    outFile: values.out ?? null,
    date: values.date ?? ((process.env.SYNC_DATE || "").trim() || todayUtc()),
  });
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`Sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
