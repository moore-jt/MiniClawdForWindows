import { BrowserWindow, screen } from 'electron';
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

/** Where the bubble's tail points: screen coordinates of the top-center of a clawd. */
export interface Anchor {
  x: number;
  top: number;
}

const REFRESH_MS = 3000;
const WIDTH = 340; // includes the transparent margin that holds the drop shadow
const GAP = 4; // space between the tail tip and the clawd
const MARGIN = 6;
const TAIL_PAD = 24; // keep the tail this far from the bubble's rounded corners

/**
 * The dashboard: a small speech-bubble popover that grows out of a clawd. It is a frameless,
 * transparent window that closes as soon as it loses focus, so it never lingers on screen.
 */
export class Dashboard {
  private win: BrowserWindow | null = null;
  private anchor: Anchor | null = null;
  private height = 300;
  private readers = new Map<string, TranscriptReader>();
  private timer: NodeJS.Timeout | null = null;
  private lastClosed = { id: '', at: 0 };
  private openId = '';

  constructor(private store: SessionStore) {}

  /** Opens the bubble for a session; right-clicking the same clawd again closes it. */
  open(selectId?: string, anchor?: Anchor) {
    const id = selectId ?? this.store.list()[0]?.id ?? '';
    // Clicking the strip blurs (and so closes) the bubble just before this call arrives.
    if (this.lastClosed.id === id && Date.now() - this.lastClosed.at < 300) return;
    this.anchor = anchor ?? null;
    this.openId = id;

    if (this.win && !this.win.isDestroyed()) {
      this.place();
      this.win.webContents.send('dashboard:select', id);
      this.win.focus();
      return;
    }
    const win = new BrowserWindow({
      ...this.bounds(),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'dashboardPreload.js') },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver'); // same band as the strip, so it sits above it
    win.loadFile(path.join(__dirname, 'dashboard', 'index.html'), { query: { select: id, tail: String(this.tailX()) } });
    win.once('ready-to-show', () => {
      win.show();
      win.focus();
    });
    win.on('blur', () => this.close());
    win.on('closed', () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.win = null;
    });
    this.timer = setInterval(() => void this.push(), REFRESH_MS);
  }

  close() {
    if (!this.win || this.win.isDestroyed()) return;
    this.lastClosed = { id: this.openId, at: Date.now() };
    this.win.close();
  }

  /** The page reports its content height; resize while keeping the bottom edge (the tail) fixed. */
  fit(contentHeight: number) {
    if (!Number.isFinite(contentHeight)) return;
    this.height = Math.max(120, Math.min(Math.round(contentHeight), 700));
    this.place();
  }

  /** Called when sessions change so an open bubble updates immediately. */
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

  // ---- placement ----

  private workArea() {
    const pt = this.anchor ? { x: this.anchor.x, y: this.anchor.top } : screen.getPrimaryDisplay().workArea;
    return screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }).workArea;
  }

  private bounds() {
    const wa = this.workArea();
    const x = this.anchor
      ? Math.round(this.anchor.x - WIDTH / 2)
      : wa.x + wa.width - WIDTH - MARGIN; // from the tray: bottom-right, no tail
    const bottom = this.anchor ? this.anchor.top - GAP : wa.y + wa.height - MARGIN;
    return {
      x: Math.max(wa.x + MARGIN, Math.min(x, wa.x + wa.width - WIDTH - MARGIN)),
      y: Math.max(wa.y, bottom - this.height),
      width: WIDTH,
      height: this.height,
    };
  }

  /** Tail position inside the window (px from its left edge), or -1 for no tail. */
  private tailX(): number {
    if (!this.anchor) return -1;
    const rel = this.anchor.x - this.bounds().x;
    return Math.round(Math.max(TAIL_PAD, Math.min(rel, WIDTH - TAIL_PAD)));
  }

  private place() {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(this.bounds());
  }

  // ---- data ----

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
