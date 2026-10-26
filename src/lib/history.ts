import type { HistoryPayload } from "../types";

export type HistoryPreset = "today" | "yesterday" | "week" | "custom";

export interface HistoryRange {
  /** Inclusive YYYY-MM-DD bounds, in the user's local calendar. */
  from: string;
  to: string;
}

/** Local calendar date as YYYY-MM-DD (not UTC, so "today" matches the user's clock). */
export function toDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function rangeForPreset(preset: HistoryPreset, custom: HistoryRange): HistoryRange {
  const today = new Date();

  if (preset === "custom") {
    return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
  }

  if (preset === "today") {
    const value = toDateInput(today);
    return { from: value, to: value };
  }

  if (preset === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const value = toDateInput(yesterday);
    return { from: value, to: value };
  }

  // "This Week": Monday through today, matching the server's weekly outlay window.
  const monday = new Date(today);
  const offset = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - offset);
  return { from: toDateInput(monday), to: toDateInput(today) };
}

export async function fetchHistory(
  simulation: boolean,
  range: HistoryRange,
  signal?: AbortSignal,
): Promise<HistoryPayload> {
  const query = new URLSearchParams({
    simulation: simulation ? "1" : "0",
    from: range.from,
    to: range.to,
  });

  const response = await fetch(`/api/history?${query.toString()}`, {
    signal,
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (HistoryPayload & { error?: string })
    | null;

  if (!response.ok || !payload?.entries) {
    throw new Error(payload?.error ?? `Could not load history (HTTP ${response.status}).`);
  }

  return payload;
}
