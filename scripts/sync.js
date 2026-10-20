#!/usr/bin/env node
/**
 * Daily data sync.
 *
 * Gathers today's fixtures for the tracked leagues, enriches each fixture with
 * match-winner odds and a DeepSeek analysis, then stores the result in Cloudflare KV
 * under `snapshot-<YYYY-MM-DD>` (and `snapshot-latest` for the pre-sync fallback). The
 * site reads only from KV, so visitor traffic can never consume the API-Football quota.
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
/** Mirrors the key the Pages Function falls back to before each day's sync. */
const LATEST_SNAPSHOT_KEY = "snapshot-latest";

export const DEFAULTS = {
  model: "deepseek-flash",
  // API-Football's free plan allows 100 requests/day; keep headroom for reruns.
  oddsDelayMs: 6000,
  maxOddsRequests: 95,
  aiConcurrency: 3,
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
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
}

export function pickMatchWinnerOdds(payload) {
  const bookmakers = payload?.response?.[0]?.bookmakers ?? [];
  for (const bookmaker of bookmakers) {
    const bet = (bookmaker.bets ?? []).find((entry) => entry.id === 1);
    if (bet?.values?.length) return bet.values;
  }
  return null;
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

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
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
          // A 4xx will not succeed on retry (bad key, plan restriction, ...).
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
    fixturesByDate(date) {
      return request("/fixtures", { date }, `fixtures ${date}`);
    },
    oddsForFixture(fixtureId) {
      return request("/odds", { fixture: fixtureId }, `odds ${fixtureId}`);
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

export async function buildSnapshot({
  date,
  apiFootball,
  deepseek = null,
  oddsDelayMs = DEFAULTS.oddsDelayMs,
  maxOddsRequests = DEFAULTS.maxOddsRequests,
  aiConcurrency = DEFAULTS.aiConcurrency,
  log = () => {},
}) {
  const { payload, remaining } = await apiFootball.fixturesByDate(date);
  const fixtures = Array.isArray(payload.response) ? payload.response : [];

  const matches = fixtures
    .filter((match) => LEAGUE_IDS.includes(match.league.id))
    .sort((a, b) => String(a.fixture.date).localeCompare(String(b.fixture.date)))
    // Shallow copies: enrichment mutates matches and callers may reuse the payload.
    .map((match) => ({ ...match }));

  log(
    `Found ${matches.length} fixtures across ${LEAGUE_IDS.length} leagues (quota left: ${remaining ?? "unknown"}).`,
  );

  const oddsTargets = matches.slice(0, maxOddsRequests);
  const skipped = matches.length - oddsTargets.length;
  if (skipped > 0) {
    log(
      `::warning::Odds lookups capped at ${maxOddsRequests} per run; ${skipped} fixtures will ship without analysis.`,
    );
  }

  let oddsFound = 0;
  let quotaExhausted = false;

  for (const [index, match] of oddsTargets.entries()) {
    if (index > 0) await sleep(oddsDelayMs);

    try {
      const { payload: oddsPayload } = await apiFootball.oddsForFixture(match.fixture.id);
      match.odds = pickMatchWinnerOdds(oddsPayload);
      if (match.odds) {
        oddsFound += 1;
        log(`  ${match.teams.home.name} vs ${match.teams.away.name}: 1X2 ${match.odds.map((o) => o.odd).join(" / ")}`);
      } else {
        match.ai_analysis = "Match-winner odds are not published for this fixture yet.";
        log(`  ${match.teams.home.name} vs ${match.teams.away.name}: no odds published`);
      }
    } catch (error) {
      match.odds = null;
      match.ai_analysis = `Odds unavailable: ${error.message}`;
      if (error instanceof QuotaError) {
        quotaExhausted = true;
        log(`::warning::${error.message}`);
        log("Stopping the odds loop to preserve the remaining quota.");
        break;
      }
      log(`  odds failed for fixture ${match.fixture.id}: ${error.message}`);
    }
  }

  const analysable = oddsTargets.filter((match) => match.odds);

  if (!deepseek) {
    analysable.forEach((match) => {
      match.ai_analysis = "AI analysis skipped: DEEPSEEK_API_KEY is not configured.";
    });
    log("::warning::DEEPSEEK_API_KEY is not set; skipping AI analysis.");
  } else if (analysable.length > 0) {
    log(`Requesting AI analysis for ${analysable.length} fixtures (${deepseek.model})...`);
    await mapLimit(analysable, aiConcurrency, async (match) => {
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
  }

  const analysedCount = analysable.filter((match) => match.aiOk).length;
  log(`Odds: ${oddsFound}/${oddsTargets.length}. AI analyses: ${analysedCount}/${analysable.length}.`);

  return {
    status: "success",
    date,
    generated_at: new Date().toISOString(),
    quota_remaining: remaining ?? "Unknown",
    quota_exhausted: quotaExhausted,
    match_count: matches.length,
    analysed_count: analysedCount,
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

  log(`Uploaded ${key} to KV (${snapshot.matches.length} fixtures).`);
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

  log(`Syncing ${date}...`);

  const snapshot = await buildSnapshot({
    date,
    apiFootball,
    deepseek,
    oddsDelayMs: Number(env.ODDS_DELAY_MS ?? DEFAULTS.oddsDelayMs),
    maxOddsRequests: Number(env.MAX_ODDS_REQUESTS ?? DEFAULTS.maxOddsRequests),
    aiConcurrency: Number(env.AI_CONCURRENCY ?? DEFAULTS.aiConcurrency),
    log,
  });

  if (outFile) {
    await writeFile(outFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    log(`Wrote ${outFile}`);
  }

  const key = `${SNAPSHOT_KEY_PREFIX}${date}`;

  if (dryRun) {
    log(`Dry run: skipping the KV upload for ${key} and ${LATEST_SNAPSHOT_KEY}.`);
    return snapshot;
  }

  const target = {
    accountId: required(env, "CF_ACCOUNT_ID"),
    namespaceId: required(env, "CF_KV_NAMESPACE_ID"),
    apiToken: required(env, "CF_API_TOKEN"),
    snapshot,
    log,
  };

  await uploadToKv({ ...target, key });
  // Stable key so the site can show the last slate until today's sync lands.
  await uploadToKv({ ...target, key: LATEST_SNAPSHOT_KEY });

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
        "              ODDS_DELAY_MS, MAX_ODDS_REQUESTS, AI_CONCURRENCY",
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
