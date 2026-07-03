'use strict';

/**
 * Secure bridge between the sandboxed renderer and the main process. Only the
 * whitelisted functions below are exposed on window.api — no Node globals leak
 * into the page.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('app:status'),
  importCredentials: () => ipcRenderer.invoke('credentials:import'),
  connect: () => ipcRenderer.invoke('gmail:connect'),
  disconnect: () => ipcRenderer.invoke('gmail:disconnect'),
  sync: () => ipcRenderer.invoke('applications:sync'),
  getApplications: () => ipcRenderer.invoke('applications:get'),
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
