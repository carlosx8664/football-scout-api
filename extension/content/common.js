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

  /** True when `node` is not covered by another element at its own centre. */
  function isTopmost(node) {
    if (!node || typeof document.elementFromPoint !== 'function') return false;
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return Boolean(hit) && (hit === node || node.contains(hit));
  }

  /**
   * The visible container that looks like a betslip and holds an input.
   *
   * BetBoro keeps two open at once (the pinned slip and the "Betslip (1)" drawer), so the one the
   * user can actually see — the topmost — wins over the merely larger one.
   */
  function findSlip() {
    const nodes = [
      ...document.querySelectorAll(
        '[class*="betslip" i], [data-testid*="betslip" i], [id*="betslip" i], [class*="slip" i], [class*="ticket" i]',
      ),
    ].filter((node) => visible(node) && node.querySelector('input'));

    const score = (node) => {
      const input = findStakeInput(node);
      return (input && isTopmost(input) ? 1_000_000 : 0) + area(node);
    };
    return nodes.sort((a, b) => score(b) - score(a))[0] ?? null;
  }

  const describeInput = (input) =>
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

  /** Text around the input, where "Total Stake" / "Stake" lives on both books. */
  const labelText = (input) => {
    const row = input.closest?.('label, li, [class*="stake" i], [class*="field" i], [class*="item" i]');
    return textOf(row ?? input.parentElement ?? input).slice(0, 120);
  };

  /**
   * Every editable input in the slip, best stake candidate first.
   *
   * Known branding: SportyBet's stake is `input.m-input`, BetBoro's is `input.pay_btn`
   * (`<input type="text" inputmode="none" min="0" class="pay_btn">`). Those win outright, then a
   * "min"/"stake" placeholder, then whatever sits beside a "stake" label, then the topmost field.
   */
  function stakeCandidates(slip) {
    if (!slip) return [];

    const inputs = [...slip.querySelectorAll('input')].filter(
      (input) =>
        visible(input) &&
        input.type !== 'hidden' &&
        !input.disabled &&
        !input.readOnly &&
        !/code|load|booking|share|promo|search|phone/.test(describeInput(input)),
    );

    const score = (input) => {
      const text = describeInput(input);
      let value = 0;
      if (/(^|\s)(m-input|pay_btn)(\s|$)/.test(input.className || '')) value += 20;
      if (/min|stake/i.test(input.getAttribute('placeholder') || '')) value += 8;
      if (/stake/.test(text)) value += 6;
      if (/stake|amount|wager/i.test(labelText(input))) value += 5;
      if (/amount|wager|bet-?amount/.test(text)) value += 3;
      if (input.type === 'number') value += 2;
      if (['decimal', 'numeric'].includes(input.inputMode)) value += 1;
      if (isTopmost(input)) value += 10;
      return value;
    };

    return inputs.map((input) => [score(input), input]).sort((a, b) => b[0] - a[0]).map(([, input]) => input);
  }

  /** The stake field inside a betslip, excluding booking/share/promo code inputs. */
  function findStakeInput(slip) {
    return stakeCandidates(slip)[0] ?? null;
  }

  /**
   * Side of a market outcome, independent of the bookmaker's own wording:
   * "BTTS Yes" -> yes, "Over 2.5 Goals" -> over, "Away (DNB)" -> away.
   */
  function sideOfOutcome(outcome) {
    const value = norm(outcome);
    if (/\bbtts yes\b|^yes\b/.test(value)) return 'yes';
    if (/\bbtts no\b|^no\b/.test(value)) return 'no';
    if (/^over\b|\bteam over\b/.test(value)) return 'over';
    if (/^under\b|\bteam under\b/.test(value)) return 'under';
    if (/^home win\b|^home\s*\(|^home$/.test(value)) return 'home';
    if (/^away win\b|^away\s*\(|^away$/.test(value)) return 'away';
    if (/^draw$/.test(value)) return 'draw';
    return null;
  }

  const SIDE_PATTERNS = {
    yes: /\byes\b|\bgg\b/,
    no: /\bno\b|\bng\b/,
    over: /\bover\b/,
    under: /\bunder\b/,
    home: /\bhome\b/,
    draw: /\bdraw\b/,
    away: /\baway\b/,
  };
  const SIDE_OPPOSITE = { yes: 'no', no: 'yes', over: 'under', under: 'over', home: 'away', away: 'home' };

  /**
   * Last-resort outcome check for a betslip: this side's own word is present and the opposite
   * side's is not. Used when the market label is missing from the job, which is what left the
   * SportyBet "Yes" selection looking like a mismatch.
   */
  function matchesSide(text, outcome) {
    const side = sideOfOutcome(outcome);
    if (!side) return false;

    const value = norm(text);
    if (!value || !SIDE_PATTERNS[side].test(value)) return false;

    const opposite = SIDE_OPPOSITE[side];
    return !opposite || !SIDE_PATTERNS[opposite].test(value);
  }

  /** A price from a tile: the only two-decimal number, never the line ("2.5") or an integer. */
  function parseOdds(text) {
    const matches = String(text || '').match(/\b\d{1,3}\.\d{2}\b/g) ?? [];
    const values = matches
      .map((value) => Number(value))
      .filter((value) => value >= 1.01 && value < 1000);
    return values.length ? values[values.length - 1] : null;
  }

  /**
   * The price of a betslip selection.
   *
   * Reading the whole slip text is what produced "3.80 → 38.00": the stake and the potential
   * payout sit next to the price, so the last number in the slip is the payout, not the odds.
   * The price element is read directly when the bookmaker exposes one; otherwise the number
   * closest to `expectedOdds` is taken, never the payout at the end of the slip.
   */
  function readSlipOdds(slip, expectedOdds) {
    if (!slip) return null;

    const priceNodes = [
      ...slip.querySelectorAll(
        '[class*="odd" i], [class*="price" i], [data-odds], [data-testid*="odd" i], [data-testid*="price" i]',
      ),
    ].filter(visible);

    for (const node of priceNodes) {
      // Only a node holding nothing but the price is trusted, so "2.5 1.58" is skipped.
      const text = textOf(node);
      if (/^\d{1,3}\.\d{2}$/.test(text)) return Number(text);
    }

    const values = textOf(slip)
      .match(/\b\d{1,3}\.\d{2}\b/g)
      ?.map(Number)
      .filter((value) => value >= 1.01 && value < 1000);
    if (!values?.length) return null;

    const expected = Number(expectedOdds) || 0;
    if (!(expected > 1)) return values[0];
    return values.reduce((best, value) =>
      Math.abs(value - expected) < Math.abs(best - expected) ? value : best,
    );
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

  /**
   * React-safe value write.
   *
   * The native setter plus `input` is enough for React, but the bookmakers' stake fields also
   * accept input through `insertText` (Angular masking) and some re-render on a bare `change`.
   * The field is therefore cleared, filled with `execCommand('insertText')`, and only re-written
   * character by character when the site still disagrees — then blurred.
   */
  function setInputValue(input, value, { keys = false } = {}) {
    if (!input) return false;
    const wanted = String(value);
    const digits = (text) => String(text ?? '').replace(/[^0-9.]/g, '');
    const fire = (type) => {
      // React 18/19 listen for InputEvent on some builds; fall back to a bubbling Event.
      try {
        if (type === 'input' && typeof InputEvent === 'function') {
          input.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              data: String(input.value ?? '').slice(-1),
              inputType: 'insertText',
            }),
          );
          return;
        }
      } catch {
        /* older Chromium */
      }
      input.dispatchEvent(new Event(type, { bubbles: true }));
    };
    const write = (text) => {
      try {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, text);
        else input.value = text;
      } catch {
        input.value = text;
      }
    };

    input.scrollIntoView({ block: 'center' });
    input.focus();
    try {
      input.select();
    } catch {
      /* not selectable */
    }

    write('');
    fire('input');

    let inserted = false;
    if (!keys) {
      try {
        inserted = document.execCommand('insertText', false, wanted);
      } catch {
        inserted = false;
      }
    }
    if (!inserted || digits(input.value) !== digits(wanted)) {
      write(wanted);
      fire('input');
    }

    // Second strategy (and the retry pass): type it a character at a time with real key events,
    // which is what masked inputs like SportyBet's `m-input` actually listen for.
    if (keys || digits(input.value) !== digits(wanted)) {
      write('');
      let typed = '';
      const keyEvent = (type, key) => {
        try {
          input.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
        } catch {
          /* KeyboardEvent unavailable */
        }
      };
      for (const char of wanted) {
        keyEvent('keydown', char);
        typed += char;
        write(typed);
        fire('input');
        keyEvent('keyup', char);
      }
    }

    fire('change');
    return digits(input.value) === digits(wanted);
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

  /**
   * Types the stake into an already-verified betslip and reports what the field actually holds.
   * `matches` lets a bookmaker pass its own alias-aware outcome check (the betslip may name the
   * market card rather than the scanner's outcome label).
   */
  /** Close/remove controls that belong to one selection (never the whole slip or Cashout). */
  function removalTargets(slip) {
    if (!slip) return [];

    const explicit = [
      ...slip.querySelectorAll(
        '[class*="remove" i], [class*="delete" i], [class*="trash" i], [aria-label*="remove" i], [aria-label*="delete" i], [title*="remove" i]',
      ),
    ];

    // SportyBet and BetBoro also render a bare "×" / trash glyph per selection row.
    const glyphs = [...slip.querySelectorAll('button, span, a, div')].filter((node) => {
      if (!visible(node) || node.children.length) return false;
      const text = textOf(node);
      if (!/^[×✕✖xX✗]$/.test(text)) return false;
      // Its row must look like a selection (a price lives next to the glyph).
      const row = node.closest('li, [class*="item" i], [class*="selection" i]') ?? node.parentElement;
      return Boolean(row) && parseOdds(textOf(row)) != null;
    });

    // Third shape: an unlabelled close/cancel button inside a selection row. The row test keeps
    // the slip's own "close panel" button — which has no price next to it — out of reach.
    const closers = [
      ...slip.querySelectorAll('[class*="close" i], [class*="cancel" i], [class*="clear" i]'),
    ].filter((node) => {
      if (!visible(node)) return false;
      if (/max|cash\s*out/i.test(`${textOf(node)} ${node.getAttribute?.('aria-label') ?? ''}`)) {
        return false;
      }
      const row = node.closest('li, [class*="item" i], [class*="selection" i]') ?? node.parentElement;
      return Boolean(row) && row !== slip && parseOdds(textOf(row)) != null;
    });

    const unique = [...new Set([...explicit, ...glyphs, ...closers])];
    return unique.filter(visible);
  }

  /**
   * Empties a betslip before a job fills it, so a leftover selection cannot ride along and the
   * stake we type is the only one on the page. Returns how many rows were removed.
   */
  async function clearSlip(slip, { attempts = 6, waitMs = 250 } = {}) {
    let cleared = 0;
    for (let index = 0; index < attempts; index += 1) {
      const [target] = removalTargets(slip);
      if (!target) break;
      deepClick(target.closest('button, a, [role="button"]') ?? target);
      cleared += 1;
      await sleep(waitMs);
    }
    return cleared;
  }

  async function fillSlip({ slip, stake, observedOdds, outcome, matches }) {
    if (!slip) {
      return { status: 'failed', observedOdds, message: 'Betslip not found.' };
    }
    const namesOutcome =
      typeof matches === 'function' ? matches(textOf(slip)) : textMatches(textOf(slip), outcome);
    if (outcome && !namesOutcome) {
      return {
        status: 'failed',
        observedOdds,
        message: `Betslip does not show "${outcome}". Nothing filled.`,
      };
    }

    const candidates = stakeCandidates(slip);
    if (!candidates.length) {
      return { status: 'failed', observedOdds, message: 'Could not find the stake field.' };
    }
    if (!(Number(stake) > 0)) {
      return { status: 'failed', observedOdds, message: `No stake to type (${stake}). Check Settings.` };
    }

    const wanted = String(stake);
    const digits = (text) => String(text ?? '').replace(/[^0-9.]/g, '');
    const holds = (input) => Math.abs(Number(digits(input.value)) - Number(stake)) <= 0.01;

    // Try each candidate until one actually keeps the value: a covered or mis-branded field reads
    // back whatever we wrote while the visible stake stays at the site default (10 / 0).
    let chosen = null;
    let lastSeen = '';
    for (const input of candidates.slice(0, 3)) {
      for (let attempt = 0; attempt < 2 && !chosen; attempt += 1) {
        setInputValue(input, wanted, { keys: attempt > 0 });
        await sleep(150);
        input.blur();
        await sleep(150);
        if (holds(input)) chosen = input;
      }
      lastSeen = `${input.className || input.type}="${input.value}"`;
      console.log(
        `[autobet] stake field ${input.className || input.type} value="${input.value}" wanted=${wanted} ok=${Boolean(chosen)}`,
      );
      if (chosen) break;
    }

    if (!chosen) {
      return {
        status: 'failed',
        observedOdds,
        message: `Stake field shows ${lastSeen || 'nothing'} instead of ${wanted}.`,
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
    matchesSide,
    findSlip,
    findStakeInput,
    parseOdds,
    readSlipOdds,
    oddsCheck,
    setInputValue,
    deepClick,
    waitFor,
    fillSlip,
    clearSlip,
    listen,
  };
})();
