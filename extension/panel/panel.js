/**
 * Side panel UI.
 *
 * Shows the live arb feed (same KV payload the dashboard reads), previews the exact stakes that
 * will be typed, and starts a job over the extension message bus. Job state arrives as pushed
 * `AUTOBET_JOB` messages, so the panel never has to poll the worker.
 */
import { allocateStakes, DEFAULT_SETTINGS } from '../shared/stakes.js';
import { fetchFeed } from '../shared/feed.js';

const SUPPORTED = new Set(['SportyBet', 'BetBoro']);
const $ = (id) => document.getElementById(id);

const ui = {
  feedDot: $('feedDot'),
  refreshBtn: $('refreshBtn'),
  themeBtn: $('themeBtn'),
  settingsBtn: $('settingsBtn'),
  tabAutobet: $('tabAutobet'),
  tabBuilder: $('tabBuilder'),
  viewAutobet: $('viewAutobet'),
  viewBuilder: $('viewBuilder'),
  smartAccaPanel: $('smartAccaPanel'),
  smartAccaRefreshBtn: $('smartAccaRefreshBtn'),
  smartAccaStake: $('smartAccaStake'),
  smartAccaMode: $('smartAccaMode'),
  smartAccaStatus: $('smartAccaStatus'),
  smartAccaResult: $('smartAccaResult'),
  smartAccaOdds: $('smartAccaOdds'),
  smartAccaWin: $('smartAccaWin'),
  smartAccaAddBtn: $('smartAccaAddBtn'),
  smartAccaBetboroBtn: $('smartAccaBetboroBtn'),
  builderProgress: $('builderProgress'),
  setup: $('setup'),
  apiBaseInput: $('apiBaseInput'),
  useTabBtn: $('useTabBtn'),
  saveBaseBtn: $('saveBaseBtn'),
  jobCard: $('jobCard'),
  jobTitle: $('jobTitle'),
  jobMeta: $('jobMeta'),
  jobLegs: $('jobLegs'),
  jobActions: $('jobActions'),
  cancelBtn: $('cancelBtn'),
  retryBtn: $('retryBtn'),
  dismissBtn: $('dismissBtn'),
  builderDrop: $('builderDrop'),
  builderFile: $('builderFile'),
  builderStatus: $('builderStatus'),
  builderResult: $('builderResult'),
  pickImageBtn: $('pickImageBtn'),
  settings: $('settings'),
  stakeInput: $('stakeInput'),
  stepInput: $('stepInput'),
  tolInput: $('tolInput'),
  refreshInput: $('refreshInput'),
  apiBaseEdit: $('apiBaseEdit'),
  saveSettingsBtn: $('saveSettingsBtn'),
  feedMeta: $('feedMeta'),
  arbCount: $('arbCount'),
  arbList: $('arbList'),
  statusLine: $('statusLine'),
  extVersion: $('extVersion'),
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  feed: null,
  feedError: null,
  feedAt: null,
  job: null,
  starting: false,
  refreshing: false,
  aborter: null,
  builder: null,
  builderBusy: false,
  smartAcca: null,
  smartAccaBusy: false,
  smartAccaLogged: false,
  smartAccaExhausted: false,
  tab: 'autobet',
};

function node(tag, props = {}, children = []) {
  const element = document.createElement(tag);
  Object.entries(props).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else element.setAttribute(key, String(value));
  });
  [].concat(children).forEach((child) => {
    if (child === null || child === undefined || child === false) return;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return element;
}

const say = (text) => {
  ui.statusLine.textContent = text;
};

// ---------------------------------------------------------------- theme

const THEME_KEY = 'theme';

/** Dark is the default; the choice is stored so the panel opens in the same theme. */
function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  if (ui.themeBtn) {
    ui.themeBtn.textContent = light ? '☾' : '☀';
    const label = light ? 'Switch to dark mode' : 'Switch to light mode';
    ui.themeBtn.title = label;
    ui.themeBtn.setAttribute('aria-label', label);
  }
}

ui.themeBtn?.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  chrome.storage.local.set({ [THEME_KEY]: next }).catch(() => {});
});

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const stored = await chrome.storage.local.get({ ...DEFAULT_SETTINGS, smartAccaMode: 'real' });
  state.settings = { ...DEFAULT_SETTINGS, ...stored };
  ui.stakeInput.value = state.settings.totalStake;
  ui.stepInput.value = String(state.settings.roundStep);
  ui.tolInput.value = state.settings.oddsTolerancePct;
  ui.refreshInput.value = state.settings.autoRefreshSec;
  ui.apiBaseEdit.value = state.settings.apiBase;
  ui.apiBaseInput.value = state.settings.apiBase;
  ui.smartAccaMode.value = state.settings.smartAccaMode === 'simulation' ? 'simulation' : 'real';
  ui.setup.hidden = Boolean(state.settings.apiBase);
}

function normaliseBase(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    throw new Error('That does not look like a URL.');
  }
}

async function saveBase(raw) {
  const apiBase = normaliseBase(raw);
  if (!apiBase) throw new Error('Enter the dashboard URL first.');

  try {
    await chrome.permissions.request({ origins: [`${apiBase}/*`] });
  } catch {
    /* already granted, or a chrome:// page â€” the fetch below reports the real problem */
  }

  await chrome.storage.local.set({ apiBase });
  state.settings.apiBase = apiBase;
  ui.setup.hidden = true;
  ui.apiBaseEdit.value = apiBase;
  ui.apiBaseInput.value = apiBase;
  await refreshFeed();
}

// ---------------------------------------------------------------- feed

/**
 * A degraded payload must not wait for the normal poll (15 s minimum, 60 s default), but a
 * persistent outage must not turn into a 10 s hammer either. Escalate once per failure.
 */
const FEED_RETRY_STEPS_MS = [10_000, 30_000, 60_000];
let feedRetryTimer = null;
let feedRetryStep = 0;

function scheduleFeedRetry() {
  if (feedRetryTimer) clearTimeout(feedRetryTimer);
  const wait = FEED_RETRY_STEPS_MS[Math.min(feedRetryStep, FEED_RETRY_STEPS_MS.length - 1)];
  feedRetryStep += 1;
  feedRetryTimer = setTimeout(() => {
    feedRetryTimer = null;
    if (document.visibilityState === 'visible') refreshFeed();
  }, wait);
}

function clearFeedRetry() {
  feedRetryStep = 0;
  if (!feedRetryTimer) return;
  clearTimeout(feedRetryTimer);
  feedRetryTimer = null;
}

/** Applies a feed payload to the panel: dot, meta line and the arb list. */
function applyFeed(feed) {
  state.feed = feed;
  state.feedError = null;
  state.feedAt = new Date();

  const generatedAt = feed.generatedAt ? Date.parse(feed.generatedAt) : NaN;
  const stale = Number.isFinite(generatedAt) && Date.now() - generatedAt > 25 * 60_000;
  const offline = feed.source === 'static';
  const degraded = stale || offline;

  ui.feedDot.className = `dot ${degraded ? 'stale' : 'live'}`;
  const stamp = Number.isFinite(generatedAt)
    ? new Date(generatedAt).toLocaleTimeString()
    : 'just now';
  renderFeedMeta(`${offline ? 'Offline snapshot' : 'Feed'} ${stamp}${stale ? ' Â· stale' : ''}`);

  if (degraded) scheduleFeedRetry();
  else clearFeedRetry();

  renderArbs();
}

async function refreshFeed() {
  if (!state.settings.apiBase) {
    state.feedError = 'No dashboard URL configured.';
    renderFeedMeta('Not connected');
    renderArbs();
    return;
  }

  state.aborter?.abort();
  state.aborter = new AbortController();

  try {
    const feed = await fetchFeed(state.settings.apiBase, state.aborter.signal);
    applyFeed(feed);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    state.feedError = String(error?.message || error);
    ui.feedDot.className = 'dot off';
    renderFeedMeta(state.feedError);
    renderArbs();
    console.warn('[oddtor] feed fetch failed:', error?.message || error);
    scheduleFeedRetry();
  }
}

/**
 * The Refresh button: asks the service worker for a fresh feed (it holds the host permission and
 * survives the panel being idle), falling back to a direct fetch if the worker is unreachable.
 */
async function refreshNow() {
  if (state.refreshing) return;
  state.refreshing = true;

  const label = ui.refreshBtn.textContent;
  ui.refreshBtn.disabled = true;
  ui.refreshBtn.textContent = 'Refreshingâ€¦';
  ui.feedDot.className = 'dot stale';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'AUTOBET_REFRESH' });
    if (response?.ok && response.feed) {
      applyFeed(response.feed);
      say(`Feed refreshed Â· ${activeArbs().length} arb(s).`);
    } else {
      await refreshFeed();
      say(response?.error ? `Worker: ${response.error} â€” fetched directly.` : 'Feed refreshed.');
    }
  } catch (error) {
    await refreshFeed();
    say(`Feed refreshed (${String(error?.message || error)}).`);
  } finally {
    state.refreshing = false;
    ui.refreshBtn.disabled = false;
    ui.refreshBtn.textContent = label;
  }
}

function renderFeedMeta(text) {
  ui.feedMeta.textContent = text;
}

function activeArbs() {
  const arbs = Array.isArray(state.feed?.arbs) ? state.feed.arbs : [];
  const cutoff = Date.now() - 20 * 60_000;
  return arbs
    .filter((arb) => (Number(arb.kickoff) || 0) > cutoff)
    .sort((a, b) => (Number(b.profitPct) || 0) - (Number(a.profitPct) || 0));
}

function countdown(kickoff) {
  if (!kickoff) return '';
  const minutes = Math.round((kickoff - Date.now()) / 60_000);
  if (minutes <= 0) return 'in play';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * Profit range for the exact stakes that will be typed: the smallest and largest (stake x odds)
 * across the legs, minus the total outlay. Rounding leaves the legs slightly imbalanced, so the
 * worst case can sit below total x profitPct â€” that gap is real money.
 *
 * @returns {{worst: number, best: number}|null} null when a leg has no usable stake or price.
 */
function profitRange(legs, stakes) {
  if (!legs.length) return null;
  const total = stakes.reduce((sum, value) => sum + (Number(value) || 0), 0);
  if (!(total > 0)) return null;

  const returns = legs.map((leg, index) => Number(stakes[index]) * (Number(leg.odds) || 0));
  // A leg without a usable stake or price makes the range unknowable, not zero.
  if (returns.some((value) => !(value > 0))) return null;
  // Cents precision: float noise must not turn a break-even into a red "GHS -0.00".
  const cents = (value) => Math.round(value * 100) / 100;
  return {
    worst: cents(Math.min(...returns) - total),
    best: cents(Math.max(...returns) - total),
  };
}

function renderArbs() {
  const arbs = activeArbs();
  ui.arbCount.textContent = `${arbs.length} arb${arbs.length === 1 ? '' : 's'}`;
  ui.arbList.replaceChildren();

  if (!arbs.length) {
    ui.arbList.append(
      node('div', {
        class: 'empty',
        text: state.settings.apiBase
          ? 'No active arbs in the feed right now.'
          : 'Connect your dashboard to load arbs.',
      }),
    );
    return;
  }

  const running = state.job?.status === 'running' || state.starting;

  arbs.forEach((arb) => {
    const legs = Array.isArray(arb.legs) ? arb.legs : [];
    const stakes = allocateStakes(legs, state.settings.totalStake, state.settings.roundStep);
    const fillable = legs.filter(
      (leg) => SUPPORTED.has(leg.bookmaker) && /^https?:\/\//i.test(String(leg.url || '')),
    );
    const profit = Number(arb.profitPct) || 0;
    const range = profitRange(legs, stakes);

    const legItems = legs.map((leg, index) =>
      node(
        'li',
        {
          class: `arb-leg${SUPPORTED.has(leg.bookmaker) ? '' : ' unsupported'}`,
          title: SUPPORTED.has(leg.bookmaker) ? leg.url ?? '' : 'Not auto-filled â€” open manually',
        },
        [
          node('span', { class: 'book', text: leg.bookmaker }),
          node('span', { text: leg.outcome }),
          node('span', { class: 'odds', text: Number(leg.odds).toFixed(2) }),
          node('span', {
            class: 'stake',
            dataset: { stake: String(index) },
            text: `GHS ${Number(stakes[index] || 0).toFixed(2)}`,
          }),
        ],
      ),
    );

    const runButton = node('button', {
      class: 'run',
      text: fillable.length >= 2 ? 'Run Autobet' : 'Not fillable',
      disabled: running || fillable.length < 2,
      onclick: () => startJob(arb, runButton),
    });

    ui.arbList.append(
      node('article', { class: 'card arb' }, [
        node('div', { class: 'arb-top' }, [
          node('span', { class: `arb-profit${profit < 2 ? ' low' : ''}`, text: `${profit.toFixed(2)}%` }),
          node('span', { class: 'arb-time', text: countdown(arb.kickoff) }),
        ]),
        node('div', { class: 'arb-teams', text: `${arb.home} vs ${arb.away}` }),
        node('div', {
          class: 'arb-market',
          text: [arb.market, arb.tournament].filter(Boolean).join(' Â· '),
        }),
        node('ul', { class: 'arb-legs' }, legItems),
        node('div', { class: 'arb-run' }, [
          range == null
            ? null
            : node('div', {
                class: `arb-worst${range.worst < 0 ? ' negative' : ''}`,
                text: `Profit: GHS ${range.worst.toFixed(2)} (Max: GHS ${range.best.toFixed(2)})`,
              }),
          runButton,
        ]),
      ]),
    );
  });
}

/** Re-labels countdowns and stake previews without rebuilding the list. */
function refreshLabels() {
  const arbs = activeArbs();
  const cards = ui.arbList.querySelectorAll('.arb');
  arbs.forEach((arb, index) => {
    const card = cards[index];
    if (!card) return;
    const time = card.querySelector('.arb-time');
    if (time) time.textContent = countdown(arb.kickoff);
  });
}

// ---------------------------------------------------------------- job

async function startJob(arb, button) {
  state.starting = true;
  if (button) {
    button.disabled = true;
    button.textContent = 'Startingâ€¦';
  }
  say('Opening both bookmakersâ€¦');

  try {
    // Send the exact stakes the card is showing, so the worker never re-derives them.
    const stakes = allocateStakes(arb.legs ?? [], state.settings.totalStake, state.settings.roundStep);
    const legs = (arb.legs ?? []).map((leg, index) => ({ ...leg, stake: stakes[index] }));

    const response = await chrome.runtime.sendMessage({
      type: 'AUTOBET_START',
      arb: { ...arb, legs },
      totalStake: Number(state.settings.totalStake),
      roundStep: Number(state.settings.roundStep),
    });
    if (!response?.ok) throw new Error(response?.error || 'The extension did not accept the job.');
    state.job = response.job;
    renderJob();
  } catch (error) {
    say(String(error?.message || error));
  } finally {
    state.starting = false;
    renderArbs();
  }
}

const STATUS_LABEL = {
  pending: 'queued',
  opening: 'opening tab',
  loading: 'loading page',
  filling: 'filling',
  filled: 'filled',
  failed: 'failed',
  aborted: 'odds moved',
  unsupported: 'manual only',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
};

const LAYOUT_LABEL = { split: 'split view', windows: 'side-by-side windows', none: '' };

function renderJob() {
  const job = state.job;
  ui.jobCard.hidden = !job;
  if (!job) return;

  const running = job.status === 'running';
  const unfilled = job.legs.filter((leg) => leg.status !== 'filled');

  ui.jobTitle.replaceChildren(
    node('span', { text: `${job.home} vs ${job.away} ` }),
    node('span', {
      class: 'profit',
      text: `${(Number(job.profitPct) || 0).toFixed(2)}%`,
    }),
  );
  ui.jobMeta.textContent = [
    job.market,
    `GHS ${Number(job.totalStake).toFixed(0)} total`,
    running ? 'running' : job.status,
    LAYOUT_LABEL[job.layout] ?? '',
    job.error ? job.error : '',
  ]
    .filter(Boolean)
    .join(' Â· ');

  ui.jobLegs.replaceChildren(
    ...job.legs.map((leg) =>
      node('li', { class: 'leg', dataset: { status: leg.status } }, [
        node('div', { class: 'leg-top' }, [
          node('span', {
            class: 'leg-book',
            text: `${leg.bookmaker} Â· ${leg.outcome}`,
          }),
          node('span', {
            class: 'leg-status',
            text: STATUS_LABEL[leg.status] ?? leg.status,
          }),
        ]),
        node('div', { class: 'muted' }, [
          node('span', { text: `${Number(leg.expectedOdds).toFixed(2)}` }),
          leg.observedOdds
            ? node('span', { text: ` â†’ ${Number(leg.observedOdds).toFixed(2)}` })
            : null,
          node('span', { text: ` Â· GHS ${Number(leg.stake).toFixed(2)}` }),
        ]),
        leg.message ? node('div', { class: 'leg-msg', text: leg.message }) : null,
        leg.tabId
          ? node('div', { class: 'leg-actions' }, [
              node('button', {
                class: 'ghost',
                text: 'Show tab',
                onclick: () => chrome.runtime.sendMessage({ type: 'AUTOBET_FOCUS', legId: leg.id }),
              }),
            ])
          : null,
      ]),
    ),
  );

  ui.cancelBtn.hidden = !running;
  // Retry/Dismiss stay reachable once a job stops, so a stuck or finished job can always be cleared.
  ui.jobActions.hidden = running;
  ui.retryBtn.hidden = unfilled.length === 0;
}

async function retryFailed() {
  say('Retrying unfilled legsâ€¦');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOBET_RETRY',
      totalStake: Number(state.settings.totalStake),
    });
    if (!response?.ok) throw new Error(response?.error || 'Retry refused.');
    state.job = response.job;
    renderJob();
  } catch (error) {
    say(String(error?.message || error));
  }
}

// ---------------------------------------------------------------- tabs

function setTab(name) {
  const builder = name === 'builder';
  state.tab = builder ? 'builder' : 'autobet';
  ui.tabAutobet.classList.toggle('active', !builder);
  ui.tabBuilder.classList.toggle('active', builder);
  ui.tabAutobet.setAttribute('aria-selected', String(!builder));
  ui.tabBuilder.setAttribute('aria-selected', String(builder));
  ui.viewAutobet.hidden = builder;
  ui.viewBuilder.hidden = !builder;
  chrome.storage.session.set({ panelTab: state.tab }).catch(() => {});
}

ui.tabAutobet.addEventListener('click', () => setTab('autobet'));
ui.tabBuilder.addEventListener('click', () => setTab('builder'));

// ---------------------------------------------------------------- bet builder

/** Longest edge after downscaling; matches the web client's limits. */
const BUILDER_MAX_EDGE = 1600;
const BUILDER_JPEG_QUALITY = 0.85;
const BUILDER_SKIP_BYTES = 400 * 1024;
const BUILDER_MAX_BYTES = 8 * 1024 * 1024;

const UNRESOLVED_LABEL = {
  'missing-teams': 'No teams printed',
  'no-candidates': 'No fixture in the feed',
  'low-confidence': 'Weak name match',
  ambiguous: 'Several fixtures fit',
};

function builderSay(text, tone = '') {
  ui.builderStatus.hidden = !text;
  ui.builderStatus.textContent = text || '';
  if (text) ui.builderStatus.dataset.tone = tone;
  else delete ui.builderStatus.dataset.tone;
}

/**
 * Indeterminate bar plus elapsed seconds: the scan is one POST whose length the panel cannot
 * predict, so a real percentage would be a lie. The clock alone is what tells a user it is
 * still working.
 */
function startBuilderProgress(label) {
  const startedAt = Date.now();
  ui.builderProgress.hidden = false;
  builderSay(`${label} 0s`);

  const id = setInterval(() => {
    builderSay(`${label} ${Math.round((Date.now() - startedAt) / 1000)}s`);
  }, 1000);

  return () => {
    clearInterval(id);
    ui.builderProgress.hidden = true;
  };
}

function mimeFromName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return (
    { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[
      ext
    ] || ''
  );
}

function imageNameFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/\.(png|jpe?g|webp|gif)$/i.test(name)) return name;
  } catch {
    /* fall through to the generic name */
  }
  return 'betslip.jpg';
}

/** X serves scaled copies by default; `name=orig` is the image the tipster uploaded. */
function originalImageUrl(raw) {
  let value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('//')) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return '';
    if (/(^|\.)pbs\.twimg\.com$/.test(url.hostname) && url.searchParams.has('name')) {
      url.searchParams.set('name', 'orig');
    }
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * Reads an image URL out of a drop that came from a page (not the OS).
 * Drag from an image element carries `text/html` (`<img src=â€¦>`) and `text/uri-list`;
 * browsers that only know the link put it in `text/plain`.
 */
function imageUrlFromDrop(dataTransfer) {
  const html = dataTransfer.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const fromHtml = originalImageUrl(doc.querySelector('img[src]')?.getAttribute('src'));
    if (fromHtml) return fromHtml;
  }

  const uriList = dataTransfer.getData('text/uri-list');
  const firstUri = uriList
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));

  return originalImageUrl(firstUri) || originalImageUrl(dataTransfer.getData('text/plain'));
}

/**
 * Extension pages can only read another origin's bytes when that origin is granted. Ask while the
 * drop gesture is still live; a denial is not fatal because the origin may already be covered.
 */
async function allowImageOrigin(url) {
  try {
    const { origin, protocol } = new URL(url);
    if (!/^https?:$/.test(protocol)) return false;
    await chrome.permissions.request({ origins: [`${origin}/*`] });
    return true;
  } catch {
    return false;
  }
}

async function prepareImage(blob) {
  if (!blob || !String(blob.type).startsWith('image/')) {
    throw new Error('That drop is not an image.');
  }
  if (blob.size > BUILDER_MAX_BYTES) {
    throw new Error(`Image is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 8 MB.`);
  }
  if (typeof createImageBitmap !== 'function') return blob;

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    // HEIC/SVG and friends fall through to the API, which reports a real message.
    return blob;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > BUILDER_MAX_EDGE ? BUILDER_MAX_EDGE / longest : 1;

  if (scale === 1 && blob.size <= BUILDER_SKIP_BYTES) {
    bitmap.close?.();
    return blob;
  }

  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close?.();
    return blob;
  }

  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const encoded = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', BUILDER_JPEG_QUALITY);
  });
  return encoded || blob;
}

async function scanImage(blob, name) {
  if (state.builderBusy) return;
  if (!state.settings.apiBase) {
    builderSay('Set your dashboard URL in Settings before scanning.', 'bad');
    return;
  }

  state.builderBusy = true;
  state.builder = null;
  ui.builderResult.replaceChildren();
  const stopProgress = startBuilderProgress('Reading the slipâ€¦');

  try {
    let source = blob;
    if (!String(source.type).startsWith('image/')) {
      const type = mimeFromName(name);
      if (type) source = new File([source], name, { type });
    }

    const image = await prepareImage(source);
    const body = new FormData();
    body.append(
      'image',
      image,
      name || (image.type === 'image/jpeg' ? 'betslip.jpg' : 'betslip.png'),
    );

    const response = await fetch(`${state.settings.apiBase}/api/bet-builder/extract`, {
      method: 'POST',
      body,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok || !payload || !Array.isArray(payload.matched)) {
      const detail = payload?.detail ? ` (${payload.detail})` : '';
      throw new Error(payload?.error || `Scan failed with HTTP ${response.status}${detail}.`);
    }

    state.builder = payload;
    renderBuilder();

    const matched = payload.matched.length;
    const unresolved = Array.isArray(payload.unresolved) ? payload.unresolved.length : 0;
    builderSay(
      `${matched} matched Â· ${unresolved} unresolved${payload.cached ? ' Â· cached' : ''}.`,
      matched ? 'good' : 'warn',
    );
  } catch (error) {
    const message = String(error?.message || error);
    builderSay(
      /failed to fetch/i.test(message)
        ? 'Could not reach the dashboard. Check its URL in Settings and allow that host.'
        : message,
      'bad',
    );
  } finally {
    stopProgress();
    state.builderBusy = false;
  }
}

/** A click is an unambiguous gesture, so it can grant access even if the drop's was spent. */
function builderAllowPrompt(url) {
  let host = 'the image host';
  try {
    host = new URL(url).host;
  } catch {
    /* keep the placeholder */
  }

  builderSay('Chrome needs permission to download that image.', 'warn');
  ui.builderResult.replaceChildren(
    node('div', { class: 'row bb-actions' }, [
      node('button', { text: `Allow ${host} & scan`, onclick: () => scanImageFromUrl(url) }),
    ]),
  );
}

async function scanImageFromUrl(url) {
  if (state.builderBusy) return;
  const stopProgress = startBuilderProgress('Fetching imageâ€¦');

  // Keep this first: chrome.permissions.request needs the drop gesture to still be live.
  await allowImageOrigin(url);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`The image host answered HTTP ${response.status}.`);
    const blob = await response.blob();
    if (!String(blob.type).startsWith('image/')) throw new Error('That link is not an image.');
    stopProgress();
    await scanImage(blob, imageNameFromUrl(url));
  } catch (error) {
    stopProgress();
    const message = String(error?.message || error);
    if (/failed to fetch/i.test(message)) builderAllowPrompt(url);
    else builderSay(message, 'bad');
  }
}

/**
 * The matcher's score is a name/price similarity, not a probability, so it is shown as a tier
 * rather than a percentage that would read as certainty. Anything under 0.72 never reaches here.
 */
function confidenceTier(confidence) {
  const score = Number(confidence) || 0;
  if (score >= 0.9) return 'strong';
  if (score >= 0.8) return 'good';
  return 'weak';
}

function builderRow(entry) {
  const home = entry.match?.teams?.home?.name || entry.leg?.home || '?';
  const away = entry.match?.teams?.away?.name || entry.leg?.away || '?';
  const odds = Number(entry.leg?.odds);
  const tier = confidenceTier(entry.confidence);

  return node('li', { class: 'bb-row' }, [
    node('div', { class: 'bb-row-top' }, [
      node('span', { class: 'bb-teams', text: `${home} vs ${away}` }),
      node('span', { class: 'bb-odds', text: Number.isFinite(odds) ? odds.toFixed(2) : 'â€”' }),
    ]),
    node('div', {
      class: 'bb-pick',
      text: `${entry.leg?.market || 'Selection'} Â· ${entry.leg?.selection || ''}`,
    }),
    node('div', { class: 'muted bb-meta' }, [
      `${entry.leg?.leagueHint || entry.match?.league?.name || 'Feed fixture'} Â· `,
      node('span', { class: `bb-tier bb-tier-${tier}`, text: tier.toUpperCase() }),
    ]),
    node('div', { class: 'bb-links' }, [
      entry.links?.sportybet
        ? node('button', {
            class: 'ghost',
            text: 'SportyBet',
            onclick: () => chrome.tabs.create({ url: entry.links.sportybet }),
          })
        : null,
      entry.links?.betboro
        ? node('button', {
            class: 'ghost',
            text: 'BetBoro',
            onclick: () => chrome.tabs.create({ url: entry.links.betboro }),
          })
        : null,
    ]),
  ]);
}

function unresolvedRow(entry) {
  const teams =
    entry.leg?.home && entry.leg?.away
      ? `${entry.leg.home} vs ${entry.leg.away}`
      : entry.leg?.rawText || 'Unreadable selection';
  const closest = (Array.isArray(entry.candidates) ? entry.candidates : [])
    .slice(0, 2)
    .map((candidate) => {
      const match = candidate.match;
      return `${match?.teams?.home?.name || '?'} vs ${match?.teams?.away?.name || '?'}`;
    })
    .join(', ');

  return node('li', { class: 'bb-row bb-row-bad' }, [
    node('div', { class: 'bb-teams', text: teams }),
    node('div', {
      class: 'bb-pick',
      text: `${entry.leg?.market || ''} ${entry.leg?.selection || ''}`.trim(),
    }),
    node('div', {
      class: 'muted',
      text: `${UNRESOLVED_LABEL[entry.reason] || entry.reason || 'Unresolved'}${closest ? ` Â· closest: ${closest}` : ''}`,
    }),
  ]);
}

function renderBuilder() {
  const result = state.builder;
  ui.builderResult.replaceChildren();
  if (!result) return;

  const matched = Array.isArray(result.matched) ? result.matched : [];
  const unresolved = Array.isArray(result.unresolved) ? result.unresolved : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const betboroLegs = Array.isArray(result.betboro?.legs) ? result.betboro.legs : [];

  // `append()` stringifies null/undefined into text nodes, which is how "nullnullnull" got in.
  const parts = [
    node('div', { class: 'bb-summary' }, [
      node('span', { text: `${matched.length} matched Â· ${unresolved.length} unresolved` }),
      result.cached ? node('span', { class: 'pill', text: 'cached' }) : null,
    ]),
    node('div', { class: 'row bb-actions' }, [
      result.sportybetAccaUrl
        ? node('button', {
            text: 'Open SportyBet slip',
            onclick: () => chrome.tabs.create({ url: result.sportybetAccaUrl }),
          })
        : null,
      betboroLegs.length
        ? node('button', {
            class: 'ghost',
            text: `Fill BetBoro (${betboroLegs.length})`,
            onclick: fillBetBoro,
          })
        : null,
    ]),
    matched.length ? node('ul', { class: 'bb-list' }, matched.map(builderRow)) : null,
    unresolved.length ? node('ul', { class: 'bb-list' }, unresolved.map(unresolvedRow)) : null,
    result.sportybetAccaWarning
      ? node('p', { class: 'hint', text: result.sportybetAccaWarning })
      : null,
    warnings.length ? node('p', { class: 'hint', text: warnings.join(' Â· ') }) : null,
  ];

  ui.builderResult.append(...parts.filter(Boolean));
}

function smartAccaSay(message, tone = '') {
  ui.smartAccaStatus.hidden = !message;
  ui.smartAccaStatus.textContent = message || '';
  if (message) ui.smartAccaStatus.dataset.tone = tone;
  else delete ui.smartAccaStatus.dataset.tone;
}

function smartAccaCombinedOdds() {
  return (state.smartAcca?.matches ?? []).reduce((product, match) => product * Number(match.odds), 1);
}

function updateSmartAccaTotals() {
  const matches = state.smartAcca?.matches ?? [];
  const odds = Number(smartAccaCombinedOdds().toFixed(2));
  const stake = Number(ui.smartAccaStake.value);
  ui.smartAccaOdds.textContent = matches.length === 4 ? odds.toFixed(2) : '—';
  ui.smartAccaWin.textContent =
    matches.length === 4 && Number.isFinite(stake) && stake > 0
      ? `GHS ${(stake * odds).toFixed(2)}`
      : '—';
}

function confidenceBar(confidence) {
  const raw = Number(confidence);
  // Groq answers on a 0-1 scale (0.9 = 90%), so widen fractions before drawing the bar.
  const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? (raw > 0 && raw <= 1 ? raw * 100 : raw) : 0));
  return node('div', { class: 'smart-acca-confidence' }, [
    node('div', { class: 'confidence-track' }, [
      node('span', { class: 'confidence-knob', style: `left: ${pct}%` }),
    ]),
    node('span', { class: 'confidence-value', text: `${pct.toFixed(0)}%` }),
  ]);
}

function renderSmartAcca() {
  const matches = state.smartAcca?.matches ?? [];
  ui.smartAccaResult.replaceChildren();
  ui.smartAccaResult.append(
    ...matches.map((match) =>
      node('article', { class: 'smart-acca-pick' }, [
        node('div', { class: 'bb-row-top' }, [
          node('strong', { class: 'bb-teams', text: `${match.home} vs ${match.away}` }),
          node('span', { class: 'bb-odds', text: Number(match.odds).toFixed(2) }),
        ]),
        node('div', {
          class: 'bb-meta muted',
          text: `${match.league || 'Football'} · ${match.selection} · ${match.kickoff || ''}`,
        }),
        confidenceBar(match.confidence),
      ]),
    ),
  );
  if (state.smartAccaExhausted) {
    ui.smartAccaResult.append(
      node('button', {
        class: 'ghost',
        type: 'button',
        text: 'Start today over',
        onclick: async () => {
          if (state.smartAccaBusy) return;
          await clearSmartAccaUsed();
          state.smartAccaExhausted = false;
          refreshSmartAcca();
        },
      }),
    );
  }
  const ready = matches.length === 4 && !state.smartAccaLogged;
  ui.smartAccaAddBtn.disabled =
    state.smartAccaBusy || !ready || matches.some((match) => !match.booking);
  ui.smartAccaBetboroBtn.disabled = state.smartAccaBusy || !ready;
  ui.smartAccaRefreshBtn.disabled = state.smartAccaBusy;
  updateSmartAccaTotals();
}

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const SMART_ACCA_USED_KEY = 'smartAccaUsed';
const smartAccaPickKey = (match) => `${match.home}|${match.away}|${match.market ?? '1X2'}`;

/**
 * Batches already slipped or logged today, kept locally as well as on the server. KV reads are
 * eventually consistent, so a refresh seconds after logging could otherwise see a stale list and
 * offer the same four again.
 */
async function smartAccaUsedToday() {
  try {
    const stored = await chrome.storage.local.get(SMART_ACCA_USED_KEY);
    const entry = stored?.[SMART_ACCA_USED_KEY];
    return entry?.day === localDay() && Array.isArray(entry.keys) ? entry.keys : [];
  } catch {
    return [];
  }
}

async function rememberSmartAccaUsed(keys) {
  if (keys.length === 0) return;
  try {
    const existing = await smartAccaUsedToday();
    const merged = [...new Set([...existing, ...keys])];
    await chrome.storage.local.set({ [SMART_ACCA_USED_KEY]: { day: localDay(), keys: merged } });
  } catch {
    // Storage is a convenience; the server keeps the durable record.
  }
}

async function clearSmartAccaUsed() {
  try {
    await chrome.storage.local.remove(SMART_ACCA_USED_KEY);
  } catch {
    // Nothing to clean up.
  }
  if (!state.settings.apiBase) return;
  try {
    await fetch(`${state.settings.apiBase}/api/smart-acca`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: localDay(), reset: true }),
    });
  } catch {
    // Best effort.
  }
}

async function refreshSmartAcca() {
  if (state.smartAccaBusy) return;
  if (!state.settings.apiBase) {
    smartAccaSay('Set your dashboard URL in Settings before refreshing SmartACCA.', 'bad');
    return;
  }

  const exclude = [
    ...new Set([
      ...(await smartAccaUsedToday()),
      ...(state.smartAcca?.matches ?? []).map(smartAccaPickKey),
    ]),
  ].slice(0, 40);
  state.smartAccaBusy = true;
  state.smartAcca = null;
  state.smartAccaLogged = false;
  renderSmartAcca();
  smartAccaSay('Scraping today’s predictions and asking Groq to rank four…');
  try {
    const response = await fetch(`${state.settings.apiBase}/api/smart-acca`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: localDay(),
        exclude,
      }),
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 409 && payload?.exhausted) {
      state.smartAccaExhausted = true;
      renderSmartAcca();
      smartAccaSay(payload.error, 'warn');
      return;
    }
    if (!response.ok || !Array.isArray(payload?.matches)) {
      throw new Error(payload?.error || `SmartACCA failed with HTTP ${response.status}.`);
    }
    state.smartAcca = payload;
    state.smartAccaExhausted = false;
    renderSmartAcca();
    const mapped = payload.matches.filter((match) => match.booking).length;
    smartAccaSay(
      `${payload.matches.length} picks · analyzed ${payload.analyzedCount} of ${payload.scrapedCount} predictions today · ${mapped}/4 matched to SportyBet.`,
      mapped === 4 ? 'good' : 'warn',
    );
  } catch (error) {
    const message = String(error?.message || error);
    smartAccaSay(
      /failed to fetch/i.test(message)
        ? 'Could not reach the dashboard. Check its URL in Settings and allow that host.'
        : message,
      'bad',
    );
  } finally {
    state.smartAccaBusy = false;
    renderSmartAcca();
  }
}

async function markSmartAccaUsed() {
  const matches = state.smartAcca?.matches ?? [];
  if (matches.length === 0) return;
  const keys = matches.map(smartAccaPickKey);
  await rememberSmartAccaUsed(keys);
  if (!state.settings.apiBase) return;
  try {
    await fetch(`${state.settings.apiBase}/api/smart-acca`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day: localDay(), mark: keys }),
    });
  } catch {
    // The local record still keeps the next refresh from repeating these picks.
  }
}

/**
 * Logs the current four as a `muggy` active bet on the given book. The pre-created hedge leg is a
 * zero-stake placeholder so the DB row keeps its two-leg shape; only the acca stake is debited.
 */
async function logSmartAccaBatch(bookie) {
  const matches = state.smartAcca?.matches ?? [];
  const stake = Number(ui.smartAccaStake.value);
  if (matches.length !== 4 || !Number.isFinite(stake) || stake <= 0) {
    throw new Error('Enter a stake greater than GHS 0 to log this acca.');
  }

  const simulation = ui.smartAccaMode.value === 'simulation';
  const selection = matches
    .map((match) => `${match.home} ${match.selection}`)
    .join(' · ')
    .slice(0, 200);
  const response = await fetch(`${state.settings.apiBase}/api/active-bets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventName: `SmartACCA - ${bookie}`,
      kind: 'muggy',
      sport: 'football',
      simulation,
      legs: [
        { name: bookie, selection, odds: smartAccaCombinedOdds(), stake },
        { name: bookie, selection: '', odds: 1.01, stake: 0 },
      ],
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error || `Could not log the acca (HTTP ${response.status}).`);
  }
  state.smartAccaLogged = true;
  await markSmartAccaUsed();
  return { mode: simulation ? 'simulation' : 'real', totalStake: Number(payload.totalStake) };
}

async function addSmartAccaToSportyBet() {
  const matches = state.smartAcca?.matches ?? [];
  if (matches.length !== 4 || matches.some((match) => !match.booking) || state.smartAccaBusy) return;
  state.smartAccaBusy = true;
  renderSmartAcca();
  smartAccaSay('Creating the SportyBet slip and logging it…');
  try {
    const response = await fetch(`${state.settings.apiBase}/api/bet-builder/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections: matches.map((match) => match.booking) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.shareURL) {
      throw new Error(payload?.error || `Could not create the SportyBet slip (HTTP ${response.status}).`);
    }
    await chrome.tabs.create({ url: payload.shareURL });
    const logged = await logSmartAccaBatch('SportyBet');
    const skipped = Array.isArray(payload.skipped) ? payload.skipped.length : 0;
    smartAccaSay(
      skipped
        ? `Opened SportyBet with ${payload.booked}/4 picks and logged GHS ${logged.totalStake.toFixed(2)} (${logged.mode}). ${skipped} unavailable pick(s) were omitted.`
        : `Opened all four picks on SportyBet and logged GHS ${logged.totalStake.toFixed(2)} (${logged.mode}). Verify the slip before placing your bet.`,
      skipped ? 'warn' : 'good',
    );
  } catch (error) {
    smartAccaSay(String(error?.message || error), 'bad');
  } finally {
    state.smartAccaBusy = false;
    renderSmartAcca();
  }
}

async function addSmartAccaToBetBoro() {
  if (state.smartAccaBusy) return;
  state.smartAccaBusy = true;
  renderSmartAcca();
  smartAccaSay('Logging the acca on BetBoro…');
  try {
    const logged = await logSmartAccaBatch('BetBoro');
    smartAccaSay(
      `Logged GHS ${logged.totalStake.toFixed(2)} as a ${logged.mode} Muggy Bet on BetBoro.`,
      'good',
    );
  } catch (error) {
    smartAccaSay(String(error?.message || error), 'bad');
  } finally {
    state.smartAccaBusy = false;
    renderSmartAcca();
  }
}

ui.smartAccaRefreshBtn.addEventListener('click', refreshSmartAcca);
ui.smartAccaStake.addEventListener('input', updateSmartAccaTotals);
ui.smartAccaMode.addEventListener('change', () => {
  chrome.storage.local.set({ smartAccaMode: ui.smartAccaMode.value }).catch(() => {});
  if (state.smartAccaLogged) {
    state.smartAccaLogged = false;
    renderSmartAcca();
  }
});
ui.smartAccaAddBtn.addEventListener('click', addSmartAccaToSportyBet);
ui.smartAccaBetboroBtn.addEventListener('click', addSmartAccaToBetBoro);

async function fillBetBoro() {
  const legs = Array.isArray(state.builder?.betboro?.legs) ? state.builder.betboro.legs : [];
  if (!legs.length) return;

  builderSay(`Filling ${legs.length} BetBoro leg(s)â€¦`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOBET_SLIP',
      legs: legs.map((leg) => ({
        bookmaker: 'BetBoro',
        url: leg.url,
        market: leg.market,
        outcome: leg.outcome,
        label: leg.label,
      })),
    });

    if (!response || response.error) {
      throw new Error(response?.error || 'Could not fill the BetBoro slip.');
    }

    const failed = (response.results || []).filter((entry) => entry.status !== 'filled');
    builderSay(
      failed.length
        ? `Added ${response.filled}/${response.total}. ${failed
            .slice(0, 2)
            .map((entry) => `${entry.label}: ${entry.message || entry.status}`)
            .join(' | ')}`
        : `Added ${response.filled}/${response.total} to BetBoro. Verify the slip.`,
      failed.length ? 'warn' : 'good',
    );
  } catch (error) {
    builderSay(String(error?.message || error), 'bad');
  }
}

function pickImage() {
  ui.builderFile.click();
}

function scanDroppedFile(file) {
  scanImage(file, file.name).catch((error) => builderSay(String(error?.message || error), 'bad'));
}

function setDropState(active) {
  ui.builderDrop.classList.toggle('over', Boolean(active));
}

ui.builderDrop.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  setDropState(true);
});

ui.builderDrop.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  setDropState(true);
});

ui.builderDrop.addEventListener('dragleave', (event) => {
  if (!ui.builderDrop.contains(event.relatedTarget)) setDropState(false);
});

ui.builderDrop.addEventListener('drop', (event) => {
  event.preventDefault();
  event.stopPropagation();
  setDropState(false);

  const dataTransfer = event.dataTransfer;
  if (!dataTransfer) return;

  const file = Array.from(dataTransfer.files || []).find(
    (entry) =>
      String(entry.type).startsWith('image/') ||
      /\.(png|jpe?g|webp|gif)$/i.test(String(entry.name || '')),
  );
  if (file) {
    scanDroppedFile(file);
    return;
  }

  const url = imageUrlFromDrop(dataTransfer);
  if (!url) {
    builderSay('That drop carried no image. Save the picture and drop the file instead.', 'bad');
    return;
  }
  scanImageFromUrl(url);
});

// Dropping just outside the zone must not navigate the panel away from the UI.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

// Paste is the fallback when a page will not hand its image over a drag.
// Also the primary path for a Win+Shift+S snip, which lands on the clipboard as an image.
document.addEventListener('paste', (event) => {
  if (ui.viewBuilder.hidden) return;
  const item = Array.from(event.clipboardData?.items || []).find((entry) =>
    String(entry.type).startsWith('image/'),
  );
  const file = item?.getAsFile();
  if (!file) return;
  event.preventDefault();
  scanDroppedFile(file);
});

ui.builderDrop.addEventListener('click', pickImage);
ui.builderDrop.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    pickImage();
  }
});
ui.pickImageBtn.addEventListener('click', pickImage);

ui.builderFile.addEventListener('change', () => {
  const file = ui.builderFile.files?.[0];
  ui.builderFile.value = '';
  if (file) scanDroppedFile(file);
});

// ---------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'AUTOBET_JOB' || !message.job) return;
  state.job = message.job;
  renderJob();
  renderArbs();

  if (message.job.status === 'ready') say('Both slips filled â€” verify and click Place Bet.');
  else if (message.job.status === 'failed') say('Some legs need attention. See the job card.');
  else if (message.job.status === 'running') say('Fillingâ€¦');
});

function connectPort() {
  try {
    const port = chrome.runtime.connect({ name: 'autobet-panel' });
    port.onMessage.addListener((message) => {
      if (message?.type === 'AUTOBET_JOB' && message.job) {
        state.job = message.job;
        renderJob();
        renderArbs();
      }
    });
    port.onDisconnect.addListener(() => setTimeout(connectPort, 1000));
  } catch {
    /* worker asleep; the next message wakes it */
  }
}

ui.refreshBtn.addEventListener('click', () => {
  refreshNow();
});

ui.settingsBtn.addEventListener('click', () => {
  setTab('autobet');
  ui.settings.hidden = !ui.settings.hidden;
});

ui.saveBaseBtn.addEventListener('click', () => {
  saveBase(ui.apiBaseInput.value).catch((error) => say(String(error?.message || error)));
});

ui.useTabBtn.addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(
    (entry) =>
      entry.url && /^https:\/\/[^/]+\.pages\.dev\//.test(entry.url) && entry.id !== undefined,
  );
  if (!tab) {
    say('No Cloudflare Pages dashboard tab is open.');
    return;
  }
  ui.apiBaseInput.value = new URL(tab.url).origin;
  saveBase(ui.apiBaseInput.value).catch((error) => say(String(error?.message || error)));
});

ui.saveSettingsBtn.addEventListener('click', async () => {
  const next = {
    totalStake: Math.max(1, Number(ui.stakeInput.value) || DEFAULT_SETTINGS.totalStake),
    roundStep: Number(ui.stepInput.value) || DEFAULT_SETTINGS.roundStep,
    oddsTolerancePct: Math.max(0, Number(ui.tolInput.value) || 0),
    autoRefreshSec: Math.max(15, Number(ui.refreshInput.value) || DEFAULT_SETTINGS.autoRefreshSec),
  };

  try {
    const apiBase = normaliseBase(ui.apiBaseEdit.value);
    if (apiBase && apiBase !== state.settings.apiBase) {
      await chrome.permissions.request({ origins: [`${apiBase}/*`] }).catch(() => false);
      next.apiBase = apiBase;
    }
  } catch (error) {
    say(String(error?.message || error));
    return;
  }

  await chrome.storage.local.set(next);
  state.settings = { ...state.settings, ...next };
  ui.settings.hidden = true;
  ui.setup.hidden = Boolean(state.settings.apiBase);
  ui.stakeInput.value = state.settings.totalStake;
  say('Settings saved.');
  renderArbs();
  refreshFeed();
  schedulePolling();
});

ui.cancelBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'AUTOBET_CANCEL' });
  say('Cancelled. Any filled slips are untouched.');
});

ui.retryBtn.addEventListener('click', retryFailed);

ui.dismissBtn.addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'AUTOBET_CLEAR' });
    if (!response?.ok) throw new Error(response?.error || 'Could not clear the job.');
    state.job = null;
    renderJob();
    renderArbs();
    say('Job cleared. You can start another run.');
  } catch (error) {
    say(String(error?.message || error));
  }
});

let pollTimer = null;
function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const seconds = Math.max(15, Number(state.settings.autoRefreshSec) || 60);
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshFeed();
  }, seconds * 1000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFeed();
});

setInterval(refreshLabels, 30_000);

(async function init() {
  const storedTheme = await chrome.storage.local.get(THEME_KEY).catch(() => null);
  applyTheme(storedTheme?.[THEME_KEY] === 'light' ? 'light' : 'dark');

  connectPort();
  await loadSettings();

  const storedTab = await chrome.storage.session.get('panelTab').catch(() => null);
  setTab(storedTab?.panelTab === 'builder' ? 'builder' : 'autobet');

  chrome.runtime
    .sendMessage({ type: 'AUTOBET_PING' })
    .then((response) => {
      if (response?.version) ui.extVersion.textContent = `v${response.version}`;
    })
    .catch(() => {});

  const stored = await chrome.storage.session.get('job').catch(() => null);
  if (stored?.job) {
    state.job = stored.job;
    renderJob();
  }

  await refreshFeed();
  schedulePolling();
})();
