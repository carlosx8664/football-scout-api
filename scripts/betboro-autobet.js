/**
 * Experimental BetBoro autobet probe (V1 Prep Bot).
 *
 * Opens a real BetBoro fixture in a visible browser, logs in (saved profile first, then
 * BETBORO_USERNAME/BETBORO_PASSWORD from .env), clicks "Goals" → "Over 2.5", types a stake into the
 * betslip and stops there — it never touches "Place Bet".
 *
 * Usage: node scripts/betboro-autobet.js [url] [--stake=10] [--close]
 *   --close  exit once the screenshot is written (default leaves the browser open to inspect)
 *
 * Requires puppeteer: npm i -D puppeteer
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const DEFAULT_URL =
  'https://betboro.com.gh/pre-sports/1/region/50/competition/7249/fixture/91588027';
const SHOT_PATH = path.join('data', 'betboro-debug.png');
const LOGIN_SHOT_PATH = path.join('data', 'betboro-login.png');
/** Persistent Chrome profile: cookies + localStorage survive between runs, so the login sticks. */
const PROFILE_DIR = path.join('data', 'betboro-profile');

const args = process.argv.slice(2);
const FIXTURE_URL = args.find((arg) => /^https?:\/\//i.test(arg)) ?? DEFAULT_URL;
const STAKE = (args.find((arg) => arg.startsWith('--stake=')) ?? '--stake=10').split('=')[1];
const CLOSE_WHEN_DONE = args.includes('--close');

/** Local credentials (`.env` today, Cloudflare secrets once this runs as a Worker). */
const BETBORO_USERNAME = (process.env.BETBORO_USERNAME ?? '').trim();
const BETBORO_PASSWORD = process.env.BETBORO_PASSWORD ?? '';
const HAS_CREDENTIALS = Boolean(BETBORO_USERNAME && BETBORO_PASSWORD);

const GOALS_TAB = [/goals\s*\(\d+\)/i, /^goals$/i];
const TOTAL_GOALS_MARKET = [/total goals over\s*\/\s*under/i, /total goals/i];

/** Tabs on the BetBoro fixture page, so a "Goals" market label cannot be mistaken for the tab. */
const TAB_CANDIDATES =
  '[role="tab"], [role="tablist"] *, [class*="tab" i], [data-testid*="tab" i], button, a';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tags the clickable element whose visible text matches `pattern` with `data-autobet="<tag>"`.
 * Only the deepest, visible match is tagged so a wrapping container cannot swallow the click.
 *
 * @returns {Promise<boolean>} whether something was tagged
 */
async function tagByText(
  page,
  tag,
  pattern,
  candidates = 'button, a, [role="tab"], [role="button"], li, label, span, div, p',
) {
  return page.evaluate(
    ({ tag, source, flags, candidates }) => {
      const re = new RegExp(source, flags);
      const textOf = (node) =>
        (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      const clickableOf = (node) =>
        node.closest('button, a, [role="tab"], [role="button"], li, label, [data-testid]') ?? node;
      const visible = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };

      document.querySelectorAll('[data-autobet]').forEach((node) => node.removeAttribute('data-autobet'));

      const matches = [...document.querySelectorAll(candidates)]
        .filter((node) => {
          const value = textOf(node);
          if (!value || value.length > 60 || !re.test(value)) return false;
          // Drop ancestors: a parent's innerText also contains the child's label.
          return ![...node.children].some((child) => re.test(textOf(child)));
        })
        .filter(visible);

      if (matches.length === 0) return false;

      clickableOf(matches[0]).setAttribute('data-autobet', tag);
      return true;
    },
    { tag, source: pattern.source, flags: pattern.flags, candidates },
  );
}

async function waitForTag(page, tag, patterns, timeoutMs = 25_000, candidates) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const pattern of patterns) {
      if (await tagByText(page, tag, pattern, candidates)) return true;
    }
    await sleep(400);
  }
  return false;
}

async function clickTag(page, tag) {
  const selector = `[data-autobet="${tag}"]`;
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, selector);
  await sleep(150);

  // Odds tiles are frequently <div>/<span> inside a clickable row, so fall back to a DOM click.
  const clicked = await page.click(selector).then(
    () => true,
    () => false,
  );
  if (!clicked) {
    await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
  }
}

/**
 * Tags the "Over 2.5" tile that belongs to the "TOTAL GOALS OVER/UNDER" market.
 *
 * BetBoro renders each price as `<div class="betting-info-main"><h6>Over 2.5</h6><h6>1.58</h6></div>`,
 * so the label is an `<h6>` and the tile div around it is the click target. Several markets repeat an
 * "Over 2.5" label, so the header is the anchor: walk up from it to the first ancestor that holds an
 * "Over 2.5" `<h6>`, then search only inside that wrapper.
 */
async function tagOver25InMarket(page) {
  return page.evaluate(() => {
    const textOf = (node) =>
      (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const HEADER_EXACT = /^total goals over\s*\/\s*under$/i;
    const HEADER_PARTIAL = /total goals over\s*\/\s*under/i;
    const OVER_25 = /^over\s*2[.,]5$/i;

    const headers = [...document.querySelectorAll('span, div, h2, h3, h4, h5, h6, p, button, li')].filter(
      visible,
    );

    const header =
      headers.find((node) => HEADER_EXACT.test(textOf(node))) ??
      headers.find((node) => {
        const value = textOf(node);
        return value.length <= 40 && HEADER_PARTIAL.test(value);
      });
    if (!header) return false;

    const over25Labels = (node) =>
      [...node.querySelectorAll('h6')].filter((el) => OVER_25.test(textOf(el)) && visible(el));

    let scope = header.parentElement;
    while (scope && scope !== document.body && over25Labels(scope).length === 0) {
      scope = scope.parentElement;
    }
    if (!scope || scope === document.body) return false;

    // First "Over 2.5" row inside the block: Over is listed before Under, so never take the last one.
    const label = over25Labels(scope)[0];
    const tile = label.closest('.betting-info-main') ?? label.parentElement;
    if (!tile) return false;

    tile.setAttribute('data-autobet', 'outcome');
    return true;
  });
}

/** The betslip is considered filled when it names the selection (or the tile reports itself selected). */
async function betslipHasSelection(page) {
  return page.evaluate(() => {
    const slipText = [
      ...document.querySelectorAll(
        '[class*="betslip" i], [class*="slip" i], [data-testid*="betslip" i], [data-testid*="slip" i]',
      ),
    ]
      .map((node) => node.innerText || '')
      .join('\n');
    if (/over\s*2[.,]5/i.test(slipText)) return true;

    const tile = document.querySelector('[data-autobet="outcome"]');
    return Boolean(tile && tile.getAttribute('aria-pressed') === 'true');
  });
}

/**
 * True when the page is showing a "Log in"/"Sign in" action, i.e. the persisted session is gone.
 */
async function needsLogin(page) {
  return page
    .evaluate(() => {
      const visible = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const text = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();

      return [...document.querySelectorAll('button, a, span, div, li')].some((node) => {
        const value = text(node);
        return value.length <= 20 && /^(log ?in|sign ?in|login)$/i.test(value) && visible(node);
      });
    })
    .catch(() => false);
}

/** Signed-in gate: no visible login action means the profile session is alive. */
async function verifyLoggedIn(page) {
  const loginVisible = await needsLogin(page).catch(() => true);
  return !loginVisible;
}

/** Clicks the header "Log in" action so the credentials form is on screen. */
async function openLoginForm(page) {
  const opened = await page
    .evaluate(() => {
      const visible = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const text = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();

      const action = [...document.querySelectorAll('button, a, span, div, li')].find((node) => {
        const value = text(node);
        return value.length <= 20 && /^(log ?in|sign ?in|login)$/i.test(value) && visible(node);
      });
      if (!action) return false;

      (action.closest('button, a') ?? action).click();
      return true;
    })
    .catch(() => false);

  if (opened) await sleep(2_500);
  return opened;
}

/** True while a visible password field is on screen. */
async function hasPasswordField(page) {
  return page
    .$$eval('input[type="password"]', (els) => {
      const visible = (node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      return els.some(visible);
    })
    .catch(() => false);
}

/**
 * Tags the login form's username field, password field and submit button, scoped to the form/modal
 * that owns the password input so the header's "Log in" link is never the submit target.
 *
 * @returns {Promise<boolean>} whether all three were tagged
 */
async function tagLoginForm(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const text = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const describe = (node) =>
      [
        node.getAttribute('placeholder'),
        node.getAttribute('aria-label'),
        node.getAttribute('name'),
        node.getAttribute('data-testid'),
        node.id,
        node.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!password) return false;

    const scope =
      password.closest(
        'form, [class*="login" i], [class*="modal" i], [class*="dialog" i], [class*="auth" i]',
      ) ?? document;

    const inputs = [...scope.querySelectorAll('input')].filter(
      (input) =>
        visible(input) &&
        !['hidden', 'password', 'checkbox', 'radio', 'submit', 'button'].includes(input.type),
    );
    const username =
      inputs.find((input) => /user|phone|mobile|account|email|login/.test(describe(input))) ?? inputs[0];
    if (!username) return false;

    const actions = [...scope.querySelectorAll('button, [role="button"], a, div, span')].filter(
      (node) => visible(node) && /^(log ?in|sign ?in|submit|continue)$/i.test(text(node)),
    );
    const submit = actions.find((node) => node.tagName === 'BUTTON') ?? actions[0];
    if (!submit) return false;

    document.querySelectorAll('[data-autobet]').forEach((node) => node.removeAttribute('data-autobet'));
    username.setAttribute('data-autobet', 'login-user');
    password.setAttribute('data-autobet', 'login-pass');
    (submit.closest('button, [role="button"]') ?? submit).setAttribute('data-autobet', 'login-submit');
    return true;
  });
}

/** Types the `.env` credentials into BetBoro's login form and submits it. */
async function autoLogin(page) {
  if (!HAS_CREDENTIALS) return false;

  console.log('[betboro-autobet] Signing in with BETBORO_USERNAME from .env …');

  // The header renders a moment after load: open the form, checking a few times, then give up.
  for (let attempt = 0; attempt < 3 && !(await hasPasswordField(page)); attempt += 1) {
    await openLoginForm(page);
    await sleep(1_500);
  }

  if (!(await tagLoginForm(page))) {
    if (await verifyLoggedIn(page)) {
      console.log('[betboro-autobet] Saved profile is already signed in — no login form needed.');
      return true;
    }
    console.warn('[betboro-autobet] Login form not found.');
    return false;
  }

  await page.click('[data-autobet="login-user"]', { clickCount: 3 }).catch(() => {});
  await page.keyboard.type(BETBORO_USERNAME, { delay: 40 });
  await page.click('[data-autobet="login-pass"]', { clickCount: 3 }).catch(() => {});
  await page.keyboard.type(BETBORO_PASSWORD, { delay: 40 });
  await clickTag(page, 'login-submit');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await verifyLoggedIn(page)) return true;
    await sleep(500);
  }

  console.warn('[betboro-autobet] Login did not complete — check the credentials.');
  return false;
}

/**
 * Login gate: saved profile first, then `.env` credentials, then abort (no waiting).
 * Puppeteer starts a new process each run; `userDataDir` only keeps the cookies.
 */
async function ensureLoggedIn(page, browser) {
  if (await verifyLoggedIn(page)) {
    console.log('[betboro-autobet] Signed in with the saved profile.');
    return;
  }

  if (!HAS_CREDENTIALS) {
    await saveScreenshot(browser, LOGIN_SHOT_PATH);
    throw new Error(
      'Not signed in and BETBORO_USERNAME/BETBORO_PASSWORD are missing — add them to .env and rerun.',
    );
  }

  if ((await autoLogin(page)) && (await verifyLoggedIn(page))) {
    console.log('[betboro-autobet] Signed in with .env credentials.');
    return;
  }

  await saveScreenshot(browser, LOGIN_SHOT_PATH);
  throw new Error('Login failed — check BETBORO_USERNAME/BETBORO_PASSWORD in .env and rerun.');
}

/**
 * Tags the stake `<input>` inside the betslip. Code/booking fields are excluded so a "Load Code"
 * box can never receive the stake.
 *
 * @returns {Promise<boolean>} whether a stake input was tagged
 */
async function tagStakeInput(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const describe = (node) =>
      [
        node.getAttribute('placeholder'),
        node.getAttribute('aria-label'),
        node.getAttribute('name'),
        node.getAttribute('data-testid'),
        node.id,
        node.className,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const slip = [...document.querySelectorAll(
      '[class*="betslip" i], [data-testid*="betslip" i], [class*="slip" i]',
    )].find(visible);

    const inputs = [
      ...(slip ? slip.querySelectorAll('input') : document.querySelectorAll('input')),
    ].filter((input) => {
      if (!visible(input) || input.type === 'hidden' || input.disabled || input.readOnly) return false;
      return !/code|load|booking|share|promo|search/.test(describe(input));
    });
    if (inputs.length === 0) return false;

    const score = (input) => {
      const text = describe(input);
      let value = 0;
      if (/stake/.test(text)) value += 5;
      if (/amount|wager/.test(text)) value += 3;
      if (input.type === 'number') value += 2;
      if (['decimal', 'numeric'].includes(input.inputMode)) value += 2;
      return value;
    };

    const [best] = inputs.map((input) => [score(input), input]).sort((a, b) => b[0] - a[0]);
    if (!best) return false;

    document.querySelectorAll('[data-autobet="stake"]').forEach((node) => node.removeAttribute('data-autobet'));
    best[1].setAttribute('data-autobet', 'stake');
    return true;
  });
}

/** Types the stake the way a user would, then falls back to a native setter + input event. */
async function enterStake(page, stake) {
  const selector = '[data-autobet="stake"]';
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), selector);
  await page.click(selector, { clickCount: 3 }).catch(() => {});
  await page.keyboard.type(String(stake), { delay: 60 });
  await sleep(500);

  const typed = await page.$eval(selector, (input) => input.value).catch(() => null);
  if (typed === String(stake)) return true;

  await page.evaluate(
    (sel, value) => {
      const input = document.querySelector(sel);
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    selector,
    String(stake),
  );
  await sleep(500);
  return (await page.$eval(selector, (input) => input.value).catch(() => null)) === String(stake);
}

async function dismissCookieBanner(page) {
  for (const pattern of [/^accept all$/i, /^accept$/i, /^accept cookies$/i, /^i agree$/i, /^got it$/i]) {
    if (await tagByText(page, 'cookie', pattern)) {
      await clickTag(page, 'cookie');
      await sleep(500);
      return true;
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      userDataDir: PROFILE_DIR,
      defaultViewport: null,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    });
  } catch (error) {
    // One Chrome instance per profile: an autobet window left open blocks the next run.
    console.error(`[betboro-autobet] Could not open profile ${PROFILE_DIR}: ${error.message}`);
    console.error('[betboro-autobet] Close any BetBoro autobet window still running, then retry.');
    process.exitCode = 1;
    return;
  }

  let success = false;

  try {
    const [page] = await browser.pages();
    page.setDefaultTimeout(45_000);
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60_000 });
    await sleep(2_000);

    await dismissCookieBanner(page);
    await ensureLoggedIn(page, browser);

    const tabFound = await waitForTag(page, 'tab', GOALS_TAB, 30_000, TAB_CANDIDATES);
    if (!tabFound) throw new Error('Goals (N) tab not found');

    await clickTag(page, 'tab');
    await sleep(1_500);

    const marketFound = await waitForTag(page, 'market', TOTAL_GOALS_MARKET, 20_000);
    if (!marketFound) {
      console.warn('[betboro-autobet] "Total Goals Over/Under" section not seen; still trying the outcome.');
    }

    let outcomeFound = false;
    const outcomeDeadline = Date.now() + 15_000;
    while (!outcomeFound && Date.now() < outcomeDeadline) {
      outcomeFound = await tagOver25InMarket(page);
      if (!outcomeFound) await sleep(400);
    }
    if (!outcomeFound) throw new Error('Over 2.5 outcome not found');

    await clickTag(page, 'outcome');
    console.log('[betboro-autobet] Clicked Over 2.5 in "Total Goals Over/Under".');

    const selectionDeadline = Date.now() + 20_000;
    while (!(await betslipHasSelection(page)) && Date.now() < selectionDeadline) {
      await sleep(500);
    }
    if (!(await betslipHasSelection(page))) throw new Error('Selection never appeared in the betslip');

    let stakeFound = false;
    const stakeDeadline = Date.now() + 20_000;
    while (!stakeFound && Date.now() < stakeDeadline) {
      stakeFound = await tagStakeInput(page);
      if (!stakeFound) await sleep(500);
    }
    if (!stakeFound) throw new Error('Stake input not found');

    if (!(await enterStake(page, STAKE))) {
      throw new Error(`Stake input found but value did not stick (wanted ${STAKE})`);
    }
    console.log(`[betboro-autobet] Entered stake ${STAKE}.`);

    success = true;
  } catch (error) {
    console.error(`[betboro-autobet] ${error.message}`);
  } finally {
    await saveScreenshot(browser);
    console.log(success ? 'Successfully added to betslip' : 'Failed to find button');
    if (!success) process.exitCode = 1;
    if (CLOSE_WHEN_DONE) await browser.close();
    else console.log('[betboro-autobet] Browser left open — close it or rerun with --close.');
  }
}

async function saveScreenshot(browser, target = SHOT_PATH) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const pages = await browser.pages();
  const page = pages[pages.length - 1];
  if (!page) return;
  try {
    await page.bringToFront();
    await page.screenshot({ path: target, fullPage: false });
    console.log(`[betboro-autobet] Screenshot saved to ${target}`);
  } catch (error) {
    console.error(`[betboro-autobet] Screenshot failed: ${error.message}`);
  }
}

main().catch((error) => {
  console.error('[betboro-autobet] Fatal:', error);
  process.exitCode = 1;
});
