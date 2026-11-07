import { createContext, useContext } from "react";
import type { ArbOpportunity, WalletsPayload } from "../types";

/** Same alert is suppressed for this long... */
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
/** ...unless its number moved by at least this much (percentage points / GHS). */
const SHARE_SIGNIFICANCE_PCT = 5;
const CASH_SIGNIFICANCE_GHS = 100;
/** Profit percentage points an arb must gain before it re-alerts inside its window. */
const ARB_PROFIT_SIGNIFICANCE_PCT = 1;

/** An arb stays "sent" for this long unless its profit improves materially. */
const ARB_DEDUPE_MS = 12 * 60 * 60 * 1000;

const MAX_NOTIFICATIONS = 50;
const STORAGE_PREFIX = "oddtor:notifications";
const SEEN_PREFIX = "oddtor:notifications-seen";

export type AlertTone = "critical" | "warning" | "good" | "info";

/** A notification sitting in the bell's inbox. */
export interface AppNotification {
  id: string;
  tone: AlertTone;
  message: string;
  createdAt: number;
  read: boolean;
}

/** One suggestion produced from the arb feed, before de-duplication. */
export interface Alert {
  /** Stable identity used for de-duplication, e.g. "arb:sr:match:123|1X2|…". */
  key: string;
  tone: AlertTone;
  message: string;
  /** The arb profit percentage the alert was based on. */
  metric: number;
  unit: "share" | "cash" | "profit";
}

export type SeenAlerts = Record<string, { sentAt: number; metric: number }>;

export interface AlertContext {
  now: number;
  /** Live opportunities from the arbitrage feed; each one lands in the inbox. */
  arbs?: ArbOpportunity[];
}

/** Reads the arb list out of the `/api/arbs` or `arbs.json` payload. */
export function extractArbs(raw: unknown): ArbOpportunity[] {
  if (Array.isArray(raw)) return raw as ArbOpportunity[];
  const payload = (raw ?? {}) as { arbs?: unknown };
  return Array.isArray(payload.arbs) ? (payload.arbs as ArbOpportunity[]) : [];
}

function arbAlertKey(arb: ArbOpportunity): string {
  const base = arb.eventId ?? `${arb.kickoff}-${arb.home}-${arb.away}`;
  const legs = (arb.legs ?? []).map((leg) => `${leg.bookmaker}:${leg.outcome}`).join("|");
  return `arb:${base}|${arb.market}|${legs}`;
}

function arbLegLine(arb: ArbOpportunity): string {
  return (arb.legs ?? [])
    .filter((leg) => Number.isFinite(Number(leg.odds)))
    .map((leg) => `${leg.bookmaker} ${leg.outcome} @ ${Number(leg.odds).toFixed(2)}`)
    .join(" · ");
}

/** Turns live arbs into suggestions. New arbitrage opportunities are the only alert source. */
export function buildAlerts({ now, arbs = [] }: AlertContext): Alert[] {
  const alerts: Alert[] = [];

  for (const arb of arbs) {
    const profitPct = Number(arb.profitPct);
    if (!Number.isFinite(profitPct)) continue;
    // Only pre-kickoff opportunities are actionable; started matches live in history.
    if (!Number.isFinite(arb.kickoff) || arb.kickoff <= now) continue;

    const legs = arbLegLine(arb);
    alerts.push({
      key: arbAlertKey(arb),
      tone: "good",
      unit: "profit",
      metric: profitPct,
      message:
        `🎯 ${profitPct.toFixed(2)}% arb: ${arb.home} vs ${arb.away}` +
        `${legs ? ` — ${legs}` : ""}. Open the Arbs page to log it.`,
    });
  }

  return alerts;
}

function isSignificant(alert: Alert, previous: { metric: number }): boolean {
  const threshold =
    alert.unit === "share"
      ? SHARE_SIGNIFICANCE_PCT
      : alert.unit === "profit"
        ? ARB_PROFIT_SIGNIFICANCE_PCT
        : CASH_SIGNIFICANCE_GHS;
  return Math.abs(alert.metric - previous.metric) >= threshold;
}

function dedupeWindowMs(alert: Alert): number {
  if (alert.key.startsWith("arb:")) return ARB_DEDUPE_MS;
  return DEDUPE_WINDOW_MS;
}

/** Drops alerts already sent inside their window unless their number moved significantly. */
export function dueAlerts(alerts: Alert[], seen: SeenAlerts, now = Date.now()): Alert[] {
  return alerts.filter((alert) => {
    const previous = seen[alert.key];
    if (!previous) return true;
    if (now - previous.sentAt >= dedupeWindowMs(alert)) return true;
    return isSignificant(alert, previous);
  });
}

export function limitNotifications(items: AppNotification[]): AppNotification[] {
  return items.slice(0, MAX_NOTIFICATIONS);
}

/** Local midnight that starts the current day. */
function startOfToday(now = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** Drops everything from a previous day: the inbox only ever shows today's alerts. */
export function pruneToToday(items: AppNotification[], now = Date.now()): AppNotification[] {
  const cutoff = startOfToday(now);
  return items.filter((item) => item.createdAt >= cutoff);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota: notifications simply do not survive a reload.
  }
}

export function loadNotifications(simulation: boolean): AppNotification[] {
  const stored = readJson<AppNotification[]>(
    `${STORAGE_PREFIX}:${simulation ? "sim" : "real"}`,
    [],
  );
  return pruneToToday(stored);
}

export function saveNotifications(simulation: boolean, items: AppNotification[]) {
  writeJson(`${STORAGE_PREFIX}:${simulation ? "sim" : "real"}`, items);
}

export function loadSeen(simulation: boolean): SeenAlerts {
  return readJson<SeenAlerts>(`${SEEN_PREFIX}:${simulation ? "sim" : "real"}`, {});
}

export function saveSeen(simulation: boolean, seen: SeenAlerts) {
  writeJson(`${SEEN_PREFIX}:${simulation ? "sim" : "real"}`, seen);
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function newNotificationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export interface NotificationStore {
  notifications: AppNotification[];
  unreadCount: number;
  error: string | null;
  markAllRead: () => void;
  /** Empties the inbox for the current mode, so the unread badge drops to zero. */
  clearAll: () => void;
  dismiss: (id: string) => void;
  /** Re-evaluates alerts; pass a payload you already fetched to avoid an extra request. */
  refresh: (payload?: WalletsPayload) => void;
}

export const NotificationContext = createContext<NotificationStore | null>(null);

export function useNotifications(): NotificationStore {
  const store = useContext(NotificationContext);
  if (!store) {
    throw new Error("useNotifications must be used inside <NotificationProvider>.");
  }
  return store;
}
