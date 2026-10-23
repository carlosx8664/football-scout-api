const KV_BINDING = "FOOTBALL_DATA";
const CACHE_PREFIX = "standings-v1-";
const CACHE_TTL_SECONDS = 30 * 60;
const API_BASE = "https://api.football-data.org/v4";
const TOKEN_ENV = "FOOTBALL_DATA_ORG_TOKEN";
const WINDOW_RADIUS = 2;

/** API-Football league id -> football-data.org competition code. */
const COMPETITIONS = {
  1: "WC",
  2: "CL",
  39: "PL",
  40: "ELC",
  61: "FL1",
  71: "BSA",
  78: "BL1",
  88: "DED",
  94: "PPL",
  135: "SA",
  140: "PD",
};

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

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(name) {
  return normalize(name)
    .split(" ")
    .filter((token) => token && !NAME_STOP_WORDS.has(token));
}

/** Dice coefficient over identifying tokens, matching the odds feed's approach. */
function similarity(left, right) {
  const a = new Set(tokens(left));
  const b = new Set(tokens(right));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function findRowIndex(rows, name) {
  let bestIndex = -1;
  let bestScore = 0;

  rows.forEach((row, index) => {
    const score = Math.max(similarity(name, row.name), similarity(name, row.shortName));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= 0.5 ? bestIndex : -1;
}

async function fetchTable({ token, code, season }) {
  const url = `${API_BASE}/competitions/${code}/standings${season ? `?season=${season}` : ""}`;
  const response = await fetch(url, {
    headers: { "X-Auth-Token": token },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`football-data.org responded with HTTP ${response.status}`);
  }

  const body = await response.json();
  const standings = Array.isArray(body?.standings) ? body.standings : [];
  const total = standings.find((entry) => entry?.type === "TOTAL") ?? standings[0];
  const table = Array.isArray(total?.table) ? total.table : [];

  return table.map((row) => ({
    position: Number(row.position),
    name: String(row.team?.name ?? ""),
    shortName: String(row.team?.shortName ?? row.team?.name ?? ""),
    crest: String(row.team?.crest ?? ""),
    played: Number(row.playedGames ?? 0),
    points: Number(row.points ?? 0),
  }));
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const leagueId = Number(url.searchParams.get("league"));
  const home = String(url.searchParams.get("home") ?? "").trim();
  const away = String(url.searchParams.get("away") ?? "").trim();
  const seasonParam = url.searchParams.get("season");
  const season = seasonParam ? Number(seasonParam) : undefined;

  if (!Number.isFinite(leagueId)) {
    return json({ available: false, reason: "Unknown competition." }, 400);
  }

  const code = COMPETITIONS[leagueId];
  if (!code) {
    return json({
      available: false,
      reason: "Standings aren't available for this competition.",
    });
  }

  const token = (env?.[TOKEN_ENV] ?? "").trim();
  if (!token) {
    return json({
      available: false,
      reason: `${TOKEN_ENV} is not configured, so league tables can't be loaded.`,
    });
  }

  const kv = env?.[KV_BINDING];
  const cacheKey = `${CACHE_PREFIX}${code}-${season ?? "current"}`;
  let table = null;

  if (kv) {
    try {
      const cached = await kv.get(cacheKey);
      if (cached) table = JSON.parse(cached);
    } catch {
      // Fall through to the network on a cache hiccup.
    }
  }

  if (!table) {
    try {
      table = await fetchTable({ token, code, season });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ available: false, reason: message });
    }

    if (kv) {
      try {
        await kv.put(cacheKey, JSON.stringify(table), { expirationTtl: CACHE_TTL_SECONDS });
      } catch {
        // Serving the table matters more than caching it.
      }
    }
  }

  if (table.length === 0) {
    return json({ available: false, reason: "No table is published for this competition yet." });
  }

  const homeIndex = home ? findRowIndex(table, home) : -1;
  const awayIndex = away ? findRowIndex(table, away) : -1;

  // Compact view: five rows around each team, merged and deduplicated.
  const focused = [homeIndex, awayIndex].filter((index) => index >= 0);
  let from = 0;
  let to = Math.min(table.length, 5);

  if (focused.length > 0) {
    from = Math.max(0, Math.min(...focused) - WINDOW_RADIUS);
    to = Math.min(table.length, Math.max(...focused) + WINDOW_RADIUS + 1);
  }

  const rows = table.slice(from, to).map((row, offset) => {
    const index = from + offset;
    return {
      ...row,
      highlight: index === homeIndex ? "home" : index === awayIndex ? "away" : null,
    };
  });

  return json({
    available: true,
    competition: code,
    rows,
    truncatedAbove: from > 0,
    truncatedBelow: to < table.length,
  });
}
