const KV_BINDING = "FOOTBALL_DATA";
const CACHE_PREFIX = "analysis-";
const CACHE_TTL_SECONDS = 60 * 60 * 6;
/** Shorter TTL when the news lookup failed, so the next click can retry. */
const FALLBACK_TTL_SECONDS = 60 * 10;
const DEEPSEEK_BASE = "https://api.deepseek.com";
const SEARCH_URL = `${DEEPSEEK_BASE}/v1/tools/search`;
const CHAT_URL = `${DEEPSEEK_BASE}/chat/completions`;
const DEFAULT_MODEL = "deepseek-flash";
const SEARCH_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 25_000;
/** The Search API rejects queries longer than 128 characters. */
const MAX_QUERY_CHARS = 128;
const NEWS_RESULTS = 3;
const NEWS_CHARS_PER_RESULT = 900;
const NO_NEWS_CONTEXT = "No recent news found. Base analysis on odds only.";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clip(value, max) {
  return String(value ?? "").slice(0, max).trim();
}

function yesterdayUtc() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Builds a <=128 char query while keeping the `after:` operator intact. */
function buildSearchQuery(home, away, since) {
  const tail = ` after:${since}`;
  const head = `${home} vs ${away} team news injuries lineup`;
  const room = Math.max(0, MAX_QUERY_CHARS - tail.length);
  return `${head.slice(0, room).trim()}${tail}`;
}

async function searchNews({ env, home, away }) {
  const query = buildSearchQuery(home, away, yesterdayUtc());

  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({ query, count: 5, need_content: true }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Search API responded with HTTP ${response.status}`);

  const body = await response.json();
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.slice(0, NEWS_RESULTS);
}

function toNewsContext(results) {
  if (results.length === 0) return NO_NEWS_CONTEXT;

  return results
    .map((result, index) => {
      const text = String(result.summary || result.snippet || result.content || "").slice(
        0,
        NEWS_CHARS_PER_RESULT,
      );
      const when = typeof result.date === "string" ? ` (${result.date.slice(0, 10)})` : "";
      const site = result.site_name ? ` — ${result.site_name}` : "";
      return `[${index + 1}] ${result.title ?? "Untitled"}${when}${site}\n${text}`;
    })
    .join("\n\n");
}

function buildMessages({ home, away, league, kickoff, odds, newsContext }) {
  const system = [
    "You are a sharp football tipster texting a mate before kick-off.",
    "Casual, direct, opinionated. No corporate language, no 'as an AI', no bullet-point marketing.",
    "Use ONLY the news articles provided. Never invent injuries, suspensions, line-ups, transfers,",
    "quotes or head-to-head records. If the articles do not mention something, do not claim it.",
    "If the news is thin or looks stale, say so plainly and tell them to check the lineup.",
    "Max 170 words: a straight opinion on the best bet, then two or three short lines with other",
    "angles (BTTS, over/under, corners, cards). Be honest when you would swerve the market.",
  ].join(" ");

  const user = [
    `Match: ${home} vs ${away}`,
    league ? `Competition: ${league}` : "",
    kickoff ? `Kick-off: ${kickoff}` : "",
    odds ? `Current odds: ${odds}` : "Current odds: unavailable",
    "",
    "Latest news articles:",
    newsContext,
    "",
    "Based on this real information, give me a straight opinion on the best bet",
    "(Home, Draw, Away, BTTS, Over/Under). Mention specific player names or tactical points",
    "from the news if they are relevant. Do not make up any news.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function generate({ env, params }) {
  // Step 1 — the scout. A search failure must never block the write-up.
  let results = [];
  try {
    results = await searchNews({ env, ...params });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`News search failed for ${params.home} vs ${params.away}: ${message}`);
  }

  const newsContext = toNewsContext(results);

  // Step 2 — the analyst.
  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL,
      messages: buildMessages({ ...params, newsContext }),
      temperature: 0.7,
      max_tokens: 600,
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`DeepSeek responded with HTTP ${response.status}`);

  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("DeepSeek returned an empty completion");

  return {
    analysis: text,
    sources: results.map((result) => ({
      title: result.title ?? "",
      url: result.url ?? "",
    })),
    newsFound: results.length > 0,
  };
}

/**
 * Generates (and caches) a tipster note for one fixture.
 *
 * Step 1 searches DeepSeek's Search API for fresh team news; step 2 feeds those articles plus
 * the odds into the chat model. The API key stays server-side — calling DeepSeek from the
 * browser would publish it. Results are cached in KV so repeat views cost nothing.
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const params = {
    id: clip(url.searchParams.get("id"), 40),
    home: clip(url.searchParams.get("home"), 80),
    away: clip(url.searchParams.get("away"), 80),
    league: clip(url.searchParams.get("league"), 80),
    kickoff: clip(url.searchParams.get("kickoff"), 40),
    odds: clip(url.searchParams.get("odds"), 40),
  };

  if (!params.home || !params.away) {
    return json({ error: "home and away are required" }, 400);
  }

  if (!(env?.DEEPSEEK_API_KEY ?? "").trim()) {
    return json({ error: "DEEPSEEK_API_KEY is not configured for this deployment." }, 503);
  }

  const kv = env?.[KV_BINDING];
  const cacheKey = params.id ? `${CACHE_PREFIX}${params.id}` : null;

  if (kv && cacheKey) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return json({ analysis: cached, cached: true });
    } catch {
      // A cache miss on a KV hiccup should still fall through to generation.
    }
  }

  let result;
  try {
    result = await generate({ env, params });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }

  if (kv && cacheKey) {
    try {
      await kv.put(cacheKey, result.analysis, {
        expirationTtl: result.newsFound ? CACHE_TTL_SECONDS : FALLBACK_TTL_SECONDS,
      });
    } catch {
      // Serving the analysis matters more than persisting it.
    }
  }

  return json({
    analysis: result.analysis,
    sources: result.sources,
    cached: false,
  });
}
