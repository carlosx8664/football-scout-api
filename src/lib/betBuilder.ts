import type { BetBuilderResponse, BetBoroSlipLeg, SportyBetBooking } from "../types";

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
    betboro: payload.betboro ?? null,
    cached: payload.cached,
    stats: payload.stats,
  };
}

/**
 * Mints a SportyBet share link for the legs the user ticked. SportyBet and BetBoro are the two
 * books a scanned slip can be loaded into; BetBoro goes through the extension instead.
 */
export async function createSportyBetSlip(
  selections: SportyBetBooking[],
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch("/api/arbs/share", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selections }),
    signal,
  });

  const payload = (await response.json().catch(() => null)) as
    | { shareURL?: string; error?: string }
    | null;

  if (!response.ok || !payload?.shareURL) {
    throw new Error(
      payload?.error ?? `Could not build the SportyBet slip (HTTP ${response.status}).`,
    );
  }

  return String(payload.shareURL);
}

/** The bridge announces itself on load; this is how long we wait before calling it absent. */
const BRIDGE_TIMEOUT_MS = 1_500;
/** Filling a slip opens one tab per fixture, so a 20-leg slip is minutes, not seconds. */
const SLIP_TIMEOUT_MS = 10 * 60_000;

export interface BetBoroFillResult {
  filled: number;
  total: number;
  results: Array<{ label: string; status: string; message?: string }>;
}

/**
 * Talks to the `Odds Autobet` extension through the dashboard bridge (`extension/content/bridge.js`).
 * Rejects with a readable message when the extension is missing or stops answering.
 */
function bridgeRequest<T>(type: string, payload: Record<string, unknown>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const requestId = `bb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let settled = false;
    let readyTimer: number | undefined;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (readyTimer) window.clearTimeout(readyTimer);
      window.clearTimeout(timer);
    };

    const finish = (error: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value as T);
    };

    const timer = window.setTimeout(
      () => finish(new Error("The extension stopped responding while filling the slip.")),
      timeoutMs,
    );

    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data as
        | { source?: string; type?: string; requestId?: string; result?: unknown }
        | null;
      if (!data || data.source !== "oddtor-autobet") return;

      if (data.type === "AUTOBET_READY") {
        if (readyTimer) {
          window.clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        window.postMessage(
          { source: "oddtor-dashboard", type, requestId, ...payload },
          window.location.origin,
        );
        return;
      }

      if (data.type !== `${type}_RESULT` || data.requestId !== requestId) return;

      const result = data.result as { error?: string } | null | undefined;
      if (!result) finish(new Error("The extension returned no result."));
      else if (result.error) finish(new Error(String(result.error)));
      else finish(null, result as T);
    }

    window.addEventListener("message", onMessage);
    // A bridge that loaded before this listener cannot announce itself again, so ping it.
    window.postMessage(
      { source: "oddtor-dashboard", type: "AUTOBET_PING", requestId: `${requestId}-ping` },
      window.location.origin,
    );
    readyTimer = window.setTimeout(
      () => finish(new Error("The Odds Autobet extension is not installed in this browser.")),
      BRIDGE_TIMEOUT_MS,
    );
  });
}

/**
 * Adds the scanned selections to a BetBoro betslip.
 *
 * BetBoro has no booking API, so the extension opens each fixture, clicks the outcome and — on the
 * first leg only — clears whatever was already in the slip. No stake is typed.
 */
export async function addToBetBoroSlip(legs: BetBoroSlipLeg[]): Promise<BetBoroFillResult> {
  if (legs.length === 0) {
    throw new Error("No selection on this slip can be added to BetBoro automatically.");
  }

  const result = await bridgeRequest<Partial<BetBoroFillResult>>(
    "AUTOBET_SLIP",
    {
      legs: legs.map((leg) => ({
        bookmaker: "BetBoro",
        url: leg.url,
        market: leg.market,
        outcome: leg.outcome,
        label: leg.label,
      })),
    },
    SLIP_TIMEOUT_MS,
  );

  return {
    filled: Number(result?.filled ?? 0),
    total: Number(result?.total ?? legs.length),
    results: Array.isArray(result?.results) ? result.results : [],
  };
}
