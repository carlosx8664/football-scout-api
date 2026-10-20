import type { Match } from "../types";

export const KICKOFF_REFRESH_WINDOW_MS = 60 * 60 * 1000;
export const SNAPSHOT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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
