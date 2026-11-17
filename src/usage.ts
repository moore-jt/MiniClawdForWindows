import * as fs from 'fs';

/**
 * Token usage for one Claude Code session, read from its transcript JSONL.
 * The transcript format is internal and undocumented, so every field is optional and
 * anything unexpected is skipped rather than thrown.
 */
export interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export interface UsageTotals extends Counts {
  /** Model of the latest main-thread turn. */
  model: string | null;
  /** Assistant messages counted (after dedupe). */
  turns: number;
  /** Latest main-thread turn's input + cache tokens: how full the context window is. */
  contextTokens: number;
  /** Tokens split by model, for cost (a session can switch models). */
  byModel: Record<string, Counts>;
}

export const zeroCounts = (): Counts => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
export function addCounts(into: Counts, c: Counts, sign = 1) {
  into.input += sign * c.input;
  into.output += sign * c.output;
  into.cacheRead += sign * c.cacheRead;
  into.cacheCreate += sign * c.cacheCreate;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** One assistant line's usage, or null for anything else (malformed, user lines, no usage). */
export interface UsageLine {
  id: string | null;
  model: string;
  counts: Counts;
  sidechain: boolean;
  /** ms epoch, or null */
  ts: number | null;
  cwd: string | null;
}

export function parseUsageLine(line: string): UsageLine | null {
  if (!line.trim()) return null;
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null; // malformed or half-written line
  }
  const msg = d?.message;
  const u = msg?.usage;
  if (d?.type !== 'assistant' || !u || typeof u !== 'object') return null;
  // Claude Code's own placeholder messages (errors, interruptions), not model output.
  if (msg.model === '<synthetic>') return null;
  const ts = typeof d.timestamp === 'string' ? Date.parse(d.timestamp) : NaN;
  return {
    id: typeof msg.id === 'string' && msg.id ? msg.id : null,
    model: typeof msg.model === 'string' && msg.model ? msg.model : 'unknown',
    counts: {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreate: num(u.cache_creation_input_tokens),
    },
    sidechain: d.isSidechain === true,
    ts: Number.isFinite(ts) ? ts : null,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : null,
  };
}

/** Accumulates usage from transcript text. Feed it complete lines only (see TranscriptReader). */
export class UsageAccumulator {
  private byId = new Map<string, { model: string; counts: Counts }>();
  private extra = new Map<string, Counts>(); // lines without an id, by model
  private extraTurns = 0;
  private model: string | null = null;
  private contextTokens = 0;

  /** Returns false if the line was not an assistant usage line. */
  addLine(line: string): boolean {
    const u = parseUsageLine(line);
    if (!u) return false;
    // Streamed messages repeat under the same id; the latest line wins.
    if (u.id) this.byId.set(u.id, { model: u.model, counts: u.counts });
    else {
      let c = this.extra.get(u.model);
      if (!c) this.extra.set(u.model, (c = zeroCounts()));
      addCounts(c, u.counts);
      this.extraTurns++;
    }
    // Subagent (sidechain) turns have their own context; don't let them move the fill gauge.
    if (!u.sidechain) {
      this.contextTokens = u.counts.input + u.counts.cacheRead + u.counts.cacheCreate;
      if (u.model !== 'unknown' && u.model !== '<synthetic>') this.model = u.model;
    }
    return true;
  }

  totals(): UsageTotals {
    const byModel: Record<string, Counts> = {};
    const add = (model: string, c: Counts) => addCounts((byModel[model] ??= zeroCounts()), c);
    for (const [m, c] of this.extra) add(m, c);
    for (const e of this.byId.values()) add(e.model, e.counts);
    const total = zeroCounts();
    for (const c of Object.values(byModel)) addCounts(total, c);
    return {
      model: this.model,
      ...total,
      turns: this.byId.size + this.extraTurns,
      contextTokens: this.contextTokens,
      byModel,
    };
  }
}

/**
 * Tails one transcript file: remembers the byte offset and only reads what was appended.
 * A trailing partial line (the writer is mid-write) is left for the next read.
 */
export class TranscriptReader {
  private offset = 0;
  private pending = Buffer.alloc(0);
  private acc = new UsageAccumulator();

  constructor(readonly file: string) {}

  async update(): Promise<UsageTotals | null> {
    let fh: fs.promises.FileHandle | null = null;
    try {
      fh = await fs.promises.open(this.file, 'r');
      const { size } = await fh.stat();
      if (size < this.offset) {
        // Truncated or replaced: start over.
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.acc = new UsageAccumulator();
      }
      while (this.offset < size) {
        const buf = Buffer.alloc(Math.min(1 << 20, size - this.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        if (bytesRead === 0) break;
        this.offset += bytesRead;
        this.consume(buf.subarray(0, bytesRead));
      }
      return this.acc.totals();
    } catch {
      return null; // missing or unreadable: the dashboard shows n/a
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  private consume(chunk: Buffer) {
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let nl: number;
    while ((nl = data.indexOf(0x0a)) >= 0) {
      this.acc.addLine(data.toString('utf8', 0, nl));
      data = data.subarray(nl + 1);
    }
    this.pending = Buffer.from(data); // copy so we don't pin the big chunk
  }
}

/** Context window size for a model id. Unknown models assume 200k; ids tagged [1m] get 1M. */
export function contextWindow(model: string | null): number {
  return model && /\[1m\]/i.test(model) ? 1_000_000 : 200_000;
}
