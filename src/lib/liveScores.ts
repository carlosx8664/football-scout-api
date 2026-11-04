import { useEffect, useState } from "react";
import type {
  LiveMatch,
  LiveScoresPayload,
  SettlementQueueItem,
  SettlementQueuePayload,
} from "../types";

/** The Worker rewrites the feed every minute; one poll per minute tracks it closely enough. */
export const LIVE_POLL_MS = 60_000;
/** The Worker only heartbeats every 5 minutes, so allow three beats before calling it stale. */
export const LIVE_MAX_AGE_MS = 15 * 60 * 1000;

async function readJson<T>(url: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const response = await fetch(url, { signal, cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  }
}

/** Live entries plus the finished scores the ledger already polled, keyed by Sportradar id. */
export function indexLiveMatches(payload: LiveScoresPayload | null): Map<string, LiveMatch> {
  const byId = new Map<string, LiveMatch>();
  if (!payload) return byId;

  const fresh = Date.now() - (payload.liveAt || 0) <= LIVE_MAX_AGE_MS;
  if (fresh) {
    for (const match of payload.live ?? []) {
      if (match?.eventId) byId.set(match.eventId, match);
    }
  }

  for (const match of payload.finished ?? []) {
    if (!match?.eventId) continue;
    byId.set(match.eventId, {
      eventId: match.eventId,
      home: match.home,
      away: match.away,
      matchStatus: match.matchStatus || "Ended",
      score: match.score,
      playedSeconds: null,
      period: null,
      status: match.status ?? 4,
      startTime: match.startTime ?? 0,
    });
  }

  return byId;
}

/**
 * "67'" while running, "HT" at the break, "FT" once the Worker has a final score.
 * The minute is extrapolated from the snapshot so the Worker can stop writing every minute.
 */
export function liveLabel(
  match: LiveMatch,
  anchor: { now: number; serverNow: number },
): string {
  if (match.status === 4 || match.matchStatus === "Ended") return "FT";
  if (match.matchStatus === "HT") return "HT";

  const base = Number(match.playedSeconds?.split(":")[0]);
  if (!Number.isFinite(base)) {
    return match.matchStatus === "H1" || match.matchStatus === "H2" ? "Live" : "";
  }

  // Only a running half advances; a paused or missing anchor must not invent minutes.
  const running = match.matchStatus === "H1" || match.matchStatus === "H2";
  const drift = running && anchor.serverNow > 0 ? Math.max(0, anchor.now - anchor.serverNow) : 0;
  return `${Math.min(120, Math.floor(base + drift / 60_000))}'`;
}

/** Splits SportyBet's "2:1" into the two sides; null when no goal has been scored yet. */
export function scoreParts(score: string | null): { home: string; away: string } | null {
  if (!score) return null;
  const [home, away] = score.split(":");
  if (!home?.trim() || !away?.trim()) return null;
  return { home: home.trim(), away: away.trim() };
}

/** Polls `/api/live-scores`, pausing while the tab is hidden. */
export function useLiveScores(): { payload: LiveScoresPayload | null; error: string | null } {
  const [payload, setPayload] = useState<LiveScoresPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;

    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const next = await readJson<LiveScoresPayload>("/api/live-scores", controller.signal);
        if (controller.signal.aborted) return;
        setPayload(next);
        setError(next ? null : "Live scores are unavailable.");
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = setInterval(() => void load(), LIVE_POLL_MS);

    // Catch up on the way back to the tab instead of waiting for the next tick.
    const onVisibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { payload, error };
}

/** Bets whose match the Worker has a final score for. Best-effort: [] on any failure. */
export async function fetchSettlementQueue(
  simulation: boolean,
  signal?: AbortSignal,
): Promise<SettlementQueueItem[]> {
  const payload = await readJson<SettlementQueuePayload>(
    `/api/settlement-queue?simulation=${simulation ? 1 : 0}`,
    signal,
  );
  return payload?.items ?? [];
}
