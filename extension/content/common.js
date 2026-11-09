/**
 * Shared DOM helpers for the bookmaker content scripts.
 *
 * Everything here is a straight port of the proven `page.evaluate()` bodies in
 * `scripts/sportybet-autobet.js` and `scripts/betboro-autobet.js`. The one difference is the
 * click: Puppeteer's click is CDP-trusted, a content-script click is not, so `deepClick` fires a
 * full pointer/mouse sequence at the element's centre before the synthetic `click`.
 *
 * Loaded as the first file of each bookmaker content script, so both files share one isolated
 * world. `entry()` keeps the singleton honest when the same script is injected twice.
 */
(() => {
  if (globalThis.__autobet?.version) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const textOf = (node) =>
    (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();

  const visible = (node) => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };

  const area = (node) => {
    const box = node.getBoundingClientRect();
    return box.width * box.height;
  };

  /** Lower-cased, punctuation-light form used for every label comparison. */
  const norm = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/(\d),(\d)/g, '$1.$2')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9./ ]/g, '')
      .trim();

  /** "Over 2.5 Goals" -> "over 2.5", so a bookmaker tile reading "Over 2.5" matches exactly. */
  const canonicalOutcome = (value) =>
    norm(value)
      .replace(/\bgoals?\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * Acceptable spellings of the scanner's outcome label on a bookmaker's own UI.
   * The feed uses prose ("Over 2.5 Goals", "Home or Draw") while the tiles use tokens ("Over 2.5", "1X").
   */
  function outcomeCandidates(raw) {
    const canonical = canonicalOutcome(raw);
    if (!canonical) return [];

    const candidates = [canonical];
    const stripped = canonical
      .replace(/\b(win|team|market|result)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped && stripped !== canonical) candidates.push(stripped);

    const hasHome = /\bhome\b/.test(canonical);
    const hasAway = /\baway\b/.test(canonical);
    const hasDraw = /\bdraw\b/.test(canonical);

    if (hasHome && hasDraw) candidates.push('1x');
    if (hasAway && hasDraw) candidates.push('x2');
    if (hasHome && hasAway) candidates.push('12');
    if (hasHome && !hasDraw && !hasAway) candidates.push('1');
    if (hasAway && !hasDraw && !hasHome) candidates.push('2');
    if (hasDraw && !hasHome && !hasAway) candidates.push('x');

    return [...new Set(candidates.filter(Boolean))];
  }

  /**
   * True when `text` (a tile label or a whole betslip) names the expected outcome.
   * Long container text matches by inclusion, short tile labels must match exactly one candidate.
   */
  function textMatches(text, rawOutcome) {
    const candidates = outcomeCandidates(rawOutcome);
    if (!candidates.length) return false;
    const value = canonicalOutcome(text);
    if (!value) return false;

    const short = value.length <= 30;
    return candidates.some((candidate) => {
      if (value === candidate) return true;
      if (short) return false;
      return candidate.length >= 4 && value.includes(candidate);
    });
  }

  /**
   * Which supported bookmaker market family an arb market belongs to.
   * Anything else returns 'exotic' and is never auto-filled — a wrong-market fill is worse than none.
   */
  function marketFamily(market) {
    const value = norm(market);
    if (/^over\/under [\d.]+ goals$/.test(value)) return 'ou';
    if (value === 'both teams to score') return 'btts';
    if (/^(draw no bet|dnb|home win|away win|draw|home\/draw)/.test(value)) return 'result';
    return 'exotic';
  }

  /** The largest visible container that looks like a betslip and holds an input. */
  function findSlip() {
    const nodes = [
      ...document.querySelectorAll(
        '[class*="betslip" i], [data-testid*="betslip" i], [id*="betslip" i], [class*="slip" i], [class*="ticket" i]',
      ),
    ].filter((node) => visible(node) && node.querySelector('input'));

    return nodes.sort((a, b) => area(b) - area(a))[0] ?? null;
  }

  /** The stake field inside a betslip, excluding booking/share/promo code inputs. */
  function findStakeInput(slip) {
    if (!slip) return null;
    const describe = (input) =>
      [
        input.getAttribute('placeholder'),
        input.getAttribute('aria-label'),
        input.getAttribute('name'),
        input.getAttribute('data-testid'),
        input.id,
        input.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const inputs = [...slip.querySelectorAll('input')].filter(
      (input) =>
        visible(input) && input.type !== 'hidden' && !input.disabled && !input.readOnly,
    );

    const scored = inputs
      .filter((input) => !/code|load|booking|share|promo|search|phone/.test(describe(input)))
      .map((input) => {
        const text = describe(input);
        let score = 0;
        if (/stake/.test(text)) score += 5;
        if (/amount|wager|bet-?amount/.test(text)) score += 3;
        if (input.type === 'number') score += 2;
        if (['decimal', 'numeric'].includes(input.inputMode)) score += 2;
        return [score, input];
      })
      .sort((a, b) => b[0] - a[0]);

    return scored[0]?.[1] ?? null;
  }

  /** Last 2-decimal number in range — odds, not a line ("2.5") or an empty "0.00" payout. */
  function parseOdds(text) {
    const matches = String(text || '').match(/\b\d{1,3}\.\d{2}\b/g) ?? [];
    const values = matches
      .map((value) => Number(value))
      .filter((value) => value >= 1.01 && value < 1000);
    return values.length ? values[values.length - 1] : null;
  }

  function oddsCheck(expectedOdds, observedOdds, tolerancePct, ignoreOdds) {
    if (ignoreOdds) return { ok: true, message: '' };
    if (!observedOdds) {
      return { ok: false, message: 'Could not read a live price from the betslip.' };
    }
    if (!(expectedOdds > 1)) return { ok: true, message: '' };

    const drift = (Math.abs(observedOdds - expectedOdds) / expectedOdds) * 100;
    if (drift > Number(tolerancePct ?? 0.5)) {
      return {
        ok: false,
        message: `Odds moved: ${expectedOdds.toFixed(2)} → ${observedOdds.toFixed(2)} (${drift.toFixed(1)}%). Nothing filled.`,
      };
    }
    return { ok: true, message: '' };
  }

  /** React-safe value write: the native setter plus input/change, then blur. */
  function setInputValue(input, value) {
    if (!input) return false;
    input.focus();
    try {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(input, String(value));
      else input.value = String(value);
    } catch {
      input.value = String(value);
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Synthetic click with a real pointer sequence at the element's centre.
   * The events are still `isTrusted: false`; the sequence is what gets React handlers to fire.
   */
  function deepClick(element) {
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const box = element.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    };

    try {
      element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
    } catch {
      /* PointerEvent is unavailable only on very old Chromium. */
    }
    element.dispatchEvent(new MouseEvent('mousedown', init));
    try {
      element.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, isPrimary: true }));
    } catch {
      /* ignore */
    }
    element.dispatchEvent(new MouseEvent('mouseup', init));
    element.dispatchEvent(new MouseEvent('click', init));
    return true;
  }

  async function waitFor(check, { timeout = 20000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const value = check();
        if (value) return value;
      } catch {
        /* keep polling while the SPA re-renders */
      }
      if (Date.now() > deadline) return null;
      await sleep(interval);
    }
  }

  /** Types the stake into an already-verified betslip and reports what the field actually holds. */
  function fillSlip({ slip, stake, observedOdds, outcome }) {
    if (!slip) {
      return { status: 'failed', observedOdds, message: 'Betslip not found.' };
    }
    if (outcome && !textMatches(textOf(slip), outcome)) {
      return {
        status: 'failed',
        observedOdds,
        message: `Betslip does not show "${outcome}". Nothing filled.`,
      };
    }

    const input = findStakeInput(slip);
    if (!input) {
      return { status: 'failed', observedOdds, message: 'Could not find the stake field.' };
    }

    const wanted = String(stake);
    input.scrollIntoView({ block: 'center' });
    setInputValue(input, wanted);
    input.blur();

    const actual = Number(String(input.value).replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(actual) || Math.abs(actual - Number(stake)) > 0.01) {
      return {
        status: 'failed',
        observedOdds,
        message: `Stake field shows "${input.value}" instead of ${wanted}.`,
      };
    }

    return {
      status: 'filled',
      observedOdds,
      message: `GHS ${wanted} entered${observedOdds ? ` at ${observedOdds.toFixed(2)}` : ''}. Place Bet is yours.`,
    };
  }

  /** Wraps a bookmaker handler in the `AUTOBET_FILL` message contract. */
  function listen(bookmaker, run) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== 'AUTOBET_FILL') return undefined;
      if (message.leg?.bookmaker && message.leg.bookmaker !== bookmaker) {
        sendResponse({ status: 'failed', message: `Not a ${bookmaker} leg.` });
        return undefined;
      }
      Promise.resolve(run(message))
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({ status: 'failed', message: String(error?.message || error) }),
        );
      return true;
    });
  }

  globalThis.__autobet = {
    version: 1,
    sleep,
    textOf,
    visible,
    area,
    norm,
    canonicalOutcome,
    outcomeCandidates,
    textMatches,
    marketFamily,
    findSlip,
    findStakeInput,
    parseOdds,
    oddsCheck,
    setInputValue,
    deepClick,
    waitFor,
    fillSlip,
    listen,
  };
})();
