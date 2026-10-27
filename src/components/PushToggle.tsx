import { useCallback, useEffect, useState } from "react";
import { disablePush, enablePush, pushStatus, type PushStatus } from "../lib/push";
import "./PushToggle.css";

const LABELS: Record<PushStatus | "busy", string> = {
  unsupported: "No push support",
  blocked: "Alerts blocked",
  off: "Allow alerts",
  on: "Alerts on",
  busy: "Working…",
};

/**
 * Header control that opts this browser into arb push notifications.
 *
 * Clicking "Allow alerts" is what triggers Chrome's permission prompt; once
 * granted, the scanner can wake the phone for each new arb and tapping the
 * notification opens that arb's card.
 */
const PushToggle = () => {
  const [status, setStatus] = useState<PushStatus>("off");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void pushStatus().then((next) => {
      if (active) setStatus(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      if (status === "on") {
        await disablePush();
      } else {
        await enablePush();
      }
      setStatus(await pushStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(await pushStatus().catch(() => status));
    } finally {
      setBusy(false);
    }
  }, [status]);

  if (status === "unsupported") return null;

  const blocked = status === "blocked";
  const on = status === "on";

  return (
    <div className="push-toggle">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={on ? "Disable arb push alerts" : "Allow arb push alerts"}
        className={`push-toggle-button ${on ? "on" : "off"}${blocked ? " blocked" : ""}`}
        onClick={toggle}
        disabled={busy || blocked}
        title={
          blocked
            ? "Notifications are blocked for this site. Re-enable them in Chrome's site settings."
            : "Get a phone notification for each new arbitrage opportunity"
        }
      >
        <span className="push-toggle-dot" aria-hidden="true" />
        <span className="push-toggle-label">{busy ? LABELS.busy : LABELS[status]}</span>
      </button>

      {error && (
        <span className="push-toggle-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};

export default PushToggle;
