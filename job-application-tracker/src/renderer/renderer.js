'use strict';

/* Renderer SPA. Talks to the main process only through window.api (preload). */

const SETUP_GUIDE_URL =
  'https://developers.google.com/workspace/guides/create-credentials#desktop-app';

const STAGES = ['applied', 'viewed', 'assessment', 'interview', 'offer', 'rejected'];
const STAGE_RANK = STAGES.reduce((a, s, i) => ((a[s] = i), a), {});
const LABEL = {
  applied: 'Applied',
  viewed: 'Viewed',
  assessment: 'Assessment',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
};
const FUNNEL = ['applied', 'assessment', 'interview', 'offer'];

const state = {
  applications: [],
  lastSync: null,
  settings: { theme: 'dark', notifications: true, autoSyncMinutes: 60, staleDays: 14 },
  view: 'dashboard',
  filter: 'all',
  sort: 'recent',
  search: '',
  openKey: null,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const stageColor = (s) => cssVar(`--s-${s}`) || cssVar('--accent');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  wireSetup();
  wireShell();
  wireLiveEvents();
  await route();
}

async function route() {
  const st = await window.api.status();
  applyTheme((st.settings && st.settings.theme) || 'dark');
  if (st.hasCredentials) markCredsDone();

  if (st.isConnected) {
    state.settings = st.settings || state.settings;
    state.lastSync = st.lastSync;
    show('app');
    $('#acct-email').textContent = st.account || '—';
    const cached = await window.api.getApplications();
    state.applications = normalize(cached.applications || []);
    state.lastSync = cached.lastSync;
    renderAll();
    if (!state.lastSync) sync();
  } else {
    show('setup');
  }
}

function normalize(apps) {
  // Guard against older cached records missing v2 fields.
  return apps.map((a) => ({
    reachedStages: [],
    history: [],
    emailCount: 1,
    autoStatus: a.status,
    ...a,
    status: a.status || a.autoStatus || 'applied',
  }));
}

function show(screen) {
  $('#setup').classList.toggle('hidden', screen !== 'setup');
  $('#app').classList.toggle('hidden', screen !== 'app');
}

/* ---------------- Setup ---------------- */
function wireSetup() {
  $('#open-guide').addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(SETUP_GUIDE_URL);
  });
  $('#btn-import').addEventListener('click', async () => {
    setError('');
    const res = await window.api.importCredentials();
    if (res.canceled) return;
    if (res.ok) markCredsDone();
    else setError(res.error || 'Could not read that file.');
  });
  $('#btn-connect').addEventListener('click', async () => {
    setError('');
    const b = $('#btn-connect');
    b.disabled = true;
    b.textContent = 'Waiting for Google…';
    const res = await window.api.connect();
    b.disabled = false;
    b.textContent = 'Connect Gmail';
    if (res.ok) {
      await route();
      sync();
    } else setError(res.error || 'Connection failed.');
  });
}
function markCredsDone() {
  $('#step-creds').classList.add('done');
  $('#creds-ok').classList.remove('hidden');
  $('#step-connect').classList.remove('is-locked');
  $('#btn-connect').disabled = false;
}
function setError(m) {
  const el = $('#setup-error');
  el.textContent = m;
  el.classList.toggle('hidden', !m);
}

/* ---------------- Shell ---------------- */
function wireShell() {
  $$('.nav-item').forEach((n) =>
    n.addEventListener('click', () => switchView(n.dataset.view))
  );
  $('#btn-sync').addEventListener('click', sync);
  $('#btn-theme').addEventListener('click', () => {
    const next = state.settings.theme === 'dark' ? 'light' : 'dark';
    state.settings.theme = next;
    applyTheme(next);
    window.api.updateSettings({ theme: next });
    if (state.view === 'analytics') renderAnalytics(); // recolor charts
  });
  $('#search').addEventListener('input', (e) => {
    state.search = e.target.value.toLowerCase();
    if (state.view === 'dashboard') renderDashboard();
    if (state.view === 'board') renderBoard();
  });
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  state.settings.theme = theme;
}

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  $('#view-title').textContent =
    { dashboard: 'Dashboard', board: 'Board', analytics: 'Analytics', settings: 'Settings' }[view];
  if (view === 'dashboard') renderDashboard();
  if (view === 'board') renderBoard();
  if (view === 'analytics') renderAnalytics();
  if (view === 'settings') renderSettings();
}

function wireLiveEvents() {
  window.api.onApplicationsUpdated((payload) => {
    if (!payload || !payload.ok) return;
    state.applications = normalize(payload.applications);
    state.lastSync = payload.lastSync;
    renderAll();
    if (payload.changes && payload.changes.length) {
      toast(`Auto-sync: ${payload.changes.length} status change(s)`, 'ok');
    }
  });
  window.api.onSyncState(({ syncing }) => setSyncing(syncing));
}

/* ---------------- Data ---------------- */
async function sync() {
  setSyncing(true);
  const res = await window.api.sync();
  setSyncing(false);
  if (res.ok) {
    state.applications = normalize(res.applications);
    state.lastSync = res.lastSync;
    renderAll();
    toast(`Scanned ${res.scanned} emails · ${res.applications.length} applications`, 'ok');
  } else {
    toast(res.error || 'Sync failed', 'err');
    if (/reconnect|expired/i.test(res.error || '')) {
      await window.api.disconnect();
      show('setup');
      route();
    }
  }
}
function setSyncing(on) {
  const b = $('#btn-sync');
  if (!b) return;
  b.disabled = on;
  b.innerHTML = on ? '<span class="spin">↻</span> Syncing…' : '<span class="sync-ico">↻</span> Sync now';
}

async function applyOverride(key, patch) {
  const res = await window.api.override(key, patch);
  if (res.ok) {
    state.applications = normalize(res.applications);
    renderAll();
    if (state.openKey) refreshDrawer();
  }
}

/* ---------------- Shared helpers ---------------- */
function visibleApps() {
  return state.applications.filter((a) => !a.archived);
}
function matchesSearch(a) {
  if (!state.search) return true;
  return `${a.company} ${a.role || ''} ${a.latestSubject || ''}`.toLowerCase().includes(state.search);
}
function isStale(a) {
  const active = a.status !== 'offer' && a.status !== 'rejected';
  const days = (Date.now() - (a.lastUpdate || 0)) / 86400000;
  return active && days >= (state.settings.staleDays || 14);
}
function relDate(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function renderAll() {
  $('#acct-sync').textContent = state.lastSync ? `synced ${relDate(state.lastSync)}` : 'not synced';
  if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'board') renderBoard();
  else if (state.view === 'analytics') renderAnalytics();
  else if (state.view === 'settings') renderSettings();
}

/* ---------------- Dashboard ---------------- */
function renderDashboard() {
  const apps = visibleApps();
  const counts = { total: apps.length };
  STAGES.forEach((s) => (counts[s] = 0));
  apps.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
  const active = apps.filter((a) => a.status !== 'offer' && a.status !== 'rejected').length;
  const interviewing = counts.interview + counts.assessment;
  const stale = apps.filter(isStale);

  const tiles = [
    { n: counts.total, label: 'Total', cls: '' },
    { n: active, label: 'Active', cls: '' },
    { n: interviewing, label: 'Interviewing', cls: 's-interview' },
    { n: counts.offer, label: 'Offers', cls: 's-offer' },
    { n: counts.rejected, label: 'Rejected', cls: 's-rejected' },
  ];

  let html = `<div class="stat-row">${tiles
    .map(
      (t) =>
        `<div class="stat ${t.cls}"><div class="num" data-count="${t.n}">0</div><div class="label">${t.label}</div></div>`
    )
    .join('')}</div>`;

  if (stale.length) {
    html += `<div class="panel">
      <div class="panel-head"><h3>⏰ Time to follow up</h3><span class="hint">${stale.length} with no reply in ${state.settings.staleDays}+ days</span></div>
      ${stale
        .slice(0, 5)
        .map(
          (a) =>
            `<div class="app-row brdr-${a.status}" data-key="${esc(a.key)}"><div class="rmain"><div class="rco">${esc(a.company)}</div><div class="rrole">${esc(a.role || 'Role unknown')}</div></div><div class="rmeta"><span class="pill ${a.status}">${LABEL[a.status]}</span><span class="rdate">${relDate(a.lastUpdate)}</span></div></div>`
        )
        .join('')}
    </div>`;
  }

  const archivedCount = state.applications.filter((a) => a.archived).length;
  const filters = ['all', ...STAGES, ...(archivedCount ? ['archived'] : [])];
  html += `<div class="panel">
    <div class="panel-head">
      <h3>Applications</h3>
      <select id="sort-sel">
        <option value="recent">Most recent</option>
        <option value="oldest">Oldest</option>
        <option value="company">Company A–Z</option>
        <option value="stage">Stage</option>
      </select>
    </div>
    <div class="legend" id="filter-chips">
      ${filters
        .map((f) => {
          const label = f === 'all' ? 'All' : f === 'archived' ? 'Archived' : LABEL[f];
          const dot = f === 'all' ? 'var(--accent)' : f === 'archived' ? 'var(--text-3)' : stageColor(f);
          return `<span class="legend-item" style="cursor:pointer" data-filter="${f}"><span class="legend-dot" style="background:${dot}"></span>${label}</span>`;
        })
        .join('')}
    </div>
    <div id="app-list" style="margin-top:1rem"></div>
  </div>`;

  $('#view-dashboard').innerHTML = html;
  $('#sort-sel').value = state.sort;
  $('#sort-sel').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderList();
  });
  $$('#filter-chips .legend-item').forEach((c) =>
    c.addEventListener('click', () => {
      state.filter = c.dataset.filter;
      $$('#filter-chips .legend-item').forEach((x) => (x.style.fontWeight = ''));
      c.style.fontWeight = '700';
      renderList();
    })
  );
  animateCounts();
  renderList();
}

function renderList() {
  let apps;
  if (state.filter === 'archived') apps = state.applications.filter((a) => a.archived);
  else {
    apps = visibleApps();
    if (state.filter !== 'all') apps = apps.filter((a) => a.status === state.filter);
  }
  apps = sortApps(apps.filter(matchesSearch));

  const box = $('#app-list');
  if (!box) return;
  if (!apps.length) {
    box.innerHTML = `<div class="empty"><div class="big">🔍</div><p>No applications match.</p></div>`;
    return;
  }
  box.innerHTML = apps
    .map(
      (a, i) =>
        `<div class="app-row brdr-${a.status}" data-key="${esc(a.key)}" style="animation-delay:${Math.min(i * 30, 300)}ms">
          <div class="rmain">
            <div class="rco">${a.pinned ? '<span class="pin-badge">📌</span>' : ''}${esc(a.company)}${a.manualStatus ? ' <span class="hint">(manual)</span>' : ''}</div>
            <div class="rrole">${esc(a.role || 'Role unknown')}</div>
            <div class="rsub">${esc(a.latestSubject || '')}</div>
          </div>
          <div class="rmeta">
            ${isStale(a) ? '<span class="stale-badge">stale</span>' : ''}
            <span class="pill ${a.status}">${LABEL[a.status]}</span>
            <span class="rdate">${relDate(a.lastUpdate)}</span>
          </div>
        </div>`
    )
    .join('');
  $$('#app-list .app-row').forEach((r) =>
    r.addEventListener('click', () => openDrawer(r.dataset.key))
  );
}

function sortApps(apps) {
  const s = [...apps];
  if (state.sort === 'recent') s.sort((a, b) => (b.pinned - a.pinned) || b.lastUpdate - a.lastUpdate);
  else if (state.sort === 'oldest') s.sort((a, b) => a.lastUpdate - b.lastUpdate);
  else if (state.sort === 'company') s.sort((a, b) => a.company.localeCompare(b.company));
  else if (state.sort === 'stage') s.sort((a, b) => STAGE_RANK[a.status] - STAGE_RANK[b.status]);
  return s;
}

function animateCounts() {
  $$('.num[data-count]').forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    const start = performance.now();
    const dur = 650;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/* ---------------- Board (Kanban) ---------------- */
function renderBoard() {
  const apps = visibleApps().filter(matchesSearch);
  const cols = STAGES.filter((s) => s !== 'viewed' || apps.some((a) => a.status === 'viewed'));
  const html = `<div class="board">${cols
    .map((stage) => {
      const items = apps.filter((a) => a.status === stage);
      return `<div class="col" data-stage="${stage}">
        <div class="col-head"><span><span class="col-dot" style="background:${stageColor(stage)}"></span>${LABEL[stage]}</span><span class="col-count">${items.length}</span></div>
        <div class="col-body" data-stage="${stage}">
          ${
            items.length
              ? items
                  .map(
                    (a, i) =>
                      `<div class="kcard" draggable="true" data-key="${esc(a.key)}" style="animation-delay:${Math.min(i * 30, 250)}ms">
                        <div class="kco">${esc(a.company)} ${a.pinned ? '📌' : ''}</div>
                        <div class="krole">${esc(a.role || 'Role unknown')}</div>
                        <div class="kdate">${relDate(a.lastUpdate)} · ${a.emailCount} email${a.emailCount > 1 ? 's' : ''}</div>
                      </div>`
                  )
                  .join('')
              : '<div class="col-empty">Drop here</div>'
          }
        </div>
      </div>`;
    })
    .join('')}</div>`;
  $('#view-board').innerHTML = html;
  wireDnd();
  $$('#view-board .kcard').forEach((c) =>
    c.addEventListener('click', (e) => {
      if (!c.classList.contains('dragging')) openDrawer(c.dataset.key);
    })
  );
}

let dragKey = null;
function wireDnd() {
  $$('#view-board .kcard').forEach((card) => {
    card.addEventListener('dragstart', () => {
      dragKey = card.dataset.key;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragKey = null;
      card.classList.remove('dragging');
    });
  });
  $$('#view-board .col').forEach((col) => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      col.classList.add('dragover');
    });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      const stage = col.dataset.stage;
      if (dragKey && stage) {
        const app = state.applications.find((a) => a.key === dragKey);
        if (app && app.status !== stage) {
          applyOverride(dragKey, { manualStatus: stage });
          toast(`Moved ${app.company} → ${LABEL[stage]}`, 'ok');
        }
      }
    });
  });
}

/* ---------------- Analytics ---------------- */
function renderAnalytics() {
  const apps = visibleApps();
  if (!apps.length) {
    $('#view-analytics').innerHTML = `<div class="empty"><div class="big">📊</div><p>Sync some applications to see analytics.</p></div>`;
    return;
  }
  const total = apps.length;
  const reached = (stage) => apps.filter((a) => (a.reachedStages || []).includes(stage)).length;
  const responded = apps.filter((a) =>
    (a.reachedStages || []).some((s) => ['assessment', 'interview', 'offer', 'rejected'].includes(s))
  ).length;
  const interviewed = apps.filter((a) =>
    (a.reachedStages || []).some((s) => ['interview', 'offer'].includes(s))
  ).length;
  const offers = reached('offer');

  // avg days to first response
  let respDays = [];
  for (const a of apps) {
    const first = (a.history || []).find((h) =>
      ['assessment', 'interview', 'offer', 'rejected'].includes(h.status)
    );
    if (first && a.firstSeen) respDays.push((first.date - a.firstSeen) / 86400000);
  }
  const avgResp = respDays.length ? Math.max(0, Math.round(respDays.reduce((x, y) => x + y, 0) / respDays.length)) : null;

  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const kpis = [
    { n: `${pct(responded)}%`, label: 'Response rate' },
    { n: `${pct(interviewed)}%`, label: 'Interview rate' },
    { n: `${pct(offers)}%`, label: 'Offer rate' },
    { n: avgResp == null ? '—' : `${avgResp}d`, label: 'Avg. time to reply' },
  ];

  // funnel
  const funnelCounts = FUNNEL.map((s) => (s === 'applied' ? total : reached(s)));
  const funnelMax = Math.max(...funnelCounts, 1);

  // status distribution
  const dist = STAGES.map((s) => ({ s, n: apps.filter((a) => a.status === s).length })).filter((d) => d.n);

  // over time (by month of firstSeen)
  const byMonth = {};
  apps.forEach((a) => {
    if (!a.firstSeen) return;
    const d = new Date(a.firstSeen);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth[key] = (byMonth[key] || 0) + 1;
  });
  const months = Object.keys(byMonth).sort().slice(-12);

  $('#view-analytics').innerHTML = `
    <div class="stat-row">${kpis
      .map((k) => `<div class="stat"><div class="num">${k.n}</div><div class="label">${k.label}</div></div>`)
      .join('')}</div>
    <div class="charts-grid">
      <div class="panel">
        <div class="panel-head"><h3>Pipeline funnel</h3></div>
        ${FUNNEL.map((s, i) => {
          const n = funnelCounts[i];
          const w = Math.round((n / funnelMax) * 100);
          return `<div class="funnel-row"><div class="funnel-label">${LABEL[s]}</div><div class="funnel-track"><div class="funnel-fill" style="background:${stageColor(s)};width:0" data-w="${w}">${n}</div></div><div class="funnel-num">${pct(n)}%</div></div>`;
        }).join('')}
      </div>
      <div class="panel">
        <div class="panel-head"><h3>Status breakdown</h3></div>
        ${donutSvg(dist, total)}
        <div class="legend">${dist
          .map((d) => `<span class="legend-item"><span class="legend-dot" style="background:${stageColor(d.s)}"></span>${LABEL[d.s]} · ${d.n}</span>`)
          .join('')}</div>
      </div>
      <div class="panel" style="grid-column:1/-1">
        <div class="panel-head"><h3>Applications over time</h3><span class="hint">by month applied</span></div>
        ${months.length ? areaSvg(months.map((m) => byMonth[m]), months) : '<p class="muted">Not enough data yet.</p>'}
      </div>
    </div>`;

  // animate funnel fills
  requestAnimationFrame(() => {
    $$('#view-analytics .funnel-fill').forEach((f) => (f.style.width = f.dataset.w + '%'));
  });
}

function donutSvg(dist, total) {
  const r = 60;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segs = dist
    .map((d) => {
      const frac = d.n / total;
      const len = frac * c;
      const seg = `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${stageColor(d.s)}" stroke-width="22" stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 90 90)"><title>${LABEL[d.s]}: ${d.n}</title></circle>`;
      offset += len;
      return seg;
    })
    .join('');
  return `<svg viewBox="0 0 180 180" class="chart-svg" style="max-width:220px;margin:0 auto">
    ${segs}
    <text x="90" y="86" text-anchor="middle" style="fill:var(--text);font-size:26px;font-weight:700">${total}</text>
    <text x="90" y="104" text-anchor="middle" style="fill:var(--text-3);font-size:11px">total</text>
  </svg>`;
}

function areaSvg(vals, labels) {
  const W = 720, H = 180, pad = 26;
  const max = Math.max(...vals, 1);
  const n = vals.length;
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, n - 1);
  const y = (v) => H - pad - (v / max) * (H - pad * 2);
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(n - 1).toFixed(1)} ${H - pad} L${x(0).toFixed(1)} ${H - pad} Z`;
  const col = cssVar('--accent-2');
  const dots = vals
    .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5" fill="${col}"><title>${labels[i]}: ${v}</title></circle>`)
    .join('');
  const ticks = labels
    .map((l, i) => (n <= 8 || i % 2 === 0 ? `<text class="bar-x" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${l.slice(2)}</text>` : ''))
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart-svg">
    <defs><linearGradient id="ag" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.35"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#ag)"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2"/>
    ${dots}${ticks}
  </svg>`;
}

/* ---------------- Settings ---------------- */
function renderSettings() {
  const s = state.settings;
  $('#view-settings').innerHTML = `
    <div class="panel" style="max-width:640px">
      <div class="panel-head"><h3>Preferences</h3></div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Appearance</div><div class="d">Switch between dark and light.</div></div>
        <label class="switch"><input type="checkbox" id="set-theme" ${s.theme === 'dark' ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Desktop notifications</div><div class="d">Alert me when an application changes status.</div></div>
        <label class="switch"><input type="checkbox" id="set-notif" ${s.notifications ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Auto-sync</div><div class="d">Check Gmail automatically in the background.</div></div>
        <select id="set-auto">
          <option value="0">Off</option>
          <option value="30">Every 30 min</option>
          <option value="60">Every hour</option>
          <option value="240">Every 4 hours</option>
          <option value="720">Every 12 hours</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Follow-up reminder</div><div class="d">Flag applications with no reply after this many days.</div></div>
        <select id="set-stale">
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="21">21 days</option>
          <option value="30">30 days</option>
        </select>
      </div>
    </div>

    <div class="panel" style="max-width:640px">
      <div class="panel-head"><h3>Data</h3></div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Export to CSV</div><div class="d">Download all applications as a spreadsheet.</div></div>
        <button id="set-export" class="btn">Export CSV</button>
      </div>
      <div class="setting-row">
        <div class="setting-info"><div class="t">Account</div><div class="d">${esc(s.account || '')}</div></div>
        <button id="set-disconnect" class="btn danger">Disconnect</button>
      </div>
    </div>

    <p class="muted" style="max-width:640px;font-size:0.8rem">Read-only access · everything is stored locally on this computer · no servers, no tracking.</p>`;

  $('#set-auto').value = String(s.autoSyncMinutes);
  $('#set-stale').value = String(s.staleDays);
  $('#set-theme').addEventListener('change', (e) => {
    const t = e.target.checked ? 'dark' : 'light';
    applyTheme(t);
    window.api.updateSettings({ theme: t });
  });
  $('#set-notif').addEventListener('change', (e) => {
    s.notifications = e.target.checked;
    window.api.updateSettings({ notifications: e.target.checked });
  });
  $('#set-auto').addEventListener('change', (e) => {
    s.autoSyncMinutes = Number(e.target.value);
    window.api.updateSettings({ autoSyncMinutes: s.autoSyncMinutes });
    toast('Auto-sync updated', 'ok');
  });
  $('#set-stale').addEventListener('change', (e) => {
    s.staleDays = Number(e.target.value);
    window.api.updateSettings({ staleDays: s.staleDays });
  });
  $('#set-export').addEventListener('click', async () => {
    const res = await window.api.exportCsv();
    if (res.ok) toast('Exported CSV', 'ok');
    else if (!res.canceled) toast(res.error || 'Export failed', 'err');
  });
  $('#set-disconnect').addEventListener('click', async () => {
    if (confirm('Disconnect and clear the local board? Your Google credentials stay saved.')) {
      await window.api.disconnect();
      state.applications = [];
      show('setup');
      route();
    }
  });
}

/* ---------------- Detail drawer ---------------- */
function openDrawer(key) {
  state.openKey = key;
  refreshDrawer();
  $('#drawer').classList.remove('hidden');
  $('#drawer-scrim').classList.remove('hidden');
}
function closeDrawer() {
  state.openKey = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-scrim').classList.add('hidden');
}
function refreshDrawer() {
  const a = state.applications.find((x) => x.key === state.openKey);
  if (!a) return closeDrawer();
  const hist = [...(a.history || [])].sort((x, y) => y.date - x.date);
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <button class="drawer-close" id="dclose">×</button>
      <div class="drawer-co">${esc(a.company)}</div>
      <div class="drawer-role">${esc(a.role || 'Role unknown')}</div>
    </div>
    <div class="drawer-body">
      <div class="field-label">Current status</div>
      <select id="d-status">
        <option value="__auto">↺ Auto-detected (${LABEL[a.autoStatus] || a.autoStatus})</option>
        ${STAGES.map((s) => `<option value="${s}" ${a.status === s && a.manualStatus ? 'selected' : ''}>${LABEL[s]}</option>`).join('')}
      </select>

      <div class="drawer-actions">
        <button class="btn" id="d-pin">${a.pinned ? '📌 Unpin' : '📌 Pin'}</button>
        <button class="btn" id="d-archive">${a.archived ? 'Unarchive' : 'Archive'}</button>
        ${a.latestThreadId ? '<button class="btn" id="d-gmail">✉ Open in Gmail</button>' : ''}
      </div>

      <div class="field-label">Notes</div>
      <textarea id="d-notes" placeholder="Add a private note (recruiter name, salary, next step…)">${esc(a.notes || '')}</textarea>
      <div style="margin-top:0.4rem"><button class="btn primary" id="d-save-notes">Save note</button></div>

      <div class="field-label">History · ${a.emailCount} email${a.emailCount > 1 ? 's' : ''}</div>
      <div class="timeline">
        ${
          hist.length
            ? hist
                .map(
                  (h) =>
                    `<div class="tl-item"><span class="tl-dot" style="background:${stageColor(h.status)}"></span><div class="tl-sub">${esc(h.subject || LABEL[h.status])}</div><div class="tl-date"><span class="pill ${h.status}" style="font-size:0.65rem">${LABEL[h.status]}</span> · ${h.date ? new Date(h.date).toLocaleDateString() : ''}</div></div>`
                )
                .join('')
            : '<p class="muted">No detailed history.</p>'
        }
      </div>
    </div>`;

  if (!a.manualStatus) $('#d-status').value = '__auto';
  else $('#d-status').value = a.status;

  $('#dclose').addEventListener('click', closeDrawer);
  $('#d-status').addEventListener('change', (e) => {
    const v = e.target.value;
    applyOverride(a.key, { manualStatus: v === '__auto' ? null : v });
    toast('Status updated', 'ok');
  });
  $('#d-pin').addEventListener('click', () => applyOverride(a.key, { pinned: !a.pinned }));
  $('#d-archive').addEventListener('click', () => {
    applyOverride(a.key, { archived: !a.archived });
    if (!a.archived) {
      toast(`Archived ${a.company}`, 'ok');
      closeDrawer();
    }
  });
  const g = $('#d-gmail');
  if (g) g.addEventListener('click', () => window.api.openGmailThread(a.latestThreadId));
  $('#d-save-notes').addEventListener('click', () => {
    applyOverride(a.key, { notes: $('#d-notes').value });
    toast('Note saved', 'ok');
  });
}

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}
