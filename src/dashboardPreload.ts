import { contextBridge, ipcRenderer } from 'electron';

// Read-only view of the app for the dashboard window; it has no way to change anything.
contextBridge.exposeInMainWorld('dash', {
  get: (selectedId?: string): Promise<unknown> => ipcRenderer.invoke('dashboard:get', selectedId),
  onUpdate: (cb: (data: unknown) => void) => ipcRenderer.on('dashboard:update', (_e, d) => cb(d)),
  onSelect: (cb: (id: string) => void) => ipcRenderer.on('dashboard:select', (_e, id) => cb(id)),
});
