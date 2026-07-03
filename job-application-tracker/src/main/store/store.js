'use strict';

/**
 * Local persistence. Wraps electron-store (an on-disk JSON file in the OS user
 * data dir). Holds three things:
 *   - credentials : the user's Google OAuth client (credentials.json contents)
 *   - tokens      : the OAuth access/refresh tokens from the consent flow
 *   - applications: the last aggregated board so the UI loads instantly offline
 *
 * NOTE: tokens grant read access to the user's mail, so the store file should be
 * treated as sensitive. electron-store keeps it in the app's private userData
 * directory; we additionally never log token contents.
 */

let Store;
try {
  Store = require('electron-store');
} catch (_) {
  Store = null; // allows non-Electron unit tests to require this module
}

function createStore() {
  if (!Store) {
    // In-memory fallback (tests / no electron-store installed).
    const mem = {};
    return {
      get: (k, d) => (k in mem ? mem[k] : d),
      set: (k, v) => {
        mem[k] = v;
      },
      delete: (k) => {
        delete mem[k];
      },
    };
  }
  return new Store({ name: 'job-application-tracker' });
}

const store = createStore();

module.exports = {
  getCredentials: () => store.get('credentials', null),
  setCredentials: (c) => store.set('credentials', c),
  hasCredentials: () => !!store.get('credentials', null),

  getTokens: () => store.get('tokens', null),
  setTokens: (t) => store.set('tokens', t),
  clearTokens: () => store.delete('tokens'),

  getApplications: () => store.get('applications', []),
  setApplications: (a) => store.set('applications', a),

  getLastSync: () => store.get('lastSync', null),
  setLastSync: (ts) => store.set('lastSync', ts),

  getSettings: () => store.get('settings', { newerThanDays: 180, maxResults: 300 }),
  setSettings: (s) => store.set('settings', s),

  // Full reset (sign out + forget everything).
  reset: () => {
    store.delete('tokens');
    store.delete('applications');
    store.delete('lastSync');
  },
  _store: store,
};
