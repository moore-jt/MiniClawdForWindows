import { contextBridge, ipcRenderer } from 'electron';

// Read-only view of the app for the dashboard bubble; it can only ask to resize or close itself.
contextBridge.exposeInMainWorld('dash', {
  get: (): Promise<unknown> => ipcRenderer.invoke('dashboard:get'),
  onUpdate: (cb: (data: unknown) => void) => ipcRenderer.on('dashboard:update', (_e, d) => cb(d)),
  onSelect: (cb: (id: string) => void) => ipcRenderer.on('dashboard:select', (_e, id) => cb(id)),
  fit: (height: number) => ipcRenderer.send('dashboard:fit', height),
  close: () => ipcRenderer.send('dashboard:close'),
});
