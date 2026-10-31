import { useEffect, useState } from "react";
import "./LoadingOverlay.css";

/** Fade duration used by both this component and LoadingOverlay.css. */
export const LOADING_OVERLAY_FADE_MS = 120;

type LoadingOverlayProps = {
  /** Text shown under the logo. */
  message?: string;
  /** Fades the overlay in/out; it unmounts once the fade-out has finished. */
  visible?: boolean;
};

/** Full-screen solid overlay that hides the flash while reloading or booting. */
export default function LoadingOverlay({ message = "Loading…", visible = true }: LoadingOverlayProps) {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }

    const timer = window.setTimeout(() => setMounted(false), LOADING_OVERLAY_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [visible]);

  if (!mounted) return null;

  return (
    <div
      className={`loading-overlay${visible ? "" : " loading-overlay--hiding"}`}
      role="status"
      aria-live="polite"
      aria-busy={visible}
    >
      <div className="loading-overlay__content">
        <img className="loading-overlay__logo" src="/logo.png" alt="" aria-hidden="true" />
        <p className="loading-overlay__message">{message}</p>
      </div>
    </div>
  );
}
