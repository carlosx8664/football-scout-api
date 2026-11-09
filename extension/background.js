/**
 * Autobet service worker.
 *
 * Owns the job state machine. MV3 kills this worker after ~30 s idle, so every step is persisted
 * to `chrome.storage.session` and the panel reads the same record — a dead worker mid-job leaves a
 * resumable record rather than a lost one.
 *
 * It fills betslips. It never clicks "Place Bet".
 */
import { allocateStakes, DEFAULT_SETTINGS } from './shared/stakes.js';
import { fetchFeed } from './shared/feed.js';

const JOB_KEY = 'job';
const TABS_KEY = 'autobetTabs';
const SUPPORTED = { SportyBet: 'sportybet', BetBoro: 'betboro' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

chrome.runtime.onInstalled.addListener(() => setup());
chrome.runtime.onStartup.addListener(() => setup());
setup();

async function setup() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    /* older Chrome: the action click falls through to the popup-less default */
  }
  chrome.alarms.create('arb-badge', { periodInMinutes: 1 });
  refreshBadge().catch(() => {});
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'arb-badge') refreshBadge().catch(() => {});
});

async function settings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function readJob() {
  const stored = await chrome.storage.session.get(JOB_KEY);
  return stored?.[JOB_KEY] ?? null;
}

async function saveJob(job) {
  await chrome.storage.session.set({ [JOB_KEY]: job });
  chrome.runtime.sendMessage({ type: 'AUTOBET_JOB', job }).catch(() => {});
}

async function refreshBadge() {
  const job = await readJob().catch(() => null);
  const recent = job?.endedAt && Date.now() - Date.parse(job.endedAt) < 10 * 60_000;
  if (recent) {
    await chrome.action.setBadgeText({ text: job.status === 'ready' ? '✓' : '!' });
    await chrome.action.setBadgeBackgroundColor({
      color: job.status === 'ready' ? '#16a34a' : '#dc2626',
    });
    return;
  }

  const { apiBase } = await settings();
  if (!apiBase) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const feed = await fetchFeed(apiBase).catch(() => null);
  const count = feed?.arbs?.length ?? 0;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0ea5e9' });
}

// ---------------------------------------------------------------- job

let running = false;

async function startJob(input) {
  if (running) throw new Error('A job is already running. Cancel it first.');

  const current = await readJob();
  if (current?.status === 'running') throw new Error('A job is already running. Cancel it first.');

  const arb = input?.arb;
  if (!arb || !Array.isArray(arb.legs) || arb.legs.length === 0) {
    throw new Error('No arb legs received from the dashboard.');
  }

  const settingsNow = await settings();
  const legs = arb.legs
    .filter((leg) => SUPPORTED[leg?.bookmaker] && /^https?:\/\//i.test(String(leg?.url ?? '')))
    .map((leg, index) => ({
      id: `${index}-${SUPPORTED[leg.bookmaker]}`,
      bookmaker: leg.bookmaker,
      url: leg.url,
      outcome: leg.outcome,
      expectedOdds: Number(leg.odds) || 0,
      stake: 0,
      status: 'pending',
      message: '',
      observedOdds: null,
      tabId: null,
      loaded: false,
      side: null,
      ignoreOdds: false,
    }));

  if (legs.length < 2) {
    throw new Error(
      `Only ${legs.length} leg(s) can be filled automatically — both books must be SportyBet or BetBoro with a link.`,
    );
  }

  const totalStake = Number(input.totalStake) || settingsNow.totalStake;
  const roundStep = Number(input.roundStep) || settingsNow.roundStep;
  const stakes = allocateStakes(legs, totalStake, roundStep);
  legs.forEach((leg, index) => {
    leg.stake = stakes[index];
  });

  const job = {
    id: String(Date.now()),
    status: 'running',
    arbKey: `${arb.home}|${arb.away}|${arb.market}`,
    home: arb.home,
    away: arb.away,
    market: arb.market,
    tournament: arb.tournament ?? '',
    kickoff: arb.kickoff ?? null,
    profitPct: arb.profitPct ?? null,
    totalStake,
    roundStep,
    startedAt: new Date().toISOString(),
    endedAt: null,
    windowId: null,
    layout: 'none',
    legs,
  };

  await saveJob(job);
  runJob(job).catch((error) => finish(job, 'failed', String(error?.message || error)));
  return job;
}

async function runJob(job) {
  running = true;
  const settingsNow = await settings();

  try {
    // Both tabs must exist and be loaded before they can be paired into a split view.
    await openAllTabs(job);
    if (job.status !== 'running') return;

    job.layout = await arrangeTabs(job);
    await saveJob(job);

    for (const leg of job.legs) {
      if (job.status !== 'running') break;
      if (leg.status === 'filled' || !leg.loaded) continue;

      leg.status = 'filling';
      leg.message = '';
      await saveJob(job);

      try {
        const result = await sendFill(leg.tabId, leg, job, settingsNow);
        leg.status = result?.status ?? 'failed';
        leg.message = result?.message ?? '';
        leg.observedOdds = Number.isFinite(result?.observedOdds) ? result.observedOdds : null;
      } catch (error) {
        leg.status = 'failed';
        leg.message = String(error?.message || error);
      }

      await saveJob(job);
    }

    if (job.status === 'running') {
      const unfilled = job.legs.filter((leg) => leg.status !== 'filled');
      await finish(job, unfilled.length ? 'failed' : 'ready');
    }
  } finally {
    running = false;
  }
}

/** Opens every leg's tab in one window and waits for each to finish loading. */
async function openAllTabs(job) {
  for (const leg of job.legs) {
    if (leg.status === 'filled') continue;

    // A retry reuses the tab that is already open instead of navigating it again.
    if (leg.loaded && leg.tabId) {
      const live = await chrome.tabs.get(leg.tabId).catch(() => null);
      if (live) continue;
    }

    leg.status = 'opening';
    leg.message = '';
    await saveJob(job);

    try {
      const tab = await openTab(leg, job.windowId);
      leg.tabId = tab.id;
      job.windowId = tab.windowId ?? job.windowId;
      leg.status = 'loading';
      await saveJob(job);

      await waitForTab(tab.id, new URL(leg.url).host);
      leg.loaded = true;
    } catch (error) {
      leg.status = 'failed';
      leg.loaded = false;
      leg.message = String(error?.message || error);
      await saveJob(job);
    }
  }
}

/**
 * Pairs the two loaded tabs into a native Chrome split view.
 *
 * `chrome.tabs.createSplit` is feature-detected because the API is not in every Chrome build yet;
 * when it is missing (or rejects every call shape) the two tabs are moved into side-by-side
 * windows instead. A layout failure must never block filling, so every branch is best-effort.
 */
async function arrangeTabs(job) {
  const [left, right] = job.legs.filter((leg) => leg.loaded && leg.tabId);
  if (!left || !right) return 'none';

  left.side = 'left';
  right.side = 'right';

  // Re-running a job must not undo a split that is already in place.
  if (job.layout === 'split') {
    const live = await Promise.all(
      [left, right].map((leg) => chrome.tabs.get(leg.tabId).catch(() => null)),
    );
    if (live.every(Boolean)) return 'split';
  }

  if (typeof chrome.tabs.createSplit === 'function') {
    const attempts = [
      () => chrome.tabs.createSplit({ tabIds: [left.tabId, right.tabId] }),
      () => chrome.tabs.createSplit([left.tabId, right.tabId]),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        await chrome.tabs.update(left.tabId, { active: true }).catch(() => {});
        return 'split';
      } catch {
        /* try the next call shape */
      }
    }
  }

  try {
    const base = job.windowId
      ? await chrome.windows.get(job.windowId).catch(() => null)
      : await chrome.windows.getLastFocused().catch(() => null);
    const width = Math.max(560, Math.round((base?.width ?? 1280) / 2));
    const height = base?.height ?? 800;
    const top = base?.top ?? 0;
    const leftX = base?.left ?? 0;

    await chrome.windows.create({
      tabId: left.tabId,
      left: leftX,
      top,
      width,
      height,
      focused: true,
      type: 'normal',
    });
    await chrome.windows.create({
      tabId: right.tabId,
      left: leftX + width,
      top,
      width,
      height,
      focused: false,
      type: 'normal',
    });
    return 'windows';
  } catch {
    return 'none';
  }
}

async function finish(job, status, message) {
  job.status = status;
  job.endedAt = new Date().toISOString();
  if (message) job.error = message;
  await saveJob(job);
  refreshBadge().catch(() => {});
}

/**
 * Reuses the tab this extension opened for that bookmaker, so reruns do not pile up tabs.
 * When a target window is known the tab is moved into it, which is what makes pairing possible.
 */
async function openTab(leg, windowId) {
  const host = new URL(leg.url).host;
  const stored = await chrome.storage.local.get(TABS_KEY);
  const tabs = { ...(stored?.[TABS_KEY] ?? {}) };
  const previous = tabs[host];

  if (previous) {
    const existing = await chrome.tabs.get(previous).catch(() => null);
    if (existing) {
      if (windowId && existing.windowId !== windowId) {
        await chrome.tabs.move(existing.id, { windowId, index: -1 }).catch(() => {});
      }
      await chrome.tabs.update(existing.id, { url: leg.url, active: true });
      return await chrome.tabs.get(existing.id);
    }
  }

  const created = await chrome.tabs.create({
    url: leg.url,
    active: true,
    ...(windowId ? { windowId } : {}),
  });
  tabs[host] = created.id;
  await chrome.storage.local.set({ [TABS_KEY]: tabs });
  return created;
}

async function waitForTab(tabId, host, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('The bookmaker tab was closed.');
    if (tab.status === 'complete' && tab.url) {
      try {
        if (new URL(tab.url).host.endsWith(host)) return tab;
      } catch {
        /* about:blank during the first hop */
      }
    }
    if (Date.now() > deadline) throw new Error('Timed out waiting for the bookmaker page to load.');
    await sleep(500);
  }
}

async function sendFill(tabId, leg, job, settingsNow) {
  const message = {
    type: 'AUTOBET_FILL',
    leg: {
      bookmaker: leg.bookmaker,
      url: leg.url,
      outcome: leg.outcome,
      expectedOdds: leg.expectedOdds,
      stake: leg.stake,
    },
    arb: { home: job.home, away: job.away, market: job.market, kickoff: job.kickoff },
    tolerancePct: settingsNow.oddsTolerancePct,
    ignoreOdds: Boolean(leg.ignoreOdds),
  };

  let lastError = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (error) {
      lastError = error;
    }

    // The SPA may still be mounting; inject once and keep retrying.
    if (attempt === 5) {
      await inject(tabId, leg.bookmaker).catch(() => {});
    }
    await sleep(750);
  }

  throw lastError ?? new Error('The page never accepted the fill command.');
}

async function inject(tabId, bookmaker) {
  const file = SUPPORTED[bookmaker];
  if (!file) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/common.js', `content/${file}.js`],
  });
}

async function retryFailed(input) {
  const job = await readJob();
  if (!job) throw new Error('No job to retry.');
  if (job.status === 'running') throw new Error('The job is still running.');

  const settingsNow = await settings();
  if (Number(input?.totalStake)) job.totalStake = Number(input.totalStake);

  const pending = job.legs.filter((leg) => leg.status !== 'filled');
  if (!pending.length) throw new Error('Every leg is already filled.');

  const stakes = allocateStakes(job.legs, job.totalStake, job.roundStep ?? settingsNow.roundStep);
  job.legs.forEach((leg, index) => {
    leg.stake = stakes[index];
  });

  pending.forEach((leg) => {
    leg.status = 'pending';
    leg.message = '';
    leg.ignoreOdds = true;
  });

  job.status = 'running';
  job.endedAt = null;
  delete job.error;
  await saveJob(job);
  runJob(job).catch((error) => finish(job, 'failed', String(error?.message || error)));
  return job;
}

async function cancelJob() {
  const job = await readJob();
  if (!job || job.status !== 'running') return null;
  job.status = 'cancelled';
  job.endedAt = new Date().toISOString();
  await saveJob(job);
  return job;
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

async function handle(message) {
  switch (message?.type) {
    case 'AUTOBET_PING':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'AUTOBET_START':
      return { ok: true, job: await startJob(message) };
    case 'AUTOBET_GET':
      return { ok: true, job: await readJob() };
    case 'AUTOBET_CANCEL':
      return { ok: true, job: await cancelJob() };
    case 'AUTOBET_RETRY':
      return { ok: true, job: await retryFailed(message) };
    case 'AUTOBET_OUTCOME':
      return { ok: true, job: await readJob() };
    case 'AUTOBET_FOCUS': {
      const job = await readJob();
      const leg = job?.legs?.find((entry) => entry.id === message.legId);
      if (leg?.tabId) await chrome.tabs.update(leg.tabId, { active: true }).catch(() => {});
      return { ok: true };
    }
    default:
      return { ok: false, error: `Unknown message type: ${message?.type ?? '(none)'}` };
  }
}

// The panel asks for the job on open; a stale "running" record means the worker died mid-job.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'autobet-panel') return;
  readJob()
    .then(async (job) => {
      if (job?.status === 'running' && !running) {
        job.status = 'interrupted';
        job.message = 'The extension worker stopped mid-job. Retry the remaining legs.';
        job.endedAt = new Date().toISOString();
        await saveJob(job);
      }
      port.postMessage({ type: 'AUTOBET_JOB', job });
    })
    .catch(() => {});
});
