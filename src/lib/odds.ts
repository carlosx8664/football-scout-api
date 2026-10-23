import type { BookPrice } from "../types";

/** Bookmakers in the pre-multi-book feed shape. */
const LEGACY_KEYS: Record<string, string> = {
  sportybet: "SportyBet",
  msport: "MSport",
};

/**
 * Normalises a price into `[bookmaker, odds]` pairs, newest-first ordering left to the caller.
 *
 * The KV feed may briefly still hold the older flat shape (`sportybet`/`msport`) while the
 * refresh workflow rolls over, so both are accepted.
 */
export function bookQuotes(price?: BookPrice | null): Array<[string, number]> {
  if (!price) return [];

  const legacy = price as BookPrice & Record<string, unknown>;

  if (price.books && typeof price.books === "object") {
    return Object.entries(price.books).filter(([, odds]) => Number.isFinite(odds));
  }

  return Object.entries(LEGACY_KEYS)
    .map(([key, name]) => [name, legacy[key]] as [string, unknown])
    .filter(([, odds]) => typeof odds === "number" && Number.isFinite(odds))
    .map(([name, odds]) => [name, odds as number]);
}

/** Quotes ordered best price first. */
export function sortedQuotes(price?: BookPrice | null): Array<[string, number]> {
  return bookQuotes(price).sort((a, b) => b[1] - a[1]);
}
