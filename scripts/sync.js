#!/usr/bin/env node
/**
 * Rolling 7-day data sync.
 *
 * Fetches fixtures for the tracked leagues over a 7-day window, attaches match-winner odds
 * from a single `/odds` request, keeps only matches that are still relevant (4-hour grace
 * period), adds a DeepSeek analysis for matches with odds, then stores the result in
 * Cloudflare KV under `snapshot-latest` (plus a dated copy). The site reads only from KV,
 * so visitor traffic can never consume the API-Football quota.
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
import { LEAGUE_IDS } from "../shared/leagues.js";

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";
const DEEPSEEK_DIRECT_URL = "https://api.deepseek.com/chat/completions";
const SNAPSHOT_KEY_PREFIX = "snapshot-";
/** Mirrors the key the Pages Function reads. */
const LATEST_SNAPSHOT_KEY = "snapshot-latest";

export const DEFAULTS = {
  model: "deepseek-flash",
  windowDays: 7,
  gracePeriodMs: 4 * 60 * 60 * 1000,
  aiConcurrency: 3,
  peakWarningThreshold: 75,
  /** API-Football paginates /odds (10 fixtures per page); 1 keeps it to a single request. */
  oddsMaxPages: 1,
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
        const response = await http.get(path, { params });
        const payload = response.data ?? {};

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
    fixturesByRange(from, to) {
      // API-Football rejects from/to without an extra parameter (timezone or league).
      return request("/fixtures", { from, to, timezone: "UTC" }, `fixtures ${from}..${to}`);
    },
    oddsByRange(from, to, page = 1) {
      const params = page > 1 ? { from, to, timezone: "UTC", page } : { from, to, timezone: "UTC" };
      return request("/odds", params, `odds ${from}..${to} page ${page}`);
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

async function fetchOddsWindow({ apiFootball, from, to, maxPages, log }) {
  const oddsByFixture = new Map();

  const ingest = (payload) => {
    for (const entry of payload?.response ?? []) {
      const fixtureId = entry?.fixture?.id;
      if (fixtureId == null) continue;
      const values = pickMatchWinnerOdds(entry);
      if (values) oddsByFixture.set(fixtureId, values);
    }
  };

  const first = await apiFootball.oddsByRange(from, to, 1);
  ingest(first.payload);

  const totalPages = Math.max(1, Number(first.payload?.paging?.total ?? 1) || 1);
  const pagesToFetch = Math.min(Math.max(1, maxPages), totalPages);

  if (totalPages > pagesToFetch) {
    log(
      `::warning::The odds window spans ${totalPages} API pages but only ${pagesToFetch} were fetched. ` +
        "Raise ODDS_MAX_PAGES to cover more fixtures (each page is one request).",
    );
  } else if (totalPages > 1) {
    log(`Odds window spans ${totalPages} pages; fetching all of them.`);
  }

  for (let page = 2; page <= pagesToFetch; page += 1) {
    const next = await apiFootball.oddsByRange(from, to, page);
    ingest(next.payload);
  }

  return { oddsByFixture, totalPages, fetchedPages: pagesToFetch };
}

export async function buildSnapshot({
  date,
  apiFootball,
  deepseek = null,
  windowDays = DEFAULTS.windowDays,
  gracePeriodMs = DEFAULTS.gracePeriodMs,
  aiConcurrency = DEFAULTS.aiConcurrency,
  peakWarningThreshold = DEFAULTS.peakWarningThreshold,
  oddsMaxPages = DEFAULTS.oddsMaxPages,
  now = Date.now(),
  log = () => {},
}) {
  const from = date;
  const to = addDays(date, windowDays);

  const { payload: fixtures, remaining } = await apiFootball.fixturesByRange(from, to);
  const allFixtures = Array.isArray(fixtures.response) ? fixtures.response : [];
  const inTargetLeagues = allFixtures.filter((match) => LEAGUE_IDS.includes(match.league?.id));

  log(
    `Fixtures ${from}..${to}: ${allFixtures.length} fetched, ${inTargetLeagues.length} in the ${LEAGUE_IDS.length} target leagues (quota left: ${remaining ?? "unknown"}).`,
  );

  const { oddsByFixture, totalPages, fetchedPages } = await fetchOddsWindow({
    apiFootball,
    from,
    to,
    maxPages: oddsMaxPages,
    log,
  });

  log(`Odds returned for ${oddsByFixture.size} fixtures (${fetchedPages}/${totalPages} pages).`);

  const cutoff = now - gracePeriodMs;
  const matches = inTargetLeagues
    .map((match) => ({ ...match, odds: oddsByFixture.get(match.fixture?.id) ?? null }))
    // Keep anything starting soon or that kicked off within the 4-hour grace period.
    .filter((match) => new Date(match.fixture.date).getTime() > cutoff)
    .sort((a, b) => String(a.fixture.date).localeCompare(String(b.fixture.date)));

  log(
    `Keeping ${matches.length} matches after the ${Math.round(gracePeriodMs / 3600000)}h grace period (dropped ${inTargetLeagues.length - matches.length}).`,
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
    window: { from, to },
    generated_at: new Date().toISOString(),
    quota_remaining: remaining ?? "Unknown",
    match_count: matches.length,
    odds_count: analysable.length,
    analysed_count: analysedCount,
    metrics,
    odds_pages: { total: totalPages, fetched: fetchedPages },
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
    oddsMaxPages: Number(env.ODDS_MAX_PAGES ?? DEFAULTS.oddsMaxPages),
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
        "              AI_CONCURRENCY, ODDS_MAX_PAGES, SYNC_DATE",
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
