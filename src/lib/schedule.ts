import type { Match } from "../types";

export const KICKOFF_REFRESH_WINDOW_MS = 60 * 60 * 1000;
export const SNAPSHOT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedTab = "today" | "tomorrow";

/** UTC day key (`YYYY-MM-DD`) for an ISO kickoff string. */
export function utcDayKey(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/**
 * True when at least one match kicks off within `windowMs` of `now`.
 */
export function hasMatchStartingSoon(
  matches: Match[],
  now: number,
  windowMs = KICKOFF_REFRESH_WINDOW_MS,
): boolean {
  return matches.some((match) => {
    const kickoff = new Date(match.fixture.date).getTime();
    return kickoff > now && kickoff - now <= windowMs;
  });
}

/**
 * Matches for a feed tab. Today hides matches that already kicked off; tomorrow shows all of
 * tomorrow's fixtures (none of which can have started yet).
 */
export function matchesForTab(matches: Match[], tab: FeedTab, now: number): Match[] {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const tomorrowKey = new Date(now + DAY_MS).toISOString().slice(0, 10);
  const targetKey = tab === "today" ? todayKey : tomorrowKey;

  return matches.filter((match) => {
    if (utcDayKey(match.fixture.date) !== targetKey) return false;
    if (tab === "today") return new Date(match.fixture.date).getTime() > now;
    return true;
  });
}
