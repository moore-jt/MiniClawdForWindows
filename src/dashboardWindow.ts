import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { Session, SessionStore } from './sessions';
import { ClaudeConfig, readClaudeConfig } from './claudeConfig';
import { claudeStartedAt, findTranscript } from './claudeSessions';
import { Cost, costOfModels, loadPrices, Price } from './pricing';
import { Period, RollupScanner, Slice } from './rollup';
import { addCounts, contextWindow, Counts, TranscriptReader, UsageTotals, zeroCounts } from './usage';

export interface DashboardSession {
  id: string;
  state: string;
  cwd: string;
  startedAt: number;
  usage: UsageTotals | null;
  /** Estimated cost of this session so far. */
  cost: Cost | null;
  contextWindow: number;
  config: ClaudeConfig;
}

export interface UsageRow {
  name: string;
  tokens: number;
  cost: Cost;
}
export interface PeriodSummary {
  tokens: number;
  counts: Counts;
  cost: Cost;
  models: UsageRow[];
  projects: UsageRow[];
}

export interface DashboardData {
  now: number;
  sessions: DashboardSession[];
  rollup: Record<Period, PeriodSummary>;
  scanning: boolean;
}

const sum = (c: Counts) => c.input + c.output + c.cacheRead + c.cacheCreate;
const TOP_ROWS = 6;
const SCAN_FIRST_MS = 3000;
const SCAN_EVERY_MS = 10 * 60 * 1000;
const CONFIG_TTL_MS = 30_000;
const LOOKUP_RETRY_MS = 15_000;

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

  private scanner: RollupScanner;
  private prices: Price[];
  private configs = new Map<string, { at: number; cfg: ClaudeConfig }>();
  /** Per-session facts we had to look up ourselves; retried at most every LOOKUP_RETRY_MS while missing. */
  private lookups = new Map<string, { at: number; transcript: string | null; startedAt: number | null }>();

  /** @param dataDir app data folder (cache and editable price table live here) */
  constructor(private store: SessionStore, dataDir: string) {
    this.prices = loadPrices(dataDir);
    this.scanner = new RollupScanner(path.join(dataDir, 'usage-cache.json'));
  }

  /** Starts the background history scan: soon after launch, then periodically. */
  start() {
    const run = () => this.scanner.scan().then(() => this.notify(), () => {});
    setTimeout(run, SCAN_FIRST_MS).unref();
    setInterval(run, SCAN_EVERY_MS).unref();
  }

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
    this.lookups.delete(id);
  }

  async snapshot(): Promise<DashboardData> {
    const sessions = await Promise.all(this.store.list().map((s) => this.describe(s)));
    return { now: Date.now(), sessions, rollup: this.summarize(), scanning: this.scanner.isScanning };
  }

  private summarize(): Record<Period, PeriodSummary> {
    const r = this.scanner.rollup();
    const one = (s: Slice): PeriodSummary => {
      const rows = (m: Record<string, Record<string, Counts>>): UsageRow[] =>
        Object.entries(m)
          .map(([name, byModel]) => {
            const t = zeroCounts();
            for (const c of Object.values(byModel)) addCounts(t, c);
            return { name, tokens: sum(t), cost: costOfModels(this.prices, byModel) };
          })
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, TOP_ROWS);
      return {
        tokens: sum(s.totals),
        counts: s.totals,
        cost: costOfModels(this.prices, s.byModel),
        models: rows(Object.fromEntries(Object.entries(s.byModel).map(([k, v]) => [k, { [k]: v }]))),
        projects: rows(s.byProject),
      };
    };
    return { today: one(r.today), week: one(r.week), all: one(r.all) };
  }

  private configFor(cwd: string): ClaudeConfig {
    const hit = this.configs.get(cwd);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const cfg = readClaudeConfig(cwd || undefined);
    this.configs.set(cwd, { at: Date.now(), cfg });
    return cfg;
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
    // Fill gaps from Claude Code's own files: sessions that began before we were listening
    // have no transcript path from the hooks and a "first seen" time that is too late.
    let look = this.lookups.get(s.id);
    if (!look || ((!look.transcript || !look.startedAt) && Date.now() - look.at > LOOKUP_RETRY_MS)) {
      look = {
        at: Date.now(),
        transcript: look?.transcript ?? findTranscript(s.id),
        startedAt: look?.startedAt ?? claudeStartedAt(s.id),
      };
      this.lookups.set(s.id, look);
    }
    const transcript = s.transcriptPath ?? look.transcript;
    let usage: UsageTotals | null = null;
    if (transcript) {
      let r = this.readers.get(s.id);
      if (!r || r.file !== transcript) this.readers.set(s.id, (r = new TranscriptReader(transcript)));
      usage = await r.update();
    }
    return {
      id: s.id,
      state: s.state,
      cwd: s.cwd,
      startedAt: Math.min(s.startedAt, look.startedAt ?? s.startedAt),
      usage,
      cost: usage ? costOfModels(this.prices, usage.byModel) : null,
      contextWindow: contextWindow(usage?.model ?? null),
      config: this.configFor(s.cwd),
    };
  }

  private async push() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const data = await this.snapshot();
    if (!win.isDestroyed()) win.webContents.send('dashboard:update', data);
  }
}
