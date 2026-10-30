const KV_BINDING = "FOOTBALL_DATA";
const CACHE_PREFIX = "analysis-";
/** Bump when the prompt changes so stale notes are ignored. */
const CACHE_VERSION = "v3";
const DEEPSEEK_BASE = "https://api.deepseek.com";
const SEARCH_URL = `${DEEPSEEK_BASE}/v1/tools/search`;
const CHAT_URL = `${DEEPSEEK_BASE}/chat/completions`;
const DEFAULT_MODEL = "deepseek-flash";
const SEARCH_TIMEOUT_MS = 15_000;
const CHAT_TIMEOUT_MS = 28_000;
/** The Search API rejects queries longer than 128 characters. */
const MAX_QUERY_CHARS = 128;
const RESULTS_PER_TOPIC = 2;
const CONTENT_CHARS_PER_RESULT = 700;
const NO_NEWS_CONTEXT = "No recent news found. Base analysis on odds only.";
/** Same-origin odds feeds written by the odds pipeline (scripts/find-arbs.js). */
const ARBS_SOURCES = ["/api/arbs", "/arbs.json"];
const ODDS_TIMEOUT_MS = 8_000;
const MAX_BOARD_MARKETS = 12;

/**
 * One search per group of related angles. Splitting beats a single mega-query: the Search API
 * caps queries at 128 characters, and mixed queries bury the specific thing we want.
 */
const SEARCH_TOPICS = [
  {
    label: "Injuries and suspensions",
    query: (home, away) => `${home} ${away} injuries suspensions missing players`,
  },
  {
    label: "Lineup leaks and rumours",
    query: (home, away) => `${home} vs ${away} predicted lineup team news leak`,
  },
  {
    label: "Dressing room",
    query: (home, away) => `${home} ${away} manager bust-up fallout training row`,
  },
  {
    label: "Home form",
    query: (home) => `${home} home form xG goals scored conceded last games`,
  },
  {
    label: "Away form",
    query: (_home, away) => `${away} away form xG record on the road`,
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

function normaliseTeam(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Fixture match by Sportradar id first, then by the two team names. */
function isSameFixture(record, { srId, home, away }) {
  if (srId && record.eventId && record.eventId === srId) return true;
  return (
    normaliseTeam(record.home) === normaliseTeam(home) &&
    normaliseTeam(record.away) === normaliseTeam(away)
  );
}

/** Best price per outcome for one market, keeping the bookmaker that quotes it. */
function formatLegs(legs) {
  const best = new Map();

  for (const leg of Array.isArray(legs) ? legs : []) {
    const price = Number(leg?.lastOdds ?? leg?.openOdds);
    const outcome = String(leg?.outcome ?? "").trim();
    if (!outcome || !Number.isFinite(price) || price <= 1) continue;

    const current = best.get(outcome);
    if (current && current.price >= price) continue;
    best.set(outcome, { price, bookmaker: String(leg?.bookmaker ?? "").trim() });
  }

  return [...best.entries()]
    .map(([outcome, { price, bookmaker }]) => {
      const source = bookmaker ? ` (${bookmaker})` : "";
      return `${outcome} ${price.toFixed(2)}${source}`;
    })
    .join(" / ");
}

/**
 * Reads the odds the scanner already fetched (find-arbs.js -> arbs.json / KV) and keeps only
 * this fixture's markets, with the best price and bookmaker per outcome. This is what lets the
 * write-up compare real prices instead of inventing them.
 */
async function gatherOddsBoard({ request, srId, home, away }) {
  const origin = new URL(request.url).origin;
  const markets = new Map();

  for (const path of ARBS_SOURCES) {
    try {
      const response = await fetch(`${origin}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(ODDS_TIMEOUT_MS),
      });
      if (!response.ok) continue;

      const payload = await response.json();
      const records = [...(payload?.arbs ?? []), ...(payload?.history ?? [])];

      for (const record of records) {
        if (!isSameFixture(record, { srId, home, away })) continue;

        const market = String(record.market ?? "").trim();
        const legs = formatLegs(record.legs);
        if (market && legs) markets.set(market, legs);
      }

      if (markets.size > 0) break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`Odds board from ${path} failed: ${reason}`);
    }
  }

  return [...markets.entries()]
    .slice(0, MAX_BOARD_MARKETS)
    .map(([market, legs]) => `- ${market}: ${legs}`);
}

function buildMessages({ home, away, league, kickoff, odds, books, board, context }) {
  const system = [
    "You are a friendly football tipster writing a pre-match note for a mate who bets small stakes",
    "and does not follow every league. Your job is to turn the research and the prices we pulled",
    "into a clear, honest preview.",
    "Write in plain, simple English. Short sentences. Explain any term in a few words",
    "(for example: 'xG - how many goals they would usually score from the chances they create').",
    "Never use betting slang such as 'steam', 'fade', 'hammer', 'line', 'cover' or 'fodder'.",
    "Be warm and direct, never corporate, no emoji spam, no marketing bullet lists.",
    "Plain text only: no markdown, no headings, no bold or asterisks.",
    "Use ONLY the articles and prices you are given. Never invent injuries, suspensions, lineups,",
    "transfers, quotes, results, prices or bookmakers. If the notes are thin, say so in one short",
    "sentence and leave the detail out instead of guessing.",
    "When the articles name a player who is injured, suspended, doubtful, rested or coming back,",
    "name that player and say what the article reports. Treat lineup leaks and rumours as",
    "unconfirmed: say 'reports suggest' or 'rumoured'.",
    "You are not guaranteeing anything and you are not a financial adviser.",
    "Write at least three paragraphs separated by a blank line, and aim for 220-320 words.",
    "Paragraph 1 - team news: who is missing, injured, suspended or doubtful, any leaked or",
    "rumoured starting lineup, and what that changes for the team.",
    "Paragraph 2 - form and mood: the home side's home form, the away side's away record and",
    "away power, plus anything about the manager or the dressing room.",
    "Paragraph 3 - the betting view: compare the prices you were given, name two or three specific",
    "markets with their decimal price and the bookmaker quoting it, say which market looks the best",
    "one to stake and which one to leave alone, and finish with one line on what would make you",
    "walk away. If only the match result prices are available, compare those three and mention other",
    "market names without stating a price you were not given.",
  ].join(" ");

  const user = [
    `Match: ${home} vs ${away}`,
    league ? `Competition: ${league}` : "",
    kickoff ? `Kick-off: ${kickoff}` : "",
    "",
    "Prices we pulled earlier (decimal odds):",
    odds ? `- Match result (home / draw / away): ${odds}` : "- Match result: unavailable",
    books ? `- Same market, by bookmaker: ${books}` : "",
    board.length > 0
      ? `- Other markets:\n${board.join("\n")}`
      : "- Other markets: none available, do not quote prices for them",
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

async function generate({ env, request, params }) {
  // Step 1 - research and the odds board in parallel. Either side failing must never block
  // the write-up.
  const [research, board] = await Promise.all([
    gatherResearch({ env, ...params }),
    gatherOddsBoard({ request, ...params }),
  ]);

  // Step 2 - turn it into a friendly, multi-paragraph tipster note.
  const response = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL,
      messages: buildMessages({ ...params, board, context: research.context }),
      // Thinking mode is on by default and would spend the token budget on reasoning,
      // leaving `content` empty. A preview note does not need it.
      thinking: { type: "disabled" },
      temperature: 0.7,
      max_tokens: 1400,
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
 * Step 1 runs several targeted searches on DeepSeek's Search API (injuries, lineup leaks,
 * dressing-room mood, home form, away form, head to head, odds movement) and reads the prices
 * the odds pipeline already fetched; step 2 feeds those articles plus the prices into the chat
 * model. The API key stays server-side - calling DeepSeek from the browser would publish it.
 * Results are cached in KV so repeat views cost nothing.
 */
export async function onRequestGet({ request, env }) {
  // AI features temporarily disabled (arbitrage-logic focus). Re-enable by removing this guard.
  return json({ error: "AI analysis is temporarily disabled.", disabled: true }, 503);

  const url = new URL(request.url);
  const params = {
    id: clip(url.searchParams.get("id"), 40),
    home: clip(url.searchParams.get("home"), 80),
    away: clip(url.searchParams.get("away"), 80),
    league: clip(url.searchParams.get("league"), 80),
    kickoff: clip(url.searchParams.get("kickoff"), 40),
    odds: clip(url.searchParams.get("odds"), 80),
    books: clip(url.searchParams.get("books"), 300),
    srId: clip(url.searchParams.get("sr"), 40),
  };

  if (!params.home || !params.away) {
    return json({ error: "home and away are required" }, 400);
  }

  if (!(env?.DEEPSEEK_API_KEY ?? "").trim()) {
    return json({ error: "DEEPSEEK_API_KEY is not configured for this deployment." }, 503);
  }

  const kv = env?.[KV_BINDING];
  const cacheKey = params.id ? `${CACHE_PREFIX}${CACHE_VERSION}-${params.id}` : null;
  // `?refresh=1` skips the read but still refreshes the stored copy.
  const refresh = url.searchParams.get("refresh") === "1";

  if (kv && cacheKey && !refresh) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) return json({ analysis: cached, cached: true });
    } catch {
      // A cache miss on a KV hiccup should still fall through to generation.
    }
  }

  let result;
  try {
    result = await generate({ env, request, params });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }

  if (kv && cacheKey) {
    try {
      await kv.put(cacheKey, result.analysis, { expirationTtl: 86400 });
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
