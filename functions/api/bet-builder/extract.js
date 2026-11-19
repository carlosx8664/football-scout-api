import { matchBetslipLegs, toSportyBetSelections } from "../../../shared/betslip-match.js";
import { MAX_SHARE_SELECTIONS, createSportyBetShareSkippingUnavailable } from "../../../shared/sportybet.js";
import { toBetBoroSelections } from "../../../shared/betslip-betboro.js";
import { PROMPT_VERSION } from "../../../shared/betslip-prompt.js";
import {
  VisionError,
  extractBetslipImage,
  isVisionConfigured,
  visionCacheScope,
} from "../../../shared/vision.js";

/**
 * POST /api/bet-builder/extract
 *
 * Reads a betslip screenshot, transcribes it with a free-tier vision model (see
 * `shared/vision.js`), matches every selection against the current match feed, and returns deep
 * links per fixture.
 *
 * The model only transcribes; the grouping/matching is deterministic (`shared/betslip-match.js`).
 * Extractions are cached in KV by image hash, since the same screenshot usually gets retried.
 */

const KV_BINDING = "FOOTBALL_DATA";
const MATCHES_KEY = "feed-matches";
/** Every fixture the books price, tracked league or not (written by the same workflow run). */
const POOL_KEY = "feed-matches-pool";

/** Workers accept far larger bodies; 8 MB keeps vision latency and cost sane. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const CACHE_PREFIX = "betslip";
const CACHE_TTL_SECONDS = 60 * 60 * 24;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

class UpstreamError extends Error {
  constructor(message, status = 502, detail = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.detail = detail;
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** KV first (the workflow's hot feed), then the static file bundled at build time. */
async function loadMatches({ request, env }) {
  const kv = env?.[KV_BINDING];

  if (kv) {
    try {
      const raw = await kv.get(MATCHES_KEY);
      if (raw) {
        const feed = JSON.parse(raw);
        if (Array.isArray(feed?.matches)) return feed.matches;
      }
    } catch {
      // Fall through to the static feed rather than failing the request.
    }
  }

  const response = await fetch(new URL("/matches.json", request.url), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new UpstreamError(`Match feed unavailable (HTTP ${response.status})`);

  const feed = await response.json().catch(() => null);
  if (!Array.isArray(feed?.matches)) throw new UpstreamError("Match feed is malformed");
  return feed.matches;
}

function isImageFile(value) {
  return Boolean(value) && typeof value === "object" && typeof value.arrayBuffer === "function";
}

/**
 * Bet Builder coverage pool: fixtures outside the tracked leagues, in the lean shape the build
 * script writes. Any failure returns an empty list — a broken pool must never block a scan.
 *
 * @returns {Promise<Array<object>>}
 */
async function loadPool({ env }) {
  const kv = env?.[KV_BINDING];
  if (!kv) return [];

  try {
    const raw = await kv.get(POOL_KEY);
    if (!raw) return [];

    const pool = JSON.parse(raw);
    if (!Array.isArray(pool?.fixtures)) return [];

    return pool.fixtures.map((row) => ({
      fixture: { id: Number(row.id), date: row.kickoff ?? null },
      sr_id: row.sr_id ?? null,
      book_ids: row.betboro ? { betboro: row.betboro } : null,
      league: { id: null, name: row.league ?? "", logo: null },
      teams: {
        home: { name: row.home, logo: null },
        away: { name: row.away, logo: null },
      },
      goals: null,
      odds: null,
      book_odds: null,
      ai_analysis: null,
    }));
  } catch {
    return [];
  }
}

/**
 * One vision call per distinct image. Returns `{ parsed, cached }`, where `parsed` is
 * `{ bookmaker, warnings, legs }`.
 *
 * The KV key carries the provider and model, so switching vendors never serves a parse the old
 * model produced.
 */
async function extractLegs({ env, bytes, mime, cacheKey, waitUntil }) {
  const kv = env?.[KV_BINDING];
  const key = `${CACHE_PREFIX}:${PROMPT_VERSION}:${visionCacheScope(env)}:${cacheKey}`;

  if (kv) {
    try {
      const cached = await kv.get(key);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.legs)) return { parsed, cached: true };
      }
    } catch {
      // A broken cache entry must never block a fresh extraction.
    }
  }

  let result;
  try {
    result = await extractBetslipImage({ env, bytes, mime });
  } catch (error) {
    if (error instanceof VisionError) {
      throw new UpstreamError(error.message, error.status, error.detail);
    }
    throw error;
  }

  const parsed = result.parsed;

  if (kv) {
    const write = kv
      .put(key, JSON.stringify(parsed), { expirationTtl: CACHE_TTL_SECONDS })
      .catch(() => {});
    if (typeof waitUntil === "function") waitUntil(write);
    else await write;
  }

  return { parsed, cached: false };
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;

  if (!isVisionConfigured(env)) {
    return json(
      { error: "No vision provider key is configured. Set GEMINI_API_KEY for this deployment." },
      503,
    );
  }

  // Reject an oversized body before buffering it. Multipart adds boundaries and headers on top
  // of the image, so allow a little slack over the per-image limit.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES + 512 * 1024) {
    return json({ error: "Upload is larger than the 8 MB limit." }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data with an image file." }, 415);
  }

  const file = form.get("image") ?? form.get("file");
  if (!isImageFile(file)) {
    return json({ error: "Attach the screenshot as the 'image' field." }, 400);
  }

  const mime = String(file.type ?? "").toLowerCase();
  if (!SUPPORTED_TYPES.has(mime)) {
    return json(
      { error: `Unsupported image type "${mime || "unknown"}". Use PNG, JPEG, WebP or GIF.` },
      415,
    );
  }
  if (file.size === 0) {
    return json({ error: "The uploaded image is empty." }, 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return json(
      { error: `Image is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 8 MB.` },
      413,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let extracted;
  try {
    extracted = await extractLegs({
      env,
      bytes,
      mime,
      cacheKey: await sha256Hex(bytes),
      waitUntil,
    });
  } catch (error) {
    if (error instanceof UpstreamError) {
      return json({ error: error.message, detail: error.detail }, error.status);
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }

  let fixtures;
  try {
    fixtures = await loadMatches({ request, env });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }

  // Wider coverage: the tracked feed wins, the pool fills in leagues it does not follow. Duplicate
  // fixtures are dropped by Sportradar id so a match can never be scored twice.
  if (env?.[KV_BINDING]) {
    const pool = await loadPool({ env });
    if (pool.length > 0) {
      const seen = new Set(fixtures.map((match) => match?.sr_id).filter(Boolean));
      fixtures = fixtures.concat(
        pool.filter((match) => match.sr_id && !seen.has(match.sr_id)),
      );
    }
  }

  const legs = Array.isArray(extracted.parsed.legs) ? extracted.parsed.legs : [];
  const { matched, unresolved } = matchBetslipLegs(legs, fixtures);

  // --- SportyBet share code -------------------------------------------------
  const { selections, skipped: sportybetSkipped, bookings } = toSportyBetSelections(matched);
  // Each matched leg carries its own booking payload, so the client can open a slip with just the
  // legs the user ticked ("Add to Slip") without re-scanning the image.
  const matchedLegs = matched.map((entry, index) =>
    bookings[index] ? { ...entry, booking: bookings[index] } : entry,
  );
  const notes = [];

  if (sportybetSkipped.length > 0) {
    // Workers logs: `npx wrangler pages deployment tail`. Shows exactly why a leg was not booked.
    console.log(
      "bet-builder: skipped SportyBet selections",
      JSON.stringify(
        sportybetSkipped.map(({ leg, reason }) => ({
          reason,
          market: leg?.market ?? null,
          selection: leg?.selection ?? null,
          odds: leg?.odds ?? null,
          rawText: leg?.rawText ?? null,
        })),
      ),
    );
    notes.push(
      `${sportybetSkipped.length} leg${sportybetSkipped.length === 1 ? "" : "s"} can't be added to a SportyBet betslip automatically.`,
    );
  }

  const bookable = selections.slice(0, MAX_SHARE_SELECTIONS);
  if (selections.length > MAX_SHARE_SELECTIONS) {
    notes.push(`Only the first ${MAX_SHARE_SELECTIONS} selections were booked.`);
  }

  let sportybetAccaUrl = null;
  let sportybetAccaCode = null;
  let sportybetBookable = 0;

  if (bookable.length > 0) {
    try {
      // Outcomes the book has not opened yet are dropped rather than failing the whole slip.
      const share = await createSportyBetShareSkippingUnavailable(bookable);
      sportybetAccaUrl = share.url;
      sportybetAccaCode = share.code;
      sportybetBookable = share.booked;

      if (share.skipped.length > 0) {
        notes.push(
          `${share.skipped.length} selection${share.skipped.length === 1 ? " is" : "s are"} not open on SportyBet yet, so the betslip loads without ${share.skipped.length === 1 ? "it" : "them"}.`,
        );
      }
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  }

  // --- BetBoro slip payload --------------------------------------------------
  // BetBoro has no booking API: the extension clicks each outcome, so the response carries the
  // market/outcome pair its dictionary understands plus the fixture deep link.
  const { legs: betboroLegs, skipped: betboroSkipped } = toBetBoroSelections(matched);

  if (betboroSkipped.length > 0) {
    // Workers logs: `npx wrangler pages deployment tail`. Shows exactly why a leg was not mapped.
    console.log(
      "bet-builder: skipped BetBoro selections",
      JSON.stringify(
        betboroSkipped.map(({ leg, reason }) => ({
          reason,
          market: leg?.market ?? null,
          selection: leg?.selection ?? null,
          rawText: leg?.rawText ?? null,
        })),
      ),
    );
  }

  return json({
    bookmaker: extracted.parsed.bookmaker ?? null,
    warnings: Array.isArray(extracted.parsed.warnings) ? extracted.parsed.warnings : [],
    matched: matchedLegs,
    unresolved,
    sportybetAccaUrl,
    sportybetAccaCode,
    sportybetAccaWarning: notes.length > 0 ? notes.join(" ") : null,
    betboro: {
      legs: betboroLegs,
      skipped: betboroSkipped.length,
    },
    cached: extracted.cached,
    stats: {
      legs: legs.length,
      matched: matched.length,
      unresolved: unresolved.length,
      fixtures: fixtures.length,
      bookable: sportybetAccaUrl ? sportybetBookable : bookable.length,
      betboroBookable: betboroLegs.length,
    },
  });
}
