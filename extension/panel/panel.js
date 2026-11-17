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
  settingsBtn: $('settingsBtn'),
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

// ---------------------------------------------------------------- settings

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  state.settings = { ...DEFAULT_SETTINGS, ...stored };
  ui.stakeInput.value = state.settings.totalStake;
  ui.stepInput.value = String(state.settings.roundStep);
  ui.tolInput.value = state.settings.oddsTolerancePct;
  ui.refreshInput.value = state.settings.autoRefreshSec;
  ui.apiBaseEdit.value = state.settings.apiBase;
  ui.apiBaseInput.value = state.settings.apiBase;
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
    /* already granted, or a chrome:// page — the fetch below reports the real problem */
  }

  await chrome.storage.local.set({ apiBase });
  state.settings.apiBase = apiBase;
  ui.setup.hidden = true;
  ui.apiBaseEdit.value = apiBase;
  ui.apiBaseInput.value = apiBase;
  await refreshFeed();
}

// ---------------------------------------------------------------- feed

/** Applies a feed payload to the panel: dot, meta line and the arb list. */
function applyFeed(feed) {
  state.feed = feed;
  state.feedError = null;
  state.feedAt = new Date();
  const age = feed.generatedAt ? Date.parse(feed.generatedAt) : null;
  const stale = Number.isFinite(age) && Date.now() - age > 25 * 60_000;
  ui.feedDot.className = `dot ${stale ? 'stale' : 'live'}`;
  renderFeedMeta(
    `Feed ${feed.generatedAt ? new Date(feed.generatedAt).toLocaleTimeString() : 'just now'}${
      stale ? ' · stale' : ''
    }`,
  );
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
  ui.refreshBtn.textContent = 'Refreshing…';
  ui.feedDot.className = 'dot stale';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'AUTOBET_REFRESH' });
    if (response?.ok && response.feed) {
      applyFeed(response.feed);
      say(`Feed refreshed · ${activeArbs().length} arb(s).`);
    } else {
      await refreshFeed();
      say(response?.error ? `Worker: ${response.error} — fetched directly.` : 'Feed refreshed.');
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
 * worst case can sit below total x profitPct — that gap is real money.
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
          title: SUPPORTED.has(leg.bookmaker) ? leg.url ?? '' : 'Not auto-filled — open manually',
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
          text: [arb.market, arb.tournament].filter(Boolean).join(' · '),
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
    button.textContent = 'Starting…';
  }
  say('Opening both bookmakers…');

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
    .join(' · ');

  ui.jobLegs.replaceChildren(
    ...job.legs.map((leg) =>
      node('li', { class: 'leg', dataset: { status: leg.status } }, [
        node('div', { class: 'leg-top' }, [
          node('span', {
            class: 'leg-book',
            text: `${leg.bookmaker} · ${leg.outcome}`,
          }),
          node('span', {
            class: 'leg-status',
            text: STATUS_LABEL[leg.status] ?? leg.status,
          }),
        ]),
        node('div', { class: 'muted' }, [
          node('span', { text: `${Number(leg.expectedOdds).toFixed(2)}` }),
          leg.observedOdds
            ? node('span', { text: ` → ${Number(leg.observedOdds).toFixed(2)}` })
            : null,
          node('span', { text: ` · GHS ${Number(leg.stake).toFixed(2)}` }),
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
  say('Retrying unfilled legs…');
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

// ---------------------------------------------------------------- wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'AUTOBET_JOB' || !message.job) return;
  state.job = message.job;
  renderJob();
  renderArbs();

  if (message.job.status === 'ready') say('Both slips filled — verify and click Place Bet.');
  else if (message.job.status === 'failed') say('Some legs need attention. See the job card.');
  else if (message.job.status === 'running') say('Filling…');
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
    say('Job cleared. You can run Autobet again.');
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
  connectPort();
  await loadSettings();
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
