import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  NotificationContext,
  buildAlerts,
  dueAlerts,
  extractArbs,
  limitNotifications,
  loadLowBalances,
  loadNotifications,
  loadSeen,
  newNotificationId,
  saveLowBalances,
  saveNotifications,
  saveSeen,
  trackLowBalances,
  type AppNotification,
  type LowBalances,
  type SeenAlerts,
} from "../lib/notifications";
import { fetchArbsJson } from "../lib/api";
import { useSimulation } from "../lib/simulation";
import { fetchWallets } from "../lib/wallets";
import type { ArbOpportunity, WalletsPayload } from "../types";

type ModeKey = "sim" | "real";

const modeKey = (simulation: boolean): ModeKey => (simulation ? "sim" : "real");

/**
 * Owns the notification inbox and the suggestion engine.
 *
 * Alerts are rebuilt from the wallets payload on mode change, on mount, and whenever a caller
 * passes a fresh payload (wallet edit, reset, log, settle). `dueAlerts` suppresses duplicates
 * within the hour, so repeated triggers do not spam the bell.
 */
const NotificationProvider = ({ children }: { children: ReactNode }) => {
  const { enabled } = useSimulation();
  // One inbox per mode, so flipping the toggle swaps inboxes without a state write in an effect.
  const [inboxes, setInboxes] = useState<Record<ModeKey, AppNotification[]>>(() => ({
    sim: limitNotifications(loadNotifications(true)),
    real: limitNotifications(loadNotifications(false)),
  }));
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Record<ModeKey, SeenAlerts>>({
    sim: loadSeen(true),
    real: loadSeen(false),
  });
  // When each bookie first fell below the top-up threshold, so alerts can cool down.
  const lowRef = useRef<Record<ModeKey, LowBalances>>({
    sim: loadLowBalances(true),
    real: loadLowBalances(false),
  });
  // Latest arb feed, so a wallet-only refresh still raises the arb alerts.
  const arbsRef = useRef<ArbOpportunity[]>([]);

  const activeMode = modeKey(enabled);
  const notifications = inboxes[activeMode];
  const unreadCount = notifications.filter((item) => !item.read).length;

  useEffect(() => {
    saveNotifications(true, inboxes.sim);
  }, [inboxes.sim]);
  useEffect(() => {
    saveNotifications(false, inboxes.real);
  }, [inboxes.real]);

  const ingest = useCallback((payload: WalletsPayload, arbs = arbsRef.current) => {
    const mode = modeKey(payload.simulation);
    const now = Date.now();

    // Track shortfalls first: a bookie that just dropped starts its cool-down now, so logging a
    // bet never produces an instant top-up ping.
    const lowSince = trackLowBalances(payload, lowRef.current[mode], now);
    lowRef.current[mode] = lowSince;
    saveLowBalances(mode === "sim", lowSince);

    const seen = seenRef.current[mode];
    const due = dueAlerts(buildAlerts(payload, { now, lowSince, arbs }), seen, now);
    if (due.length === 0) return;

    for (const alert of due) {
      seen[alert.key] = { sentAt: now, metric: alert.metric };
    }
    saveSeen(mode === "sim", seen);

    const created = due.map<AppNotification>((alert) => ({
      id: newNotificationId(),
      tone: alert.tone,
      message: alert.message,
      createdAt: now,
      read: false,
    }));

    setInboxes((current) => ({
      ...current,
      [mode]: limitNotifications([...created, ...current[mode]]),
    }));
  }, []);

  const refresh = useCallback(
    (payload?: WalletsPayload) => {
      if (payload) {
        ingest(payload);
        return;
      }

      Promise.all([fetchWallets(enabled), fetchArbsJson()])
        .then(([next, rawArbs]) => {
          arbsRef.current = extractArbs(rawArbs);
          setError(null);
          ingest(next);
        })
        .catch((err: Error) => setError(err.message));
    },
    [enabled, ingest],
  );

  // Initial load and every mode switch re-evaluate the alerts.
  useEffect(() => {
    const controller = new AbortController();

    Promise.all([fetchWallets(enabled, controller.signal), fetchArbsJson(controller.signal)])
      .then(([next, rawArbs]) => {
        arbsRef.current = extractArbs(rawArbs);
        setError(null);
        ingest(next);
      })
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(err.message);
      });

    return () => controller.abort();
  }, [enabled, ingest]);

  const markAllRead = useCallback(() => {
    setInboxes((current) => ({
      ...current,
      [activeMode]: current[activeMode].map((item) =>
        item.read ? item : { ...item, read: true },
      ),
    }));
  }, [activeMode]);

  const dismiss = useCallback(
    (id: string) => {
      setInboxes((current) => ({
        ...current,
        [activeMode]: current[activeMode].filter((item) => item.id !== id),
      }));
    },
    [activeMode],
  );

  const value = useMemo(
    () => ({ notifications, unreadCount, error, markAllRead, dismiss, refresh }),
    [notifications, unreadCount, error, markAllRead, dismiss, refresh],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
};

export default NotificationProvider;
