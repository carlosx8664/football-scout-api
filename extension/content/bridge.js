/**
 * Dashboard bridge.
 *
 * Lets the React dashboard start a job without knowing the extension id: this content script
 * announces itself on load and relays a narrow, origin-checked message shape both ways.
 *
 *   page  -> window.postMessage({ source: 'oddtor-dashboard', type: 'AUTOBET_START', arb, totalStake })
 *   ext   <- window.postMessage({ source: 'oddtor-autobet', type: 'AUTOBET_START_RESULT', requestId, result })
 *
 *   page  -> window.postMessage({ source: 'oddtor-dashboard', type: 'AUTOBET_SLIP', legs })
 *   ext   <- window.postMessage({ source: 'oddtor-autobet', type: 'AUTOBET_SLIP_RESULT', requestId, result })
 *
 * The same page can also listen for 'AUTOBET_READY' to know the extension is installed.
 */
(() => {
  if (window.__oddtorAutobetBridge) return;
  window.__oddtorAutobetBridge = true;

  const EXT = 'oddtor-autobet';
  const PAGE = 'oddtor-dashboard';

  const post = (payload) => {
    try {
      window.postMessage({ source: EXT, ...payload }, window.location.origin);
    } catch {
      /* a closed message port is not worth throwing over */
    }
  };

  post({ type: 'AUTOBET_READY', id: chrome.runtime.id });

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== PAGE) return;

    if (data.type === 'AUTOBET_PING') {
      post({ type: 'AUTOBET_READY', id: chrome.runtime.id, requestId: data.requestId });
      return;
    }

    if (data.type !== 'AUTOBET_START' && data.type !== 'AUTOBET_SLIP') return;

    const isSlip = data.type === 'AUTOBET_SLIP';

    chrome.runtime.sendMessage(
      isSlip
        ? { type: 'AUTOBET_SLIP', legs: Array.isArray(data.legs) ? data.legs : [] }
        : {
            type: 'AUTOBET_START',
            arb: data.arb,
            totalStake: data.totalStake,
            roundStep: data.roundStep,
          },
      (result) => {
        post({
          type: isSlip ? 'AUTOBET_SLIP_RESULT' : 'AUTOBET_START_RESULT',
          requestId: data.requestId ?? null,
          result: result ?? { ok: false, error: chrome.runtime.lastError?.message ?? 'No response' },
        });
      },
    );
  });
})();
