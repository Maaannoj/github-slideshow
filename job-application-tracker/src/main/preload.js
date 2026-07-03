'use strict';

/**
 * Secure bridge between the sandboxed renderer and the main process. Only the
 * whitelisted functions below are exposed on window.api.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // queries / actions
  status: () => ipcRenderer.invoke('app:status'),
  importCredentials: () => ipcRenderer.invoke('credentials:import'),
  connect: () => ipcRenderer.invoke('gmail:connect'),
  disconnect: () => ipcRenderer.invoke('gmail:disconnect'),
  sync: () => ipcRenderer.invoke('applications:sync'),
  getApplications: () => ipcRenderer.invoke('applications:get'),
  override: (key, patch) => ipcRenderer.invoke('applications:override', { key, patch }),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  exportCsv: () => ipcRenderer.invoke('data:exportCsv'),
  openGmailThread: (threadId) => ipcRenderer.invoke('shell:openGmailThread', threadId),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  // live events pushed from the main process (auto-sync, background updates)
  onApplicationsUpdated: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('applications:updated', handler);
    return () => ipcRenderer.removeListener('applications:updated', handler);
  },
  onSyncState: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('sync:state', handler);
    return () => ipcRenderer.removeListener('sync:state', handler);
  },
});
