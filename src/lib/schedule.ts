import type { Match } from "../types";

export const KICKOFF_REFRESH_WINDOW_MS = 60 * 60 * 1000;
export const SNAPSHOT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedTab = "live" | "today" | "tomorrow";

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
 * Matches for a feed tab. "live" is every fixture that has kicked off and is still in the live
 * feed. Today and Tomorrow are the calendar fixtures for that day, including ones that have
 * already kicked off. Tomorrow shows all of tomorrow's fixtures, none of which can have started
 * yet.
 */
export function matchesForTab(
  matches: Match[],
  tab: FeedTab,
  now: number,
  liveEventIds?: ReadonlySet<string>,
): Match[] {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const tomorrowKey = new Date(now + DAY_MS).toISOString().slice(0, 10);

  if (tab === "live") {
    return matches.filter(
      (match) =>
        Boolean(match.sr_id && liveEventIds?.has(match.sr_id)) &&
        new Date(match.fixture.date).getTime() <= now,
    );
  }

  return matches.filter((match) => {
    const dayKey = utcDayKey(match.fixture.date);
    return dayKey === (tab === "today" ? todayKey : tomorrowKey);
  });
}
