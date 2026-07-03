'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');

const store = require('./store/store');
const auth = require('./gmail/auth');
const gmail = require('./gmail/client');
const { aggregate, diffStatuses } = require('./parser/aggregate');

let mainWindow = null;
let autoSyncTimer = null;
let syncing = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b1120',
    title: 'Job Application Tracker',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  scheduleAutoSync();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Core sync — shared by the manual button, the launch sync, and the scheduler.
// ---------------------------------------------------------------------------
async function doSync({ notify = true } = {}) {
  if (syncing) return { ok: false, error: 'A sync is already running.' };
  const credentials = store.getCredentials();
  const tokens = store.getTokens();
  if (!credentials || !tokens) return { ok: false, error: 'Not connected to Gmail.' };

  syncing = true;
  emit('sync:state', { syncing: true });
  try {
    const client = auth.clientFromTokens(credentials, tokens);
    client.on('tokens', (t) => store.setTokens({ ...store.getTokens(), ...t }));

    const settings = store.getSettings();
    const emails = await gmail.fetchApplicationEmails(client, {
      newerThanDays: settings.newerThanDays,
      maxResults: settings.maxResults,
    });

    const previous = store.getApplications();
    const applications = aggregate(emails, store.getOverrides());
    store.setApplications(applications);
    const lastSync = Date.now();
    store.setLastSync(lastSync);

    // Fire notifications for meaningful newly-detected status changes.
    const changes = diffStatuses(previous, applications);
    if (notify && settings.notifications && previous.length) {
      notifyChanges(changes);
    }

    const payload = { ok: true, applications, lastSync, scanned: emails.length, changes };
    emit('applications:updated', payload);
    return payload;
  } catch (err) {
    const msg = /invalid_grant/i.test(err.message)
      ? 'Your Gmail session expired. Please reconnect.'
      : err.message;
    return { ok: false, error: msg };
  } finally {
    syncing = false;
    emit('sync:state', { syncing: false });
  }
}

function notifyChanges(changes) {
  if (!Notification.isSupported() || !changes.length) return;
  const label = {
    offer: '🎉 Offer',
    interview: '📅 Interview',
    assessment: '📝 Assessment',
    rejected: '❌ Update',
  };
  // Summarize to avoid a burst of toasts on the first big sync.
  if (changes.length <= 3) {
    for (const c of changes) {
      new Notification({
        title: `${label[c.to] || 'Update'} — ${c.company}`,
        body: `Status moved to "${c.to}".`,
      }).show();
    }
  } else {
    new Notification({
      title: 'Job Application Tracker',
      body: `${changes.length} applications changed status. Open the app to review.`,
    }).show();
  }
}

function scheduleAutoSync() {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  const { autoSyncMinutes } = store.getSettings();
  if (!autoSyncMinutes || autoSyncMinutes <= 0) return;
  autoSyncTimer = setInterval(() => {
    if (store.getTokens()) doSync({ notify: true }).catch(() => {});
  }, autoSyncMinutes * 60 * 1000);
}

function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('app:status', async () => {
    const settings = store.getSettings();
    return {
      hasCredentials: store.hasCredentials(),
      isConnected: !!store.getTokens(),
      lastSync: store.getLastSync(),
      account: settings.account || null,
      settings,
    };
  });

  ipcMain.handle('credentials:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Google OAuth credentials.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      auth.createOAuthClient(parsed);
      store.setCredentials(parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('gmail:connect', async () => {
    const credentials = store.getCredentials();
    if (!credentials) return { ok: false, error: 'Import your credentials.json first.' };
    try {
      const { tokens, oAuth2Client } = await auth.authorize(credentials, (url) =>
        shell.openExternal(url)
      );
      store.setTokens(tokens);
      const profile = await gmail.getProfile(oAuth2Client);
      store.setSettings({ account: profile.emailAddress });
      scheduleAutoSync();
      return { ok: true, account: profile.emailAddress };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('applications:sync', async () => doSync({ notify: true }));

  ipcMain.handle('applications:get', async () => ({
    applications: store.getApplications(),
    lastSync: store.getLastSync(),
  }));

  // Persist a per-application override and apply it directly to the cached board
  // (no need to re-hit Gmail — the change is local to one record).
  ipcMain.handle('applications:override', async (_e, { key, patch }) => {
    if (!key) return { ok: false, error: 'missing key' };
    store.setOverride(key, patch || {});
    const applications = store.getApplications();
    const rec = applications.find((a) => a.key === key);
    if (rec) {
      const ov = store.getOverrides()[key] || {};
      rec.notes = ov.notes || '';
      rec.archived = !!ov.archived;
      rec.pinned = !!ov.pinned;
      rec.manualStatus = ov.manualStatus || null;
      rec.status = ov.manualStatus || rec.autoStatus;
    }
    applications.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastUpdate - a.lastUpdate;
    });
    store.setApplications(applications);
    return { ok: true, applications };
  });

  ipcMain.handle('settings:update', async (_e, partial) => {
    const next = store.setSettings(partial || {});
    if ('autoSyncMinutes' in (partial || {})) scheduleAutoSync();
    return next;
  });

  ipcMain.handle('gmail:disconnect', async () => {
    store.reset();
    if (autoSyncTimer) clearInterval(autoSyncTimer);
    return { ok: true };
  });

  ipcMain.handle('data:exportCsv', async () => {
    const apps = store.getApplications();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export applications to CSV',
      defaultPath: 'job-applications.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, toCsv(apps), 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:openGmailThread', async (_e, threadId) => {
    if (threadId) shell.openExternal(`https://mail.google.com/mail/u/0/#all/${threadId}`);
  });

  ipcMain.handle('shell:open', async (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

function toCsv(apps) {
  const header = ['Company', 'Role', 'Status', 'Emails', 'First seen', 'Last update', 'Notes'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = apps.map((a) =>
    [
      a.company,
      a.role || '',
      a.status,
      a.emailCount,
      a.firstSeen ? new Date(a.firstSeen).toISOString().slice(0, 10) : '',
      a.lastUpdate ? new Date(a.lastUpdate).toISOString().slice(0, 10) : '',
      a.notes || '',
    ]
      .map(esc)
      .join(',')
  );
  return [header.map(esc).join(','), ...rows].join('\r\n');
}
