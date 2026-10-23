const KV_BINDING = "FOOTBALL_DATA";
const CACHE_PREFIX = "analysis-";
const CACHE_TTL_SECONDS = 60 * 60 * 6;
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-flash";
const TIMEOUT_MS = 25_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clip(value, max) {
  return String(value ?? "").slice(0, max).trim();
}

function buildMessages({ home, away, league, kickoff, odds }) {
  const system = [
    "You are a football tipster texting a mate before kick-off.",
    "Sound like a person: casual, direct, a bit opinionated. No corporate language,",
    "no 'as an AI', no bullet-point marketing, no emoji spam.",
    "",
    "Facts you must respect:",
    "- You have NO live feed. You cannot see injuries, suspensions, line-ups, transfer news,",
    "  odds movement, or results you were not trained on.",
    "- Never state a specific injury, suspension, lineup, transfer or head-to-head record as fact.",
    "  If the call depends on team news, say that plainly and tell them to check the lineup.",
    "- Use only the odds you are given plus general knowledge about how these teams play.",
    "",
    "What to write (max 160 words, plain paragraph followed by 3 short lines):",
    "1. Your read on the match and the value in the 1X2 prices.",
    "2. Three other angles worth a look, each on its own line, e.g. 'BTTS - yes, both teams",
    "   have been leaking goals', 'Over 2.5 - decent shout at these prices', 'Cards - derby,",
    "   refs have been busy', 'Corners - they lump it in constantly'.",
    "3. Be honest when a market is too short or when you would swerve it.",
    "Do not invent statistics. If you are unsure, say so in plain words.",
  ].join(" ");

  const user = [
    `Match: ${home} vs ${away}`,
    league ? `Competition: ${league}` : "",
    kickoff ? `Kick-off: ${kickoff}` : "",
    odds ? `1X2 odds: ${odds}` : "1X2 odds: unavailable",
  ]
    .filter(Boolean)
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function generate({ env, params }) {
  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: (env.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL,
      messages: buildMessages(params),
      temperature: 0.7,
      max_tokens: 500,
      stream: false,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`DeepSeek responded with HTTP ${response.status}`);
  }

  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("DeepSeek returned an empty completion");
  return text;
}

/**
 * Generates (and caches) a tipster note for one fixture.
 *
 * The API key stays server-side: calling DeepSeek from the browser would publish it.
 * Results are cached in KV so repeated views of the same match cost nothing.
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
    return json(
      { error: "DEEPSEEK_API_KEY is not configured for this deployment." },
      503,
    );
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

  let analysis;
  try {
    analysis = await generate({ env, params });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }

  if (kv && cacheKey) {
    try {
      await kv.put(cacheKey, analysis, { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      // Serving the analysis matters more than persisting it.
    }
  }

  return json({ analysis, cached: false });
}
