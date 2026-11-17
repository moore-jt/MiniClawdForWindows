import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addCounts, Counts, parseUsageLine, zeroCounts } from './usage';

/**
 * Historical usage rolled up from every transcript under ~/.claude/projects.
 * Each file is scanned incrementally (byte offset) and its totals are kept per file, bucketed by
 * local day and model, so a rewritten file can be dropped and rescanned on its own. Results are
 * cached to disk so startup is instant. The scan is async and yields between files and chunks,
 * so it never blocks the main thread for long.
 */
const CACHE_VERSION = 1;
const CHUNK = 1 << 20;

interface FileState {
  offset: number;
  /** Folder name shown for the project, from the first `cwd` seen. */
  project: string;
  /** day (YYYY-MM-DD, local) -> model -> counts */
  days: Record<string, Record<string, Counts>>;
  /** The previous assistant line: streamed blocks of one message repeat, the latest replaces it. */
  last: { id: string; day: string; model: string; counts: Counts } | null;
}

interface CacheFile {
  version: number;
  files: Record<string, FileState>;
}

export interface Slice {
  totals: Counts;
  /** model -> counts */
  byModel: Record<string, Counts>;
  /** project folder -> model -> counts */
  byProject: Record<string, Record<string, Counts>>;
}

export type Period = 'today' | 'week' | 'all';
export type Rollup = Record<Period, Slice>;

export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const folderOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

function* walk(dir: string, depth = 0): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3) yield* walk(full, depth + 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

export class RollupScanner {
  private state: CacheFile = { version: CACHE_VERSION, files: {} };
  private scanning = false;
  private dirty = false;

  /**
   * @param cacheFile where to persist the scan state
   * @param root directory holding the transcripts (default ~/.claude/projects)
   */
  constructor(private cacheFile: string, private root = path.join(os.homedir(), '.claude', 'projects')) {
    try {
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j?.version === CACHE_VERSION && j.files && typeof j.files === 'object') this.state = j;
    } catch { /* no cache yet, or unreadable: rescan from scratch */ }
  }

  get isScanning() {
    return this.scanning;
  }

  /** Scans for new transcript data. Safe to call repeatedly; overlapping calls are ignored. */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const seen = new Set<string>();
      for (const file of walk(this.root)) {
        seen.add(file);
        await this.scanFile(file);
        await tick();
      }
      // Transcripts Claude Code has deleted no longer count.
      for (const f of Object.keys(this.state.files)) {
        if (!seen.has(f)) {
          delete this.state.files[f];
          this.dirty = true;
        }
      }
      this.save();
    } finally {
      this.scanning = false;
    }
  }

  private async scanFile(file: string) {
    let fh: fs.promises.FileHandle | null = null;
    try {
      fh = await fs.promises.open(file, 'r');
      const { size } = await fh.stat();
      let st: FileState | undefined = this.state.files[file];
      if (st && size < st.offset) st = undefined; // rewritten: start over
      if (!st) st = this.state.files[file] = { offset: 0, project: '', days: {}, last: null };
      if (size === st.offset) return;

      let pending = Buffer.alloc(0);
      let pos = st.offset;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        let data = pending.length ? Buffer.concat([pending, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let nl: number;
        let consumed = 0;
        while ((nl = data.indexOf(0x0a, consumed)) >= 0) {
          this.addLine(st, data.toString('utf8', consumed, nl));
          consumed = nl + 1;
        }
        pending = Buffer.from(data.subarray(consumed));
        st.offset = pos - pending.length; // only advance past complete lines
        this.dirty = true;
        await tick();
      }
    } catch { /* unreadable file: skip, retry next scan */ } finally {
      await fh?.close().catch(() => {});
    }
  }

  private addLine(st: FileState, line: string) {
    const u = parseUsageLine(line);
    if (!u) {
      if (!st.project) {
        // Cheap project discovery from non-usage lines too.
        const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) {
          try { st.project = folderOf(JSON.parse(`"${m[1]}"`)); } catch { /* ignore */ }
        }
      }
      return;
    }
    if (u.cwd && !st.project) st.project = folderOf(u.cwd);
    if (u.ts === null) return;
    const day = localDay(u.ts);
    // A repeat of the previous message: take back the old numbers before adding the new ones.
    if (u.id && st.last?.id === u.id) {
      this.bucket(st, st.last.day, st.last.model, st.last.counts, -1);
    }
    this.bucket(st, day, u.model, u.counts, 1);
    st.last = u.id ? { id: u.id, day, model: u.model, counts: u.counts } : null;
  }

  private bucket(st: FileState, day: string, model: string, c: Counts, sign: 1 | -1) {
    const d = (st.days[day] ??= {});
    addCounts((d[model] ??= zeroCounts()), c, sign);
  }

  /** Aggregates the scanned data for today, the last 7 days (including today) and all time. */
  rollup(now = Date.now()): Rollup {
    const mk = (): Slice => ({ totals: zeroCounts(), byModel: {}, byProject: {} });
    const out: Rollup = { today: mk(), week: mk(), all: mk() };
    const today = localDay(now);
    const weekStart = localDay(now - 6 * 86_400_000);
    for (const st of Object.values(this.state.files)) {
      const project = st.project || 'unknown';
      for (const [day, models] of Object.entries(st.days)) {
        const periods: Period[] = ['all'];
        if (day >= weekStart && day <= today) periods.push('week');
        if (day === today) periods.push('today');
        for (const [model, c] of Object.entries(models)) {
          for (const p of periods) {
            const s = out[p];
            addCounts(s.totals, c);
            addCounts((s.byModel[model] ??= zeroCounts()), c);
            addCounts(((s.byProject[project] ??= {})[model] ??= zeroCounts()), c);
          }
        }
      }
    }
    return out;
  }

  private save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const tmp = this.cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      console.warn('[rollup] could not save cache:', (e as Error).message);
    }
  }
}
