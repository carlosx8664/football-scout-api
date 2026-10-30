import { matchBetslipLegs, toSportyBetSelections } from "../../../shared/betslip-match.js";
import {
  MAX_SHARE_SELECTIONS,
  createSportyBetShare,
} from "../../../shared/sportybet.js";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  USER_PROMPT,
  parseJsonContent,
} from "../../../shared/betslip-prompt.js";

/**
 * POST /api/bet-builder/extract
 *
 * Reads a betslip screenshot, transcribes it with DeepSeek's vision model, matches every
 * selection against the current match feed, and returns deep links per fixture.
 *
 * The model only transcribes; the grouping/matching is deterministic (`shared/betslip-match.js`).
 * Extractions are cached in KV by image hash, since the same screenshot usually gets retried.
 */

const KV_BINDING = "FOOTBALL_DATA";
const MATCHES_KEY = "feed-matches";
const DEEPSEEK_BASE = "https://api.deepseek.com";
const CHAT_URL = `${DEEPSEEK_BASE}/chat/completions`;
const DEFAULT_MODEL = "deepseek-flash";
const CHAT_TIMEOUT_MS = 45_000;
const IMAGE_DETAIL = "high";
const MAX_TOKENS = 4000;

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

/** Chunked so a multi-megabyte image does not blow the argument limit of String.fromCharCode. */
function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
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
 * One vision call per distinct image. Returns `{ parsed, cached }`, where `parsed` is
 * `{ bookmaker, warnings, legs }`.
 */
async function extractLegs({ env, bytes, mime, cacheKey, waitUntil }) {
  const kv = env?.[KV_BINDING];
  const key = `${CACHE_PREFIX}:${PROMPT_VERSION}:${cacheKey}`;

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

  const model = (env?.DEEPSEEK_MODEL ?? "").trim() || DEFAULT_MODEL;

  let response;
  try {
    response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: USER_PROMPT },
              {
                type: "image_url",
                image_url: { url: `data:${mime};base64,${toBase64(bytes)}`, detail: IMAGE_DETAIL },
              },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new UpstreamError(
      timedOut
        ? "The vision model took too long. Try a smaller screenshot."
        : "Could not reach the vision model.",
      504,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new UpstreamError(
      `Vision model responded with HTTP ${response.status}`,
      502,
      detail.slice(0, 300) || null,
    );
  }

  const body = await response.json().catch(() => null);
  const choice = body?.choices?.[0];
  const parsed = parseJsonContent(choice?.message?.content);

  if (!parsed || !Array.isArray(parsed.legs)) {
    const finish = choice?.finish_reason ?? "unknown";
    throw new UpstreamError(
      `Vision model did not return usable JSON (finish_reason=${finish})`,
      502,
      typeof choice?.message?.content === "string" ? choice.message.content.slice(0, 300) : null,
    );
  }

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
  // AI features temporarily disabled (arbitrage-logic focus). Re-enable by removing this guard.
  return json({ error: "AI bet-slip extraction is temporarily disabled.", disabled: true }, 503);

  const { request, env, waitUntil } = context;

  if (!(env?.DEEPSEEK_API_KEY ?? "").trim()) {
    return json({ error: "DEEPSEEK_API_KEY is not configured for this deployment." }, 503);
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

  const legs = Array.isArray(extracted.parsed.legs) ? extracted.parsed.legs : [];
  const { matched, unresolved } = matchBetslipLegs(legs, fixtures);

  // --- SportyBet share code -------------------------------------------------
  const { selections, skipped, bookings } = toSportyBetSelections(matched);
  // Each matched leg carries its own booking payload, so the client can open a slip with just the
  // legs the user ticked ("Add to Slip") without re-scanning the image.
  const matchedLegs = matched.map((entry, index) =>
    bookings[index] ? { ...entry, booking: bookings[index] } : entry,
  );
  const notes = [];

  if (skipped.length > 0) {
    // Workers logs: `npx wrangler pages deployment tail`. Shows exactly why a leg was not booked.
    console.log(
      "bet-builder: skipped SportyBet selections",
      JSON.stringify(
        skipped.map(({ leg, reason }) => ({
          reason,
          market: leg?.market ?? null,
          selection: leg?.selection ?? null,
          odds: leg?.odds ?? null,
          rawText: leg?.rawText ?? null,
        })),
      ),
    );
  }

  if (skipped.length > 0) {
    notes.push(
      `${skipped.length} leg${skipped.length === 1 ? "" : "s"} can't be added to a SportyBet betslip automatically.`,
    );
  }

  const bookable = selections.slice(0, MAX_SHARE_SELECTIONS);
  if (selections.length > MAX_SHARE_SELECTIONS) {
    notes.push(`Only the first ${MAX_SHARE_SELECTIONS} selections were booked.`);
  }

  let sportybetAccaUrl = null;
  let sportybetAccaCode = null;

  if (bookable.length > 0) {
    try {
      const share = await createSportyBetShare(bookable);
      sportybetAccaUrl = share.url;
      sportybetAccaCode = share.code;

      if (share.unavailable.length > 0) {
        notes.push(
          `${share.unavailable.length} outcome${share.unavailable.length === 1 ? " was" : "s were"} unavailable, so the betslip may load partially.`,
        );
      }
    } catch (error) {
      notes.push(error instanceof Error ? error.message : String(error));
    }
  }

  return json({
    bookmaker: extracted.parsed.bookmaker ?? null,
    warnings: Array.isArray(extracted.parsed.warnings) ? extracted.parsed.warnings : [],
    matched: matchedLegs,
    unresolved,
    sportybetAccaUrl,
    sportybetAccaCode,
    sportybetAccaWarning: notes.length > 0 ? notes.join(" ") : null,
    cached: extracted.cached,
    stats: {
      legs: legs.length,
      matched: matched.length,
      unresolved: unresolved.length,
      fixtures: fixtures.length,
      bookable: bookable.length,
    },
  });
}
