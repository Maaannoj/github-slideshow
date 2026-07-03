'use strict';

const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');

const store = require('./store/store');
const auth = require('./gmail/auth');
const gmail = require('./gmail/client');
const { aggregate } = require('./parser/aggregate');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0f172a',
    title: 'Job Application Tracker',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC — the renderer talks to the main process exclusively through these.
// ---------------------------------------------------------------------------
function registerIpc() {
  // Current connection / setup status for the UI to render the right screen.
  ipcMain.handle('app:status', async () => {
    return {
      hasCredentials: store.hasCredentials(),
      isConnected: !!store.getTokens(),
      lastSync: store.getLastSync(),
      account: store.getTokens() ? store.getSettings().account || null : null,
      settings: store.getSettings(),
    };
  });

  // Let the user pick their downloaded credentials.json.
  ipcMain.handle('credentials:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select your Google OAuth credentials.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = require('fs').readFileSync(filePaths[0], 'utf8');
      const parsed = JSON.parse(raw);
      // Validate shape early so the user gets a clear error.
      auth.createOAuthClient(parsed);
      store.setCredentials(parsed);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Kick off the OAuth consent flow.
  ipcMain.handle('gmail:connect', async () => {
    const credentials = store.getCredentials();
    if (!credentials) return { ok: false, error: 'Import your credentials.json first.' };
    try {
      const { tokens, oAuth2Client } = await auth.authorize(credentials, (url) =>
        shell.openExternal(url)
      );
      store.setTokens(tokens);
      const profile = await gmail.getProfile(oAuth2Client);
      const settings = store.getSettings();
      settings.account = profile.emailAddress;
      store.setSettings(settings);
      return { ok: true, account: profile.emailAddress };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Pull mail, classify, aggregate, persist, and return the board.
  ipcMain.handle('applications:sync', async () => {
    const credentials = store.getCredentials();
    const tokens = store.getTokens();
    if (!credentials || !tokens) return { ok: false, error: 'Not connected to Gmail.' };

    try {
      const client = auth.clientFromTokens(credentials, tokens);
      // Persist refreshed tokens so we don't re-prompt for consent.
      client.on('tokens', (t) => {
        store.setTokens({ ...store.getTokens(), ...t });
      });

      const settings = store.getSettings();
      const emails = await gmail.fetchApplicationEmails(client, {
        newerThanDays: settings.newerThanDays,
        maxResults: settings.maxResults,
      });
      const applications = aggregate(emails);
      store.setApplications(applications);
      const lastSync = Date.now();
      store.setLastSync(lastSync);
      return { ok: true, applications, lastSync, scanned: emails.length };
    } catch (err) {
      const msg = /invalid_grant/i.test(err.message)
        ? 'Your Gmail session expired. Please reconnect.'
        : err.message;
      return { ok: false, error: msg };
    }
  });

  // Return the cached board without hitting the network.
  ipcMain.handle('applications:get', async () => {
    return { applications: store.getApplications(), lastSync: store.getLastSync() };
  });

  ipcMain.handle('settings:update', async (_e, partial) => {
    const next = { ...store.getSettings(), ...partial };
    store.setSettings(next);
    return next;
  });

  // Sign out — forget tokens and cached data, keep the credentials.json.
  ipcMain.handle('gmail:disconnect', async () => {
    store.reset();
    return { ok: true };
  });

  ipcMain.handle('shell:open', async (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}
