/**
 * Bet-slip vision adapters (free tier).
 *
 * The model is only a camera: it transcribes the slip into the JSON contract in
 * `betslip-prompt.js`. Matching the picks to our feed and booking them on SportyBet stays
 * deterministic in `betslip-match.js`, so a misread row can never book a different bet.
 *
 * Providers, tried in order:
 *   gemini      Google AI Studio free tier   GEMINI_API_KEY       (primary)
 *   openrouter  OpenRouter `:free` models    OPENROUTER_API_KEY   (fallback)
 *   groq        Groq free tier               GROQ_API_KEY         (last resort: its free tier is
 *                                                                 text-only right now, so it is
 *                                                                 only useful if that changes)
 *
 * `VISION_PROVIDER` puts one first; `VISION_MODEL` overrides the primary provider's model.
 * A couple of slips a day fits the free allowance of all three, and KV caches each image by
 * hash, so re-scanning the same screenshot costs nothing.
 *
 * @typedef {{ parsed: any, provider: string, model: string, usage: any, raw: any }} VisionResult
 */

import { SYSTEM_PROMPT, USER_PROMPT, parseJsonContent } from "./betslip-prompt.js";

export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * OpenAI-compatible providers: identical request shape, different host and headers.
 * Model names drift, so `VISION_MODEL` overrides whichever default the primary provider uses.
 */
const OPENAI_COMPATIBLE = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    headers: {},
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelsUrl: "https://openrouter.ai/api/v1/models",
    defaultModel: "google/gemma-4-31b-it:free",
    headers: {
      // OpenRouter attributes free-tier traffic by these two headers.
      "HTTP-Referer": "https://github.com/carlosx8664/football-scout-api",
      "X-Title": "football-scout-api bet builder",
    },
  },
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/** Free-tier Flash models answer a slip in a few seconds; this only backstops a hung call. */
const TIMEOUT_MS = 60_000;
/** A 20-leg slip lands well under this once thinking is off. */
const MAX_OUTPUT_TOKENS = 8192;

export class VisionError extends Error {
  /**
   * @param {string} message user-safe text
   * @param {number} [status] HTTP status to surface
   * @param {string | null} [detail] upstream snippet for logs
   */
  constructor(message, status = 502, detail = null) {
    super(message);
    this.name = "VisionError";
    this.status = status;
    this.detail = detail;
  }
}

const trim = (value) => String(value ?? "").trim();

/** Chunked so a multi-megabyte image does not blow the argument limit of String.fromCharCode. */
function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

/** Model ids churn (Groq retires them, OpenRouter renames `:free` variants). */
const VISION_MODEL_HINT = /-vl(?:[-:]|$)|vision|scout|maverick|gemma|multimodal|llava|pixtral|omni/i;

/**
 * Model ids the key can actually use. Cached per provider+key for the isolate's lifetime so a
 * retry does not pay for the listing again.
 *
 * @type {Map<string, string[]>}
 */
const modelCache = new Map();

/**
 * Model listing with the provider's own answer, so a bad key is never mistaken for a bad network.
 *
 * @param {{ name: string, key: string }} provider
 * @returns {Promise<{ ids: string[], ok: boolean, status: number, error: string }>}
 */
export async function probeModels(provider) {
  const config = OPENAI_COMPATIBLE[provider.name];
  if (!config?.modelsUrl) {
    return { ids: [], ok: false, status: 0, error: `${provider.name} does not expose a model list` };
  }

  const cacheKey = `${provider.name}:${provider.key.slice(-8)}`;
  const cached = modelCache.get(cacheKey);
  if (cached) return { ids: cached, ok: true, status: 200, error: "" };

  try {
    const response = await fetch(config.modelsUrl, {
      headers: { Authorization: `Bearer ${provider.key}`, ...config.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return { ids: [], ok: false, status: response.status, error: detail.slice(0, 200) };
    }

    const payload = await response.json().catch(() => null);
    const ids = (payload?.data ?? [])
      .map((row) => String(row?.id ?? ""))
      .filter(Boolean)
      .sort();
    // Only successes are cached: a transient failure must not stick to the isolate.
    modelCache.set(cacheKey, ids);
    return { ids, ok: true, status: response.status, error: "" };
  } catch (error) {
    return { ids: [], ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {{ name: string, key: string }} provider
 * @returns {Promise<string[]>}
 */
export async function listModels(provider) {
  return (await probeModels(provider)).ids;
}

/** First model id on this key that looks vision-capable. */
async function discoverVisionModel(provider) {
  const ids = await listModels(provider);
  return ids.find((id) => VISION_MODEL_HINT.test(id)) ?? null;
}

/**
 * Providers we have a key for, primary first.
 *
 * @param {Record<string, unknown> | undefined} env
 * @returns {Array<{ name: string, key: string, model: string }>}
 */
export function resolveVisionChain(env) {
  const keys = {
    gemini: trim(env?.GEMINI_API_KEY),
    openrouter: trim(env?.OPENROUTER_API_KEY),
    groq: trim(env?.GROQ_API_KEY),
  };
  const requested = trim(env?.VISION_PROVIDER).toLowerCase();
  const preferred = ["gemini", "openrouter", "groq"].filter((name) => keys[name]);
  const order =
    requested && keys[requested]
      ? [requested, ...preferred.filter((name) => name !== requested)]
      : preferred;

  const chain = order.map((name) => ({
    name,
    key: keys[name],
    model: name === "gemini" ? GEMINI_DEFAULT_MODEL : OPENAI_COMPATIBLE[name].defaultModel,
  }));

  // `VISION_MODEL` pins the primary provider only: a Gemini model id must never be sent to Groq.
  const overrideModel = trim(env?.VISION_MODEL);
  if (overrideModel && chain.length > 0) chain[0].model = overrideModel;

  return chain;
}

export function isVisionConfigured(env) {
  return resolveVisionChain(env).length > 0;
}

/** Part of the KV cache key: a new provider or model must not reuse an older parse. */
export function visionCacheScope(env) {
  const [primary] = resolveVisionChain(env);
  return primary ? `${primary.name}-${primary.model}` : "unconfigured";
}

const GEMINI_LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * A Gemini model this key can actually call, preferring full Flash (best OCR), then lite.
 * Model ids are versioned and retired, so a 404 falls back to this instead of failing.
 *
 * @param {{ key: string }} provider
 * @returns {Promise<string | null>}
 */
async function discoverGeminiModel(provider) {
  try {
    const response = await fetch(`${GEMINI_LIST_URL}?key=${encodeURIComponent(provider.key)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const payload = await response.json().catch(() => null);
    const ids = (payload?.models ?? [])
      .filter((model) => (model?.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((model) => String(model?.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    const usable = ids.filter((id) => !/image|tts|audio|live|embedding|veo|imagen/i.test(id));

    return (
      usable.find((id) => /^gemini-[0-9.]+-flash$/.test(id)) ??
      usable.find((id) => /^gemini-flash-latest$/.test(id)) ??
      usable.find((id) => /flash-lite/.test(id)) ??
      usable.find((id) => /flash/.test(id)) ??
      null
    );
  } catch {
    return null;
  }
}

async function postGemini({ model, key, body }) {
  try {
    return await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new VisionError(
      timedOut ? "The vision model took too long. Try a smaller screenshot." : "Could not reach the vision model.",
      504,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function geminiBody(bytes, mime) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: USER_PROMPT },
          { inline_data: { mime_type: mime, data: toBase64(bytes) } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      responseMimeType: "application/json",
      // Reasoning tokens would eat maxOutputTokens and truncate the JSON. Not every model
      // accepts this field, so a 400 mentioning it retries once without it (below).
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
}

async function callGemini(provider, { bytes, mime }) {
  const body = geminiBody(bytes, mime);
  let response = await postGemini({ ...provider, body });

  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (!/thinking/i.test(detail)) {
      throw new VisionError("Vision model rejected the request.", 502, detail.slice(0, 300) || null);
    }
    delete body.generationConfig.thinkingConfig;
    response = await postGemini({ ...provider, body });
  }

  // A retired or unavailable model id is a 404; ask the key what it can actually use.
  let consumedDetail = "";
  if (response.status === 404) {
    consumedDetail = await response.text().catch(() => "");
    const discovered = await discoverGeminiModel(provider);
    if (discovered && discovered !== provider.model) {
      provider.model = discovered;
      response = await postGemini({ ...provider, body });
      consumedDetail = "";
    }
  }

  if (!response.ok) {
    const detail = consumedDetail || (await response.text().catch(() => ""));
    if (response.status === 429) {
      throw new VisionError(
        "The free vision quota for today is used up. Try again tomorrow or add a second provider key.",
        429,
        detail.slice(0, 300) || null,
      );
    }
    throw new VisionError(
      response.status === 404
        ? `Gemini has no model "${provider.model}" for this key. Run node scripts/vision-models.js and set VISION_MODEL.`
        : `Vision model responded with HTTP ${response.status} (gemini/${provider.model}).`,
      502,
      detail.slice(0, 300) || null,
    );
  }

  const payload = await response.json().catch(() => null);
  const candidate = payload?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");

  return {
    text,
    usage: payload?.usageMetadata ?? null,
    raw: payload,
    finish: candidate?.finishReason ?? "unknown",
  };
}

async function postOpenAiCompatible(provider, body) {
  const config = OPENAI_COMPATIBLE[provider.name];

  try {
    return await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.key}`,
        ...config.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new VisionError(
      timedOut ? "The vision model took too long. Try a smaller screenshot." : "Could not reach the vision model.",
      504,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function callOpenAiCompatible(provider, { bytes, mime }) {
  const body = {
    model: provider.model,
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: USER_PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${toBase64(bytes)}`, detail: "high" },
          },
        ],
      },
    ],
  };

  let response = await postOpenAiCompatible(provider, body);

  // A few free models reject `response_format` with a 400 instead of ignoring it.
  if (response.status === 400) {
    const detail = await response.text().catch(() => "");
    if (!/response_format|json/i.test(detail)) {
      throw new VisionError("Vision model rejected the request.", 502, detail.slice(0, 300) || null);
    }
    delete body.response_format;
    response = await postOpenAiCompatible(provider, body);
  }

  // 404 means the model id is gone (providers retire ids), not that the key is wrong.
  let consumedDetail = "";
  if (response.status === 404) {
    consumedDetail = await response.text().catch(() => "");
    const discovered = await discoverVisionModel(provider);
    if (discovered && discovered !== provider.model) {
      provider.model = discovered;
      body.model = discovered;
      response = await postOpenAiCompatible(provider, body);
      consumedDetail = "";
    }
  }

  if (!response.ok) {
    const detail = consumedDetail || (await response.text().catch(() => ""));
    if (response.status === 429) {
      throw new VisionError(
        "The free vision quota for today is used up. Try again tomorrow or add a second provider key.",
        429,
        detail.slice(0, 300) || null,
      );
    }

    if (response.status === 404) {
      const known = await listModels(provider);
      const vision = known.filter((id) => VISION_MODEL_HINT.test(id));
      throw new VisionError(
        vision.length > 0
          ? `${provider.name} has no model "${provider.model}". Vision-capable: ${vision.slice(0, 4).join(", ")}. Set VISION_MODEL.`
          : `${provider.name} offers no vision-capable model to this key (retired id "${provider.model}"). ` +
              `Use GEMINI_API_KEY or OPENROUTER_API_KEY instead; this key lists: ${known.slice(0, 6).join(", ") || "unknown"}.`,
        502,
        detail.slice(0, 300) || null,
      );
    }

    throw new VisionError(
      `Vision model responded with HTTP ${response.status} (${provider.name}/${provider.model}).`,
      502,
      detail.slice(0, 300) || null,
    );
  }

  const payload = await response.json().catch(() => null);
  const choice = payload?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";

  return { text, usage: payload?.usage ?? null, raw: payload, finish: choice?.finish_reason ?? "unknown" };
}

/**
 * Transcribes a betslip image. Tries each configured provider in order and, when every one
 * fails, reports **all** the failures — showing only the last hid why the primary gave up.
 *
 * @param {{ env: Record<string, unknown> | undefined, bytes: Uint8Array, mime: string }} input
 * @returns {Promise<VisionResult>}
 */
export async function extractBetslipImage({ env, bytes, mime }) {
  const chain = resolveVisionChain(env);
  if (chain.length === 0) {
    throw new VisionError(
      "No vision provider key is configured. Set GEMINI_API_KEY (free tier) for this deployment.",
      503,
    );
  }

  /** @type {VisionError | null} */
  let lastFailure = null;
  /** First upstream snippet wins: that is the primary provider's actual complaint. */
  let firstDetail = null;
  /** @type {string[]} */
  const failures = [];

  for (const provider of chain) {
    const call = provider.name === "gemini" ? callGemini : callOpenAiCompatible;

    try {
      const result = await call(provider, { bytes, mime });
      const parsed = parseJsonContent(result.text);

      if (!parsed || !Array.isArray(parsed.legs)) {
        lastFailure = new VisionError(
          `Vision model did not return usable JSON (finish_reason=${result.finish})`,
          502,
          result.text.slice(0, 300) || null,
        );
        failures.push(`${provider.name}/${provider.model}: ${lastFailure.message}`);
        continue;
      }

      return { parsed, provider: provider.name, model: provider.model, usage: result.usage, raw: result.raw };
    } catch (error) {
      lastFailure =
        error instanceof VisionError
          ? error
          : new VisionError(error instanceof Error ? error.message : String(error));
      failures.push(`${provider.name}/${provider.model}: ${lastFailure.message}`);
    }

    if (!firstDetail && lastFailure?.detail) firstDetail = lastFailure.detail;
  }

  if (failures.length === 0) throw lastFailure ?? new VisionError("Could not read that betslip.");

  throw new VisionError(
    failures.length === 1 ? failures[0] : `No provider could read that slip. ${failures.join(" | ")}`,
    lastFailure?.status === 429 ? 429 : 502,
    firstDetail ?? lastFailure?.detail ?? null,
  );
}
