import { createContext, useContext } from "react";
import type { WalletsPayload } from "../types";
import { formatGhs } from "./wallets";

/** Cash share of the portfolio that triggers a withdrawal nudge. */
export const WITHDRAW_ALERT_PCT = 35;
/** Cash share of the portfolio that triggers a top-up nudge. */
export const TOPUP_ALERT_PCT = 15;
/** Today's realised profit that suggests taking a break. */
export const DAILY_PROFIT_GOAL = 100;

/** Same alert is suppressed for this long... */
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
/** ...unless its number moved by at least this much (percentage points / GHS). */
const SHARE_SIGNIFICANCE_PCT = 5;
const CASH_SIGNIFICANCE_GHS = 100;

const MAX_NOTIFICATIONS = 50;
const STORAGE_PREFIX = "oddtor:notifications";
const SEEN_PREFIX = "oddtor:notifications-seen";
const SPECIAL_BOOKIE = "BetBoro";

export type AlertTone = "critical" | "warning" | "good" | "info";

/** A notification sitting in the bell's inbox. */
export interface AppNotification {
  id: string;
  tone: AlertTone;
  message: string;
  createdAt: number;
  read: boolean;
}

/** One suggestion produced from a wallets payload, before de-duplication. */
export interface Alert {
  /** Stable identity used for de-duplication, e.g. "withdraw:BoltBet". */
  key: string;
  tone: AlertTone;
  message: string;
  /** Share (percentage points) or cash amount the alert was based on. */
  metric: number;
  unit: "share" | "cash";
}

export type SeenAlerts = Record<string, { sentAt: number; metric: number }>;

/**
 * Turns the current wallets payload into suggestions.
 *
 * The portfolio is cash + staked: stakes are debited at log time, so a large pending arb must
 * not make every bookie look under-funded.
 */
export function buildAlerts(payload: WalletsPayload): Alert[] {
  const cash = payload.wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
  const portfolio = cash + payload.liquidity.staked;
  const alerts: Alert[] = [];

  if (portfolio > 0) {
    for (const wallet of payload.wallets) {
      const share = (wallet.balance / portfolio) * 100;

      if (share > WITHDRAW_ALERT_PCT) {
        alerts.push({
          key: `withdraw:${wallet.name}`,
          tone: "warning",
          unit: "share",
          metric: share,
          message:
            `🔴 Withdraw from ${wallet.name}: Balance is too high (${share.toFixed(1)}%). ` +
            "Move funds to mobile money or another bookie.",
        });
      } else if (share < TOPUP_ALERT_PCT) {
        alerts.push({
          key: `topup:${wallet.name}`,
          tone: "good",
          unit: "share",
          metric: share,
          message:
            `🟢 Top up ${wallet.name}: Balance is low (${share.toFixed(1)}%). ` +
            "Deposit funds to avoid missing arbs.",
        });
      }
    }

    const betboro = payload.wallets.find(
      (wallet) => wallet.name.toLowerCase() === SPECIAL_BOOKIE.toLowerCase(),
    );
    if (betboro && betboro.balance > 0) {
      alerts.push({
        key: "betboro:withdraw",
        tone: "critical",
        unit: "cash",
        metric: betboro.balance,
        message:
          `🚨 BetBoro Warning: Withdraw your ${formatGhs(betboro.balance)} immediately to ` +
          "avoid slow withdrawal limits.",
      });
    }
  }

  const dailyProfit = payload.dailyProfit ?? 0;
  if (dailyProfit > DAILY_PROFIT_GOAL) {
    alerts.push({
      key: "daily-goal",
      tone: "info",
      unit: "cash",
      metric: dailyProfit,
      message:
        `🎯 Daily Goal Reached: You've made ${formatGhs(dailyProfit)} today. Consider stopping ` +
        "to protect your accounts from over-betting.",
    });
  }

  return alerts;
}

function isSignificant(alert: Alert, previous: { metric: number }): boolean {
  const threshold = alert.unit === "share" ? SHARE_SIGNIFICANCE_PCT : CASH_SIGNIFICANCE_GHS;
  return Math.abs(alert.metric - previous.metric) >= threshold;
}

/** Drops alerts already sent in the last hour unless their number moved significantly. */
export function dueAlerts(alerts: Alert[], seen: SeenAlerts, now = Date.now()): Alert[] {
  return alerts.filter((alert) => {
    const previous = seen[alert.key];
    if (!previous) return true;
    if (now - previous.sentAt >= DEDUPE_WINDOW_MS) return true;
    return isSignificant(alert, previous);
  });
}

export function limitNotifications(items: AppNotification[]): AppNotification[] {
  return items.slice(0, MAX_NOTIFICATIONS);
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
  return readJson<AppNotification[]>(`${STORAGE_PREFIX}:${simulation ? "sim" : "real"}`, []);
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
