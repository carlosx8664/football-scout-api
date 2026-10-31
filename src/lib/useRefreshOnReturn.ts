import { useEffect } from "react";

/** Time (ms) the page must stay hidden before returning triggers a hard refresh. */
const MIN_HIDDEN_MS = 5_000;

/**
 * Hard-refreshes the page when it becomes visible again after the user switched tabs,
 * minimized the window, or came back from the back/forward cache.
 */
export function useRefreshOnReturn(minHiddenMs: number = MIN_HIDDEN_MS) {
  useEffect(() => {
    let hiddenAt: number | null = null;

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }

      const awayFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (awayFor >= minHiddenMs) window.location.reload();
    };

    // Restored from the back/forward cache: the JS state is stale even though this
    // effect never re-ran, so force a reload to pull fresh arb data.
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, [minHiddenMs]);
}
