import type { Match } from "../types";

export const KICKOFF_REFRESH_WINDOW_MS = 60 * 60 * 1000;
export const SNAPSHOT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The home feed covers now through seven days from now, across UTC calendar days. */
export const FEED_DAYS = 8;

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

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function ordinal(day: number): string {
  const teen = day % 100;
  if (teen >= 11 && teen <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** Heading for a UTC day key: "Today" for the current day, otherwise "Wed 11th". */
export function dayLabel(dayKey: string, now: number): string {
  if (dayKey === utcDayKey(new Date(now).toISOString())) return "Today";
  const day = new Date(`${dayKey}T00:00:00Z`);
  return `${DAY_NAMES[day.getUTCDay()]} ${ordinal(day.getUTCDate())}`;
}

/** Every fixture that has kicked off and is still in the live feed. */
export function liveMatches(
  matches: Match[],
  now: number,
  liveEventIds?: ReadonlySet<string>,
): Match[] {
  const live = matches.filter(
    (match) =>
      Boolean(match.sr_id && liveEventIds?.has(match.sr_id)) &&
      new Date(match.fixture.date).getTime() <= now,
  );
  return live.sort(
    (a, b) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
  );
}

export interface DaySection {
  /** UTC day key (`YYYY-MM-DD`). */
  key: string;
  /** "Today" or "Wed 11th". */
  label: string;
  matches: Match[];
  /** True for the day containing `now`. */
  isToday: boolean;
}

/**
 * Calendar sections for the next `days` UTC dates starting today, earliest first.
 * Fixtures listed in `excludeIds` (the live ones) are left out so no row appears twice,
 * including dates without fixtures so the UI can always render every day tab.
 */
export function daySections(
  matches: Match[],
  now: number,
  options: { days?: number; excludeIds?: ReadonlySet<number> } = {},
): DaySection[] {
  const days = options.days ?? FEED_DAYS;
  const excludeIds = options.excludeIds;
  const todayKey = utcDayKey(new Date(now).toISOString());

  const byDay = new Map<string, Match[]>();
  for (const match of matches) {
    if (excludeIds?.has(match.fixture.id)) continue;
    const key = utcDayKey(match.fixture.date);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(match);
    else byDay.set(key, [match]);
  }

  const sections: DaySection[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const key = utcDayKey(new Date(now + offset * DAY_MS).toISOString());
    const dayFixtures = byDay.get(key) ?? [];

    sections.push({
      key,
      label: dayLabel(key, now),
      matches: dayFixtures.sort(
        (a, b) => new Date(a.fixture.date).getTime() - new Date(b.fixture.date).getTime(),
      ),
      isToday: key === todayKey,
    });
  }

  return sections;
}
