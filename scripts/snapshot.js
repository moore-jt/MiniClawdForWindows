// Renders the real renderer in a hidden window, drives it with fake sessions, and saves
// zoomed PNGs so animations/layout can be checked without watching the screen.
//   npx electron scripts/snapshot.js <outDir>      (run `npm run build` first)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'clawd-snapshots'));
fs.mkdirSync(outDir, { recursive: true });
// Separate profile so this can run while the real app is running.
app.setPath('userData', path.join(os.tmpdir(), 'clawd-snapshot-profile'));

const ZOOM = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const session = (id, state, cwd) => ({ id, state, cwd, pid: null, lastSeen: 0 });

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 380 * ZOOM, height: 50 * ZOOM, show: false, backgroundColor: '#e8e8e8',
    webPreferences: { preload: path.join(__dirname, '..', 'dist', 'preload.js'), contextIsolation: true },
  });
  win.webContents.setZoomFactor(ZOOM);
  const send = (change) => win.webContents.send('sessions:change', change);
  const upsert = (id, state, cwd) => send({ type: 'upsert', session: session(id, state, cwd) });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name + '.png'), img.toPNG());
    console.log('saved', name, img.getSize());
  };

  await new Promise((resolve) => {
    ipcMain.once('renderer:ready', (e) => { e.sender.send('sessions:init', []); resolve(); });
    win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  });

  upsert('a', 'idle', 'C:\\p\\idle');
  upsert('b', 'working', 'C:\\p\\working');
  upsert('c', 'needs-you', 'C:\\p\\needs');
  upsert('d', 'done', 'C:\\p\\done');
  await sleep(150);  await shot('1-appearing');
  await sleep(450);  await shot('2-jumping-phase-a');
  await sleep(130);  await shot('3-phase-b');
  await sleep(2200); await shot('4-rest');
  send({ type: 'remove', id: 'b' });
  await sleep(500);  await shot('5-leaving');
  app.quit();
});
