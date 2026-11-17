import { BrowserWindow } from 'electron';
import * as path from 'path';
import { Session, SessionStore } from './sessions';
import { contextWindow, TranscriptReader, UsageTotals } from './usage';

export interface DashboardSession {
  id: string;
  state: string;
  cwd: string;
  startedAt: number;
  usage: UsageTotals | null;
  contextWindow: number;
}

export interface DashboardData {
  now: number;
  sessions: DashboardSession[];
}

const REFRESH_MS = 3000;

/** The dashboard BrowserWindow plus the per-session transcript readers behind it. */
export class Dashboard {
  private win: BrowserWindow | null = null;
  private readers = new Map<string, TranscriptReader>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private store: SessionStore) {}

  /** Opens the window, or focuses it if already open. */
  open(selectId?: string) {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
      if (selectId) this.win.webContents.send('dashboard:select', selectId);
      return;
    }
    const win = new BrowserWindow({
      width: 760,
      height: 560,
      minWidth: 520,
      minHeight: 400,
      title: 'Mini Clawd',
      backgroundColor: '#1b1b1f',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'dashboardPreload.js') },
    });
    this.win = win;
    win.loadFile(path.join(__dirname, 'dashboard', 'index.html'), selectId ? { query: { select: selectId } } : undefined);
    // Live updates while open.
    this.timer = setInterval(() => void this.push(), REFRESH_MS);
    win.on('closed', () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.win = null;
    });
  }

  /** Called when sessions change so an open window updates immediately. */
  notify() {
    if (this.win) void this.push();
  }

  forget(id: string) {
    this.readers.delete(id);
  }

  async snapshot(): Promise<DashboardData> {
    const sessions = await Promise.all(this.store.list().map((s) => this.describe(s)));
    return { now: Date.now(), sessions };
  }

  private async describe(s: Session): Promise<DashboardSession> {
    let usage: UsageTotals | null = null;
    if (s.transcriptPath) {
      let r = this.readers.get(s.id);
      if (!r || r.file !== s.transcriptPath) this.readers.set(s.id, (r = new TranscriptReader(s.transcriptPath)));
      usage = await r.update();
    }
    return {
      id: s.id,
      state: s.state,
      cwd: s.cwd,
      startedAt: s.startedAt,
      usage,
      contextWindow: contextWindow(usage?.model ?? null),
    };
  }

  private async push() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const data = await this.snapshot();
    if (!win.isDestroyed()) win.webContents.send('dashboard:update', data);
  }
}
