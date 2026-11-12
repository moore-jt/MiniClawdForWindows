import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('clawd', {
  onSessions: (cb: (sessions: unknown[]) => void) =>
    ipcRenderer.on('sessions:init', (_e, s) => cb(s)),
  onChange: (cb: (change: unknown) => void) =>
    ipcRenderer.on('sessions:change', (_e, c) => cb(c)),
  hover: (over: boolean) => ipcRenderer.send('strip:hover', over),
  ready: () => ipcRenderer.send('renderer:ready'),
});
