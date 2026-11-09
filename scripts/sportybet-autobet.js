/**
 * Experimental SportyBet autobet probe (V2).
 *
 * The deep link does the market selection (`?marketId=…&outcomeId=…`), so the script never clicks a
 * tab: it waits for the betslip panel on the right, types a stake into it and stops. It never
 * touches "Place Bet".
 *
 * Usage: node scripts/sportybet-autobet.js [url] [--stake=10] [--close]
 *
 * The Chrome profile lives in `data/sportybet-profile`. Puppeteer still starts a new process each run
 * — the folder only preserves cookies/localStorage — so each run reuses that session when it is
 * still valid, otherwise signs in with `SPORTYBET_USERNAME` / `SPORTYBET_PASSWORD` (.env today,
 * Cloudflare secrets later). If neither works it aborts instead of waiting.
 *
 * Requires puppeteer: npm i -D puppeteer
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

/** Total Goals Over/Under (market 18), Over 2.5 (outcome 12) pre-selected by the deep link. */
const DEFAULT_URL =
  'https://www.sportybet.com/gh/sport/football/International_Clubs/UEFA_Champions_League/Arsenal_vs_Borussia_Dortmund/sr:match:74166018?marketId=18&outcomeId=12';
const SHOT_PATH = path.join('data', 'sportybet-debug.png');
const LOGIN_SHOT_PATH = path.join('data', 'sportybet-login.png');
/** Persistent Chrome profile: cookies + localStorage survive between runs, so the login sticks. */
const PROFILE_DIR = path.join('data', 'sportybet-profile');

const args = process.argv.slice(2);
const FIXTURE_URL = args.find((arg) => /^https?:\/\//i.test(arg)) ?? DEFAULT_URL;
const STAKE = (args.find((arg) => arg.startsWith('--stake=')) ?? '--stake=10').split('=')[1];
const CLOSE_WHEN_DONE = args.includes('--close');

/** Local credentials (`.env` today, Cloudflare secrets once this runs as a Worker). */
const SPORTYBET_USERNAME = (process.env.SPORTYBET_USERNAME ?? '').trim();
const SPORTYBET_PASSWORD = process.env.SPORTYBET_PASSWORD ?? '';
const HAS_CREDENTIALS = Boolean(SPORTYBET_USERNAME && SPORTYBET_PASSWORD);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tags the "Over 2.5" cell of SportyBet's Over/Under market.
 *
 * Markets render as `div.m-table__wrapper` blocks whose header is a
 * `span.m-table-header-title` ("Over/Under"), and each price lives in a
 * `div.m-table-cell > span.m-table-cell-item`. Scoping to the wrapper that owns the Over/Under
 * header is what keeps the many other "Over 2.5" labels (1X2, 1UP, 2UP, Never Down, …) out of reach.
 *
 * @returns {Promise<boolean>} whether the cell was tagged
 */
async function tagOver25Cell(page) {
  return page.evaluate(() => {
    const text = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    const headerTitle = (wrapper) =>
      [...wrapper.querySelectorAll('span.m-table-header-title')].map(text);
    const isOverUnderMarket = (wrapper) =>
      headerTitle(wrapper).some(
        (title) => /^over\s*\/\s*under$/i.test(title) || (title.length <= 40 && /over\s*\/\s*under/i.test(title)),
      );

    for (const wrapper of document.querySelectorAll('div.m-table__wrapper')) {
      if (!isOverUnderMarket(wrapper)) continue;

      const item = [...wrapper.querySelectorAll('span.m-table-cell-item')].find((span) =>
        /^over\s*2[.,]5$/i.test(text(span)),
      );
      const cell = item?.closest('div.m-table-cell');
      if (!cell) continue;

      document.querySelectorAll('[data-autobet]').forEach((node) => node.removeAttribute('data-autobet'));
      cell.setAttribute('data-autobet', 'outcome');
      return true;
    }
    return false;
  });
}

/**
 * True when the page is showing a "Login"/"Sign in" action, i.e. the persisted session is gone.
 * Once signed in, SportyBet replaces it with the account/balance chip.
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
        return value.length <= 20 && /^(log ?in|sign ?in)$/i.test(value) && visible(node);
      });
    })
    .catch(() => false);
}

/**
 * Hard gate used before any betting step: a signed-in session shows no "Login"/"Sign in" action.
 * Balance/account markup is rendered lazily by some skins, so it is not required here.
 */
async function verifyLoggedIn(page) {
  const loginVisible = await needsLogin(page).catch(() => true);
  return !loginVisible;
}

/** Clicks the header "Login" action so the credentials form is on screen. */
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
        return value.length <= 20 && /^(log ?in|sign ?in)$/i.test(value) && visible(node);
      });
      if (!action) return false;

      (action.closest('button, a') ?? action).click();
      return true;
    })
    .catch(() => false);

  if (opened) await sleep(2_500);
  return opened;
}

/**
 * Tags the login form's username field, password field and submit button. Scoped to the form/modal
 * that owns the password input so the header's "Login" link is never treated as the submit button.
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
      inputs.find((input) => /phone|user|mobile|account|email|login/.test(describe(input))) ?? inputs[0];
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

/** Types the `.env` credentials into SportyBet's login form and submits it. */
async function autoLogin(page) {
  if (!HAS_CREDENTIALS) return false;

  console.log('[sportybet-autobet] Signing in with SPORTYBET_USERNAME from .env …');

  // The header renders a moment after load: open the form, checking a few times, then give up.
  for (let attempt = 0; attempt < 3 && !(await hasPasswordField(page)); attempt += 1) {
    await openLoginForm(page);
    await sleep(1_500);
  }

  if (!(await tagLoginForm(page))) {
    if (await verifyLoggedIn(page)) {
      console.log('[sportybet-autobet] Saved profile is already signed in — no login form needed.');
      return true;
    }
    console.warn('[sportybet-autobet] Login form not found.');
    return false;
  }

  await page.click('[data-autobet="login-user"]', { clickCount: 3 }).catch(() => {});
  await page.keyboard.type(SPORTYBET_USERNAME, { delay: 40 });
  await page.click('[data-autobet="login-pass"]', { clickCount: 3 }).catch(() => {});
  await page.keyboard.type(SPORTYBET_PASSWORD, { delay: 40 });
  await clickTag(page, 'login-submit');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await needsLogin(page))) return true;
    await sleep(500);
  }

  console.warn('[sportybet-autobet] Login did not complete — check the credentials.');
  return false;
}

/**
 * Login gate. Puppeteer starts a fresh process each run; `userDataDir` only keeps the cookies, so:
 *
 *   1. saved profile already signed in → use it;
 *   2. otherwise sign in with `SPORTYBET_USERNAME` / `SPORTYBET_PASSWORD` and confirm it stuck;
 *   3. otherwise abort — no waiting, no betting while signed out.
 */
async function ensureLoggedIn(page, browser) {
  if (await verifyLoggedIn(page)) {
    console.log('[sportybet-autobet] Signed in with the saved profile.');
    return;
  }

  if (!HAS_CREDENTIALS) {
    await saveScreenshot(browser, LOGIN_SHOT_PATH);
    throw new Error(
      'Not signed in and SPORTYBET_USERNAME/SPORTYBET_PASSWORD are missing — add them to .env and rerun.',
    );
  }

  if ((await autoLogin(page)) && (await verifyLoggedIn(page))) {
    console.log('[sportybet-autobet] Logged in with .env credentials and verified.');
    return;
  }

  await saveScreenshot(browser, LOGIN_SHOT_PATH);
  throw new Error('Login failed — check SPORTYBET_USERNAME/SPORTYBET_PASSWORD in .env and rerun.');
}

/** Clicks the element tagged with `data-autobet="<tag>"`, falling back to a DOM click. */
async function clickTag(page, tag) {
  const selector = `[data-autobet="${tag}"]`;
  await page.evaluate((sel) => {
    document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, selector);
  await sleep(150);

  const clicked = await page.click(selector).then(
    () => true,
    () => false,
  );
  if (!clicked) {
    await page.evaluate((sel) => document.querySelector(sel)?.click(), selector);
  }
}

/**
 * Tags the betslip panel — the right-hand container that holds the pre-selected selection and the
 * stake field. Every later lookup happens inside this element so page-level "Over 2.5" duplicates
 * cannot interfere.
 *
 * @returns {Promise<boolean>} whether a betslip with an input inside was tagged
 */
async function tagBetslip(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const area = (node) => {
      const box = node.getBoundingClientRect();
      return box.width * box.height;
    };

    const slips = [
      ...document.querySelectorAll('[class*="betslip" i], [data-testid*="betslip" i], [class*="slip" i]'),
    ]
      .filter((node) => visible(node) && node.querySelector('input'));

    if (slips.length === 0) return false;

    // The largest match is the panel itself; the others are badges/counters.
    const slip = slips.sort((a, b) => area(b) - area(a))[0];

    document.querySelectorAll('[data-autobet]').forEach((node) => node.removeAttribute('data-autobet'));
    slip.setAttribute('data-autobet', 'betslip');
    return true;
  });
}

/**
 * Tags the stake `<input>` inside the tagged betslip.
 *
 * An empty SportyBet betslip only shows the "Load Code" field, so code/booking inputs are excluded
 * before scoring — otherwise the stake would be typed into the wrong box.
 *
 * @returns {Promise<boolean>} whether a stake input was tagged
 */
async function tagStakeInput(page) {
  return page.evaluate(() => {
    const slip = document.querySelector('[data-autobet="betslip"]');
    if (!slip) return false;

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

    const inputs = [...slip.querySelectorAll('input')].filter((input) => {
      if (!visible(input) || input.type === 'hidden' || input.disabled || input.readOnly) return false;
      // "Load Code" / booking-code fields are never the stake.
      if (/code|load|booking|share|promo/.test(describe(input))) return false;
      return true;
    });
    if (inputs.length === 0) return false;

    const score = (input) => {
      const text = describe(input);
      let value = 0;
      if (/stake/.test(text)) value += 5;
      if (/amount|wager|bet-?amount/.test(text)) value += 3;
      if (input.type === 'number') value += 2;
      if (['decimal', 'numeric'].includes(input.inputMode)) value += 2;
      return value;
    };

    document.querySelectorAll('[data-autobet="stake"]').forEach((node) => node.removeAttribute('data-autobet'));

    const [best] = inputs.map((input) => [score(input), input]).sort((a, b) => b[0] - a[0]);
    if (!best) return false;

    best[1].setAttribute('data-autobet', 'stake');
    return true;
  });
}

/** Short text extract of the betslip, so the log shows what the deep link actually selected. */
async function betslipSummary(page) {
  return page
    .$eval('[data-autobet="betslip"]', (slip) =>
      (slip.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    )
    .catch(() => '');
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

async function saveScreenshot(browser, target = SHOT_PATH) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const pages = await browser.pages();
  const page = pages[pages.length - 1];
  if (!page) return;
  try {
    await page.bringToFront();
    await page.screenshot({ path: target, fullPage: false });
    console.log(`[sportybet-autobet] Screenshot saved to ${target}`);
  } catch (error) {
    console.error(`[sportybet-autobet] Screenshot failed: ${error.message}`);
  }
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
    console.error(`[sportybet-autobet] Could not open profile ${PROFILE_DIR}: ${error.message}`);
    console.error('[sportybet-autobet] Close any SportyBet autobet window still running, then retry.');
    process.exitCode = 1;
    return;
  }

  let success = false;

  try {
    const [page] = await browser.pages();
    page.setDefaultTimeout(45_000);
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60_000 });
    await sleep(3_000);

    console.log(`[sportybet-autobet] Opened ${page.url()}`);
    console.log(
      /[?&]marketId=/.test(page.url())
        ? '[sportybet-autobet] URL carries marketId/outcomeId — market should already be scrolled into view.'
        : '[sportybet-autobet] No marketId in the URL; using the default "All" market list.',
    );

    await ensureLoggedIn(page, browser);

    // The page ships every market; the Over/Under wrapper is found directly, no tab clicks.
    const cellDeadline = Date.now() + 25_000;
    let cellFound = false;
    while (!cellFound && Date.now() < cellDeadline) {
      cellFound = await tagOver25Cell(page);
      if (!cellFound) await sleep(500);
    }
    if (!cellFound) throw new Error('Over/Under "Over 2.5" cell not found');

    await clickTag(page, 'outcome');
    console.log('[sportybet-autobet] Clicked Over 2.5 in the Over/Under market.');
    await sleep(1_500);

    // The click fills the betslip; from here only the betslip panel is touched.
    await page
      .waitForSelector('[class*="betslip" i], [data-testid*="betslip" i], [class*="slip" i]', {
        timeout: 15_000,
      })
      .catch(() => {});

    const slipDeadline = Date.now() + 30_000;
    let slipFound = false;
    while (!slipFound && Date.now() < slipDeadline) {
      slipFound = await tagBetslip(page);
      if (!slipFound) await sleep(500);
    }
    if (!slipFound) throw new Error('Betslip not found');

    // An empty betslip still exists (with a "Load Code" field), so wait for the selection itself
    // before touching any input.
    await page
      .waitForFunction(
        () => {
          const slip = document.querySelector('[data-autobet="betslip"]');
          return Boolean(slip && /over\s*2[.,]5/i.test(slip.innerText || ''));
        },
        { timeout: 15_000 },
      )
      .catch(() => {});

    let selectionShown = false;
    const selectionDeadline = Date.now() + 15_000;
    while (!selectionShown && Date.now() < selectionDeadline) {
      selectionShown = await page
        .$eval('[data-autobet="betslip"]', (slip) => /over\s*2[.,]5/i.test(slip.innerText || ''))
        .catch(() => false);
      if (!selectionShown) {
        await sleep(500);
        await tagBetslip(page); // the panel can re-render and drop the tag
      }
    }
    if (!selectionShown) throw new Error('Over 2.5 never appeared in the betslip');

    console.log(`[sportybet-autobet] Betslip: ${(await betslipSummary(page)) || '(empty)'}`);

    const stakeDeadline = Date.now() + 20_000;
    let stakeFound = false;
    while (!stakeFound && Date.now() < stakeDeadline) {
      stakeFound = await tagStakeInput(page);
      if (!stakeFound) await sleep(500);
    }
    if (!stakeFound) throw new Error('Stake input not found');

    success = await enterStake(page, STAKE);
    if (!success) throw new Error(`Stake input found but value did not stick (wanted ${STAKE})`);
  } catch (error) {
    console.error(`[sportybet-autobet] ${error.message}`);
  } finally {
    if (success) console.log(`Successfully entered stake ${STAKE}`);
    else {
      console.log('Failed to find stake input');
      await saveScreenshot(browser);
    }
    if (CLOSE_WHEN_DONE) await browser.close();
    else console.log('[sportybet-autobet] Browser left open — close it or rerun with --close.');
  }
}

main().catch((error) => {
  console.error('[sportybet-autobet] Fatal:', error);
  process.exitCode = 1;
});
