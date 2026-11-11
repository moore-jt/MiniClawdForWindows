import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';

const STRIP_HEIGHT = 48;

let strip: BrowserWindow | null = null;

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
    webPreferences: { contextIsolation: true },
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

app.whenReady().then(() => {
  createStrip();
  // Re-pin when the taskbar, resolution or DPI changes.
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
});

app.on('window-all-closed', () => app.quit());
