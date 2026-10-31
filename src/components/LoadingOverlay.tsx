import { useEffect, useRef, useState } from "react";
import "./LoadingOverlay.css";

/** Fade duration used by both this component and LoadingOverlay.css. */
export const LOADING_OVERLAY_FADE_MS = 120;

/** Minimum time the overlay stays fully opaque so it never blinks in and out. */
export const LOADING_OVERLAY_MIN_VISIBLE_MS = 600;

type LoadingOverlayProps = {
  /** Text shown under the logo. */
  message?: string;
  /** Fades the overlay in/out; it unmounts once the fade-out has finished. */
  visible?: boolean;
  /** How long the overlay stays up before it is allowed to fade out. */
  minVisibleMs?: number;
};

/** Full-screen solid overlay that hides the flash while reloading or booting. */
export default function LoadingOverlay({
  message = "Loading…",
  visible = true,
  minVisibleMs = LOADING_OVERLAY_MIN_VISIBLE_MS,
}: LoadingOverlayProps) {
  const [mounted, setMounted] = useState(visible);
  const [hiding, setHiding] = useState(!visible);
  const shownAtRef = useRef(Date.now());

  useEffect(() => {
    if (visible) {
      shownAtRef.current = Date.now();
      setMounted(true);
      setHiding(false);
      return;
    }

    // Hold the overlay for the minimum duration, then fade it out.
    const holdMs = Math.max(0, shownAtRef.current + minVisibleMs - Date.now());
    const holdTimer = window.setTimeout(() => setHiding(true), holdMs);
    const unmountTimer = window.setTimeout(() => setMounted(false), holdMs + LOADING_OVERLAY_FADE_MS);

    return () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(unmountTimer);
    };
  }, [visible, minVisibleMs]);

  if (!mounted) return null;

  return (
    <div
      className={`loading-overlay${hiding ? " loading-overlay--hiding" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy={!hiding}
    >
      <div className="loading-overlay__content">
        <img className="loading-overlay__logo" src="/logo.png" alt="" aria-hidden="true" />
        <p className="loading-overlay__message">{message}</p>
      </div>
    </div>
  );
}
