import { useCallback, useEffect, useState } from "react";
import { LOADING_OVERLAY_FADE_MS } from "../components/LoadingOverlay";

/** Time (ms) the page must stay hidden before returning triggers a hard refresh. */
const MIN_HIDDEN_MS = 5_000;

/**
 * Hard-refreshes the page when it becomes visible again after the user switched tabs,
 * minimized the window, or came back from the back/forward cache.
 *
 * `refreshing` is true once the reload is scheduled, so the caller can show the
 * loading overlay over the old page instead of flashing it.
 */
export function useRefreshOnReturn(minHiddenMs: number = MIN_HIDDEN_MS) {
  const [refreshing, setRefreshing] = useState(false);

  // Mount the overlay first, then reload as soon as it is opaque. The wait is only
  // the fade duration; `location.reload()` tears the page down right after.
  const reloadWithOverlay = useCallback(() => {
    setRefreshing(true);
    window.setTimeout(() => window.location.reload(), LOADING_OVERLAY_FADE_MS);
  }, []);

  useEffect(() => {
    let hiddenAt: number | null = null;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }

      const awayFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (awayFor >= minHiddenMs) reloadWithOverlay();
    };

    // Restored from the back/forward cache: the JS state is stale even though this
    // effect never re-ran, so force a reload to pull fresh arb data.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reloadWithOverlay();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [minHiddenMs, reloadWithOverlay]);

  return { refreshing };
}
