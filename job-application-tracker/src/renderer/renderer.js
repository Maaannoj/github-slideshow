'use strict';

/* Renderer logic. Talks to the main process only via the whitelisted
 * window.api bridge defined in preload.js. */

const SETUP_GUIDE_URL =
  'https://developers.google.com/workspace/guides/create-credentials#desktop-app';

const STAGES = ['applied', 'viewed', 'assessment', 'interview', 'offer', 'rejected'];
const STAGE_LABELS = {
  applied: 'Applied',
  viewed: 'Viewed',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};

const state = {
  applications: [],
  filter: 'all',
  search: '',
  lastSync: null,
};

const $ = (sel) => document.querySelector(sel);

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireSetup();
  wireDashboard();
  await route();
}

// Decide which screen to show based on setup/connection status.
async function route() {
  const status = await window.api.status();

  if (status.hasCredentials) {
    markStepDone('step-creds', 'creds-ok', 'btn-connect');
  }

  if (status.isConnected) {
    showDashboard(status);
  } else {
    show('setup');
  }
}

function show(screen) {
  $('#setup').classList.toggle('hidden', screen !== 'setup');
  $('#dashboard').classList.toggle('hidden', screen !== 'dashboard');
}

// ---------- Setup wiring ----------
function wireSetup() {
  $('#open-guide').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(SETUP_GUIDE_URL);
  });

  $('#btn-import').addEventListener('click', async () => {
    setError('');
    const res = await window.api.importCredentials();
    if (res.canceled) return;
    if (res.ok) {
      markStepDone('step-creds', 'creds-ok', 'btn-connect');
    } else {
      setError(res.error || 'Could not read that file.');
    }
  });

  $('#btn-connect').addEventListener('click', async () => {
    setError('');
    const btn = $('#btn-connect');
    btn.disabled = true;
    btn.textContent = 'Waiting for Google…';
    const res = await window.api.connect();
    btn.disabled = false;
    btn.textContent = 'Connect Gmail';
    if (res.ok) {
      const status = await window.api.status();
      showDashboard(status);
      // First-time connect: do an immediate sync.
      sync();
    } else {
      setError(res.error || 'Connection failed.');
    }
  });
}

function markStepDone(stepId, badgeId, unlockBtnId) {
  $('#' + stepId).classList.add('done');
  $('#' + badgeId).classList.remove('hidden');
  const connectStep = $('#step-connect');
  connectStep.classList.remove('disabled');
  $('#' + unlockBtnId).disabled = false;
}

function setError(msg) {
  const el = $('#setup-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ---------- Dashboard wiring ----------
function wireDashboard() {
  $('#btn-sync').addEventListener('click', sync);
  $('#btn-menu').addEventListener('click', async () => {
    if (confirm('Sign out and clear the local board? Your credentials stay saved.')) {
      await window.api.disconnect();
      state.applications = [];
      show('setup');
      await route();
    }
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.toLowerCase();
    renderBoard();
  });
}

async function showDashboard(status) {
  show('dashboard');
  $('#account').textContent = status.account || '';
  renderFilters();
  const cached = await window.api.getApplications();
  state.applications = cached.applications || [];
  state.lastSync = cached.lastSync;
  renderAll();
  // If we've never synced, kick one off automatically.
  if (!state.lastSync) sync();
}

async function sync() {
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin">↻</span> Syncing…';
  const res = await window.api.sync();
  btn.disabled = false;
  btn.textContent = '↻ Sync now';
  if (res.ok) {
    state.applications = res.applications;
    state.lastSync = res.lastSync;
    renderAll();
    toast(`Scanned ${res.scanned} emails · ${res.applications.length} applications`);
  } else {
    toast(res.error || 'Sync failed', true);
    if (/reconnect|expired/i.test(res.error || '')) {
      await window.api.disconnect();
      show('setup');
      route();
    }
  }
}

// ---------- Rendering ----------
function renderAll() {
  renderStats();
  renderBoard();
  renderLastSync();
}

function renderStats() {
  const counts = { all: state.applications.length };
  for (const s of STAGES) counts[s] = 0;
  for (const a of state.applications) counts[a.status] = (counts[a.status] || 0) + 1;

  const active = state.applications.filter(
    (a) => a.status !== 'rejected' && a.status !== 'offer'
  ).length;

  const tiles = [
    { label: 'Total', num: counts.all, cls: '' },
    { label: 'Active', num: active, cls: 'pill-interview' },
    { label: 'Interviews', num: counts.interview + counts.assessment, cls: 'pill-interview' },
    { label: 'Offers', num: counts.offer, cls: 'pill-offer' },
    { label: 'Rejected', num: counts.rejected, cls: 'pill-rejected' },
  ];
  $('#statbar').innerHTML = tiles
    .map(
      (t) => `<div class="stat"><div class="num">${t.num}</div>
      <div class="label">${t.label}</div>
      <div class="bar ${t.cls}"></div></div>`
    )
    .join('');
}

function renderFilters() {
  const wrap = $('#filters');
  const all = [{ id: 'all', label: 'All' }].concat(
    STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] }))
  );
  wrap.innerHTML = all
    .map(
      (f) =>
        `<button class="chip ${state.filter === f.id ? 'active' : ''}" data-filter="${f.id}">${f.label}</button>`
    )
    .join('');
  wrap.querySelectorAll('.chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      renderFilters();
      renderBoard();
    })
  );
}

function renderBoard() {
  const board = $('#board');
  const tpl = $('#app-row');
  board.innerHTML = '';

  const items = state.applications.filter((a) => {
    if (state.filter !== 'all' && a.status !== state.filter) return false;
    if (state.search) {
      const hay = `${a.company} ${a.role || ''} ${a.latestSubject || ''}`.toLowerCase();
      if (!hay.includes(state.search)) return false;
    }
    return true;
  });

  $('#empty').classList.toggle('hidden', state.applications.length > 0);
  if (state.applications.length === 0) return;

  for (const app of items) {
    const node = tpl.content.cloneNode(true);
    const card = node.querySelector('.app-card');
    card.classList.add('s-' + app.status);
    node.querySelector('.app-company').textContent = app.company;
    node.querySelector('.app-role').textContent = app.role || '';
    node.querySelector('.app-subject').textContent = app.latestSubject || '';
    node.querySelector('.status-pill').textContent = STAGE_LABELS[app.status] || app.status;
    node.querySelector('.app-date').textContent = relDate(app.lastUpdate);
    node.querySelector('.app-count').textContent =
      app.emailCount > 1 ? `${app.emailCount} emails` : '';
    board.appendChild(node);
  }
}

function renderLastSync() {
  $('#last-sync').textContent = state.lastSync
    ? 'Last synced ' + relDate(state.lastSync)
    : 'Not synced yet';
}

// ---------- helpers ----------
function relDate(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}
