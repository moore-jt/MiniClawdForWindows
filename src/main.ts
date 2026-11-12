import { app, BrowserWindow, ipcMain, screen } from 'electron';
import * as path from 'path';
import { SessionStore } from './sessions';
import { startEventBus } from './eventBus';
import { focusSessionWindow, forgetSessionWindow, warmUpFocusHelper, stopFocusHelper, prefetchSessionWindow } from './windowFocus';

const STRIP_HEIGHT = 72; // 36px clawd + room above it for the hover tooltip

let strip: BrowserWindow | null = null;

const store = new SessionStore((change) => {
  if (change.type === 'remove') forgetSessionWindow(change.id);
  else prefetchSessionWindow(change.session.id, change.session.pid).catch(() => {});
  strip?.webContents.send('sessions:change', change);
});

// Renderer asks for the current sessions once its listeners are attached.
ipcMain.on('renderer:ready', (e) => e.sender.send('sessions:init', store.list()));

// Hit-testing: the window is click-through everywhere except while the pointer is over a clawd.
// Forwarded mouse-moves still reach the renderer while ignoring, so it can tell us when to switch.
ipcMain.on('strip:hover', (_e, over: boolean) => {
  strip?.setIgnoreMouseEvents(!over, { forward: true });
});

// Click on a clawd: raise the terminal window hosting that session.
ipcMain.handle('session:focus', (_e, id: unknown) => {
  const s = typeof id === 'string' ? store.list().find((x) => x.id === id) : undefined;
  return s ? focusSessionWindow(s.id, s.pid) : false;
});

/** Rectangle for the strip: full width of the work area, sitting just above the taskbar. */
function stripBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: workArea.x,
    y: workArea.y + workArea.height - STRIP_HEIGHT,
    width: workArea.width,
    height: STRIP_HEIGHT,
  };
}

function createStrip() {
  strip = new BrowserWindow({
    ...stripBounds(),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Stay above fullscreen-ish windows and the taskbar's z-order band.
  strip.setAlwaysOnTop(true, 'screen-saver');
  // Click-through; forward lets us add hover handling later.
  strip.setIgnoreMouseEvents(true, { forward: true });
  strip.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function reposition() {
  strip?.setBounds(stripBounds());
}

// Only one strip at a time: a second launch would fight over the port and cache.
if (!app.requestSingleInstanceLock()) {
  console.error('[clawd] already running; exiting this copy');
  app.quit();
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  createStrip();
  warmUpFocusHelper();
  startEventBus(store);
  // Re-pin when the taskbar, resolution or DPI changes.
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopFocusHelper);
