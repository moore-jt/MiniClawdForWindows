import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clawd', {
  onSessions: (cb: (sessions: unknown[]) => void) =>
    ipcRenderer.on('sessions:init', (_e, s) => cb(s)),
  onChange: (cb: (change: unknown) => void) =>
    ipcRenderer.on('sessions:change', (_e, c) => cb(c)),
  ready: () => ipcRenderer.send('renderer:ready'),
});
