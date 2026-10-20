import type { Odd } from "../types";

export function matchWinnerPrices(odds: Odd[] | null) {
  const price = (label: string) => odds?.find((entry) => entry.value === label)?.odd ?? "-";
  return { home: price("Home"), draw: price("Draw"), away: price("Away") };
}

export function formatKickoff(iso: string) {
  const kickoff = new Date(iso);
  return {
    date: kickoff.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
    time: kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  };
}
