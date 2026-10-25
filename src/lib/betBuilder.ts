import type { BetBuilderResponse } from "../types";

/**
 * Client for POST /api/bet-builder/extract.
 *
 * Screenshots are re-encoded before upload: a 4 MB phone screenshot becomes a few hundred KB of
 * JPEG, which keeps the request under Workers' body limits and cuts vision tokens.
 */

const ENDPOINT = "/api/bet-builder/extract";
/** Longest edge after downscaling. Beyond this the model gains nothing. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;
/** Already-small originals are sent untouched rather than recompressed. */
const SKIP_BELOW_BYTES = 400 * 1024;

async function downscale(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) return file;
  if (typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // HEIC/SVG and friends can fail to decode here; let the API reject them with a message.
    return file;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > MAX_EDGE ? MAX_EDGE / longest : 1;

  if (scale === 1 && file.size <= SKIP_BELOW_BYTES) {
    bitmap.close?.();
    return file;
  }

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close?.();
    return file;
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const encoded = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY);
  });

  return encoded ?? file;
}

export async function extractBetslip(
  file: File,
  signal?: AbortSignal,
): Promise<BetBuilderResponse> {
  const prepared = await downscale(file);
  const isJpeg = prepared.type === "image/jpeg";

  const body = new FormData();
  body.append("image", prepared, isJpeg ? "betslip.jpg" : file.name || "betslip.png");

  const response = await fetch(ENDPOINT, { method: "POST", body, signal });

  const payload = (await response.json().catch(() => null)) as
    | (Partial<BetBuilderResponse> & { error?: string; detail?: string | null })
    | null;

  if (!response.ok || !payload || !Array.isArray(payload.matched)) {
    const detail = payload?.detail ? ` (${payload.detail})` : "";
    throw new Error(payload?.error ?? `Scan failed with HTTP ${response.status}${detail}.`);
  }

  return {
    bookmaker: payload.bookmaker ?? null,
    warnings: payload.warnings ?? [],
    matched: payload.matched,
    unresolved: payload.unresolved ?? [],
    sportybetAccaUrl: payload.sportybetAccaUrl ?? null,
    sportybetAccaCode: payload.sportybetAccaCode ?? null,
    sportybetAccaWarning: payload.sportybetAccaWarning ?? null,
    cached: payload.cached,
    stats: payload.stats,
  };
}
