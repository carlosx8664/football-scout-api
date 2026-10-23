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
const RESULTS_PER_TOPIC = 2;
const CONTENT_CHARS_PER_RESULT = 700;
const NO_NEWS_CONTEXT = "No recent news found. Base analysis on odds only.";

/**
 * One search per group of related angles. Splitting beats a single mega-query: the Search API
 * caps queries at 128 characters, and mixed queries bury the specific thing we want.
 */
const SEARCH_TOPICS = [
  {
    label: "Team news",
    query: (home, away) => `${home} vs ${away} team news injuries lineup leak`,
  },
  {
    label: "Underlying form",
    query: (home, away) => `${home} ${away} xG expected points underlying stats`,
  },
  {
    label: "Manager and discipline",
    query: (home, away) => `${home} ${away} manager pressure sacking VAR red card charge`,
  },
  {
    label: "Head to head",
    query: (home, away) => `${home} vs ${away} head to head record derby`,
  },
  {
    label: "Odds movement",
    query: (home, away) => `${home} vs ${away} odds movement opening price drop`,
  },
];

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
function buildQuery(text, since) {
  const tail = ` after:${since}`;
  const room = Math.max(0, MAX_QUERY_CHARS - tail.length);
  return `${text.slice(0, room).trim()}${tail}`;
}

async function searchOnce({ env, query }) {
  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({ query, count: 4, need_content: true }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`Search API responded with HTTP ${response.status}`);

  const body = await response.json();
  return Array.isArray(body?.results) ? body.results : [];
}

/** Runs every topic query in parallel; one failing topic never blocks the rest. */
async function gatherResearch({ env, home, away }) {
  const since = yesterdayUtc();

  const settled = await Promise.allSettled(
    SEARCH_TOPICS.map(async (topic) => ({
      label: topic.label,
      results: await searchOnce({ env, query: buildQuery(topic.query(home, away), since) }),
    })),
  );

  const sections = [];
  const sources = [];
  const seenUrls = new Set();

  settled.forEach((outcome, index) => {
    const label = SEARCH_TOPICS[index].label;

    if (outcome.status === "rejected") {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      console.warn(`Search "${label}" failed: ${reason}`);
      return;
    }

    const lines = [];
    for (const result of outcome.value.results.slice(0, RESULTS_PER_TOPIC)) {
      const url = typeof result.url === "string" ? result.url : "";
      if (url && seenUrls.has(url)) continue;
      if (url) seenUrls.add(url);

      const text = String(result.summary || result.snippet || result.content || "")
        .slice(0, CONTENT_CHARS_PER_RESULT)
        .trim();
      if (!text) continue;

      const when = typeof result.date === "string" ? ` (${result.date.slice(0, 10)})` : "";
      const site = result.site_name ? ` — ${result.site_name}` : "";
      lines.push(`- ${result.title ?? "Untitled"}${when}${site}\n  ${text}`);
      sources.push({ title: result.title ?? "", url });
    }

    if (lines.length > 0) sections.push(`### ${label}\n${lines.join("\n")}`);
  });

  return {
    context: sections.length > 0 ? sections.join("\n\n") : NO_NEWS_CONTEXT,
    sources,
    found: sections.length > 0,
  };
}

function buildMessages({ home, away, league, kickoff, odds, context }) {
  const system = [
    "You are a friendly football tipster explaining a match to a mate who does not bet much.",
    "Write in plain, simple English. Short sentences. Explain any stat term in a few words",
    "(for example: 'xG - how many goals they would usually score from the chances they make').",
    "Avoid betting slang: no 'steam', 'fade', 'value', 'line', 'cover', 'fodder'.",
    "Be warm and direct, never corporate, no emoji spam, no bullet-point marketing.",
    "Use ONLY the articles you are given. Never invent injuries, lineups, transfers, quotes,",
    "results or disciplinary news. If the articles do not cover something, leave it out instead",
    "of guessing. If the research is thin, say that in one short sentence.",
    "Keep the whole thing under 150 words.",
    "Shape it like this:",
    "1) One or two sentences on what you would back and why, in plain words.",
    "2) Two or three short lines with other sensible bets (both teams to score, over/under goals,",
    "   corners, cards), each with a one-line reason - only when the articles support it.",
    "3) One line on what would make you walk away from the bet.",
  ].join(" ");

  const user = [
    `Match: ${home} vs ${away}`,
    league ? `Competition: ${league}` : "",
    kickoff ? `Kick-off: ${kickoff}` : "",
    odds ? `Current odds: ${odds}` : "Current odds: unavailable",
    "",
    "Research notes:",
    context,
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function generate({ env, params }) {
  // Step 1 - gather research. A failed topic must never block the write-up.
  const research = await gatherResearch({ env, ...params });

  // Step 2 - turn it into a short, friendly note.
  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL,
      messages: buildMessages({ ...params, context: research.context }),
      // Thinking mode is on by default and would spend the token budget on reasoning,
      // leaving `content` empty. A short casual note does not need it.
      thinking: { type: "disabled" },
      temperature: 0.6,
      max_tokens: 900,
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`DeepSeek responded with HTTP ${response.status}`);

  const body = await response.json();
  const choice = body?.choices?.[0];
  const text = choice?.message?.content?.trim();
  if (!text) {
    const finish = choice?.finish_reason ?? "unknown";
    throw new Error(`DeepSeek returned an empty completion (finish_reason=${finish})`);
  }

  return { analysis: text, sources: research.sources, newsFound: research.found };
}

/**
 * Generates (and caches) a tipster note for one fixture.
 *
 * Step 1 runs several targeted searches on DeepSeek's Search API (team news, underlying form,
 * manager/discipline, head to head, odds movement); step 2 feeds those articles plus the odds
 * into the chat model. The API key stays server-side - calling DeepSeek from the browser would
 * publish it. Results are cached in KV so repeat views cost nothing.
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
