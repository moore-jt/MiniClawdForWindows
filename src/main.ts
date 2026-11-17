import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, Tray } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { applyHooks, hooksCurrent, stageHookScript } from './hooksInstaller';
import { SessionStore } from './sessions';
import { Dashboard } from './dashboardWindow';
import { startEventBus } from './eventBus';
import { startSessionGc } from './gc';
import { focusSessionWindow, forgetSessionWindow, warmUpFocusHelper, stopFocusHelper, prefetchSessionWindow } from './windowFocus';

const STRIP_HEIGHT = 72; // 36px clawd + room above it for the hover tooltip

let strip: BrowserWindow | null = null;

const store = new SessionStore((change) => {
  if (change.type === 'remove') {
    forgetSessionWindow(change.id);
    dashboard?.forget(change.id);
  } else prefetchSessionWindow(change.session.id, change.session.pid).catch(() => {});
  strip?.webContents.send('sessions:change', change);
  dashboard?.notify();
});
const dashboard: Dashboard | null = new Dashboard(store, app.getPath('userData'));

// Right-click on a clawd (or tray "Dashboard...") opens the dashboard bubble. The renderer sends
// the clawd's rectangle in strip coordinates; the strip's own position turns that into screen pixels.
ipcMain.on('dashboard:open', (_e, id: unknown, rect: unknown) => {
  const r = rect as { x?: unknown; top?: unknown } | undefined;
  const b = strip?.getBounds();
  const anchor =
    b && typeof r?.x === 'number' && typeof r?.top === 'number'
      ? { x: b.x + r.x, top: b.y + r.top }
      : undefined;
  dashboard?.open(typeof id === 'string' ? id : undefined, anchor);
});
ipcMain.handle('dashboard:get', () => dashboard?.snapshot());
ipcMain.on('dashboard:fit', (_e, h: unknown) => typeof h === 'number' && dashboard?.fit(h));
ipcMain.on('dashboard:close', () => dashboard?.close());

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

// Kept in a module variable so the tray isn't garbage-collected (it would vanish).
let tray: Tray | null = null;

// ---- Claude Code hooks -------------------------------------------------------
// Packaged builds copy the hook script to userData so settings.json keeps working
// when the app is moved or updated. Dev checkouts point at hooks/ in the repo.
const bundledHook = () => path.join(__dirname, '..', 'hooks', 'clawd-hook.js');
const optOutFile = () => path.join(app.getPath('userData'), 'hooks-opt-out');

function activeHookScript(): string {
  return app.isPackaged ? stageHookScript(bundledHook(), path.join(app.getPath('userData'), 'hooks')) : bundledHook();
}

function hooksInstalled(): boolean {
  try {
    return hooksCurrent(activeHookScript());
  } catch {
    return false;
  }
}

function setHooks(on: boolean) {
  try {
    if (on) {
      fs.rmSync(optOutFile(), { force: true });
      applyHooks('install', { hookScript: activeHookScript() });
    } else {
      fs.writeFileSync(optOutFile(), 'user removed the hooks from the tray; do not reinstall automatically');
      applyHooks('uninstall');
    }
  } catch (e) {
    console.error('[clawd] hook install/uninstall failed:', e);
  }
}

/** Packaged first run (and after updates): wire up Claude Code unless the user opted out. */
function ensureHooks() {
  if (!app.isPackaged || fs.existsSync(optOutFile())) return;
  setHooks(true);
}

/** Dev runs are `electron <app path>`, so the login item must pass the app path too. */
function loginItemArgs() {
  return app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };
}

function launchesAtLogin(): boolean {
  return app.getLoginItemSettings(loginItemArgs()).openAtLogin;
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('Mini Clawd');
  const buildMenu = () =>
    Menu.buildFromTemplate([
      { label: 'Mini Clawd', enabled: false },
      { type: 'separator' },
      { label: 'Dashboard...', click: () => dashboard?.open() },
      {
        label: 'Clear done',
        click: () => store.removeWhere((s) => s.state === 'done'),
      },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: launchesAtLogin(),
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, ...loginItemArgs() }),
      },
      {
        label: 'Claude Code hooks',
        type: 'checkbox',
        checked: hooksInstalled(),
        click: (item) => setHooks(item.checked),
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
  // Rebuild on each open so the checkbox reflects the real login-item state.
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()));
  tray.on('click', () => tray?.popUpContextMenu(buildMenu()));
}

// Run by the uninstaller: take our hooks out of settings.json and exit without opening anything.
const removingHooks = process.argv.includes('--remove-hooks');
if (removingHooks) {
  try {
    applyHooks('uninstall');
  } catch (e) {
    console.error('[clawd] could not remove hooks:', e);
  }
  app.exit(0);
}

// Only one strip at a time: a second launch would fight over the port and cache.
if (!removingHooks && !app.requestSingleInstanceLock()) {
  console.error('[clawd] already running; exiting this copy');
  app.quit();
}

app.whenReady().then(() => {
  if (removingHooks || !app.hasSingleInstanceLock()) return;
  ensureHooks();
  createStrip();
  warmUpFocusHelper();
  startEventBus(store);
  startSessionGc(store);
  dashboard?.start();
  createTray();
  // Re-pin when the taskbar, resolution or DPI changes.
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
});

// The strip window lives for the whole run, so closing the dashboard must not quit the app.
app.on('window-all-closed', () => {});
app.on('will-quit', stopFocusHelper);
