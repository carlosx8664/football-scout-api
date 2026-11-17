/**
 * Bet-slip vision adapters (free tier).
 *
 * The model is only a camera: it transcribes the slip into the JSON contract in
 * `betslip-prompt.js`. Matching the picks to our feed and booking them on SportyBet stays
 * deterministic in `betslip-match.js`, so a misread row can never book a different bet.
 *
 * Providers, tried in order:
 *   gemini      Google AI Studio free tier   GEMINI_API_KEY       (best OCR)
 *   groq        Groq free tier               GROQ_API_KEY
 *   openrouter  OpenRouter `:free` models    OPENROUTER_API_KEY
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
    defaultModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    headers: {},
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/chat/completions",
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

/**
 * Providers we have a key for, primary first.
 *
 * @param {Record<string, unknown> | undefined} env
 * @returns {Array<{ name: string, key: string, model: string }>}
 */
export function resolveVisionChain(env) {
  const keys = {
    gemini: trim(env?.GEMINI_API_KEY),
    groq: trim(env?.GROQ_API_KEY),
    openrouter: trim(env?.OPENROUTER_API_KEY),
  };
  const requested = trim(env?.VISION_PROVIDER).toLowerCase();
  const preferred = ["gemini", "groq", "openrouter"].filter((name) => keys[name]);
  const order = requested && keys[requested]
    ? [requested, ...preferred.filter((name) => name !== requested)]
    : preferred;

  const overrideModel = trim(env?.VISION_MODEL);

  return order.map((name) => ({
    name,
    key: keys[name],
    model: overrideModel || (name === "gemini" ? GEMINI_DEFAULT_MODEL : OPENAI_COMPATIBLE[name].defaultModel),
  }));
}

export function isVisionConfigured(env) {
  return resolveVisionChain(env).length > 0;
}

/** Part of the KV cache key: a new provider or model must not reuse an older parse. */
export function visionCacheScope(env) {
  const [primary] = resolveVisionChain(env);
  return primary ? `${primary.name}-${primary.model}` : "unconfigured";
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

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const status = response.status === 429 ? 429 : 502;
    throw new VisionError(
      status === 429
        ? "The free vision quota for today is used up. Try again tomorrow or add a second provider key."
        : `Vision model responded with HTTP ${response.status}`,
      status,
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

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const status = response.status === 429 ? 429 : 502;
    throw new VisionError(
      status === 429
        ? "The free vision quota for today is used up. Try again tomorrow or add a second provider key."
        : `Vision model responded with HTTP ${response.status}`,
      status,
      detail.slice(0, 300) || null,
    );
  }

  const payload = await response.json().catch(() => null);
  const choice = payload?.choices?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";

  return { text, usage: payload?.usage ?? null, raw: payload, finish: choice?.finish_reason ?? "unknown" };
}

/**
 * Transcribes a betslip image. Tries the primary provider, then the fallback when one is
 * configured, and throws the last error only if every provider failed.
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
  let failure = null;

  for (const provider of chain) {
    const call = provider.name === "gemini" ? callGemini : callOpenAiCompatible;

    try {
      const result = await call(provider, { bytes, mime });
      const parsed = parseJsonContent(result.text);

      if (!parsed || !Array.isArray(parsed.legs)) {
        failure = new VisionError(
          `Vision model did not return usable JSON (finish_reason=${result.finish})`,
          502,
          result.text.slice(0, 300) || null,
        );
        continue;
      }

      return { parsed, provider: provider.name, model: provider.model, usage: result.usage, raw: result.raw };
    } catch (error) {
      failure =
        error instanceof VisionError
          ? error
          : new VisionError(error instanceof Error ? error.message : String(error));
    }
  }

  throw failure ?? new VisionError("Could not read that betslip.");
}
