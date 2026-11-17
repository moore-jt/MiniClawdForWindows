import * as fs from 'fs';

/**
 * Token usage for one Claude Code session, read from its transcript JSONL.
 * The transcript format is internal and undocumented, so every field is optional and
 * anything unexpected is skipped rather than thrown.
 */
export interface UsageTotals {
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** Assistant messages counted (after dedupe). */
  turns: number;
  /** Latest main-thread turn's input + cache tokens: how full the context window is. */
  contextTokens: number;
}

interface Counts {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** Accumulates usage from transcript text. Feed it complete lines only (see TranscriptReader). */
export class UsageAccumulator {
  private byId = new Map<string, Counts>();
  private extra: Counts = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }; // lines without an id
  private extraTurns = 0;
  private model: string | null = null;
  private contextTokens = 0;

  /** Returns false if the line was not an assistant usage line. */
  addLine(line: string): boolean {
    if (!line.trim()) return false;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return false; // malformed or half-written line
    }
    const msg = d?.message;
    const u = msg?.usage;
    if (d?.type !== 'assistant' || !u || typeof u !== 'object') return false;
    const c: Counts = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheCreate: num(u.cache_creation_input_tokens),
    };
    // Streamed messages repeat under the same id; the latest line wins.
    if (typeof msg.id === 'string' && msg.id) this.byId.set(msg.id, c);
    else {
      this.extra.input += c.input;
      this.extra.output += c.output;
      this.extra.cacheRead += c.cacheRead;
      this.extra.cacheCreate += c.cacheCreate;
      this.extraTurns++;
    }
    // Subagent (sidechain) turns have their own context; don't let them move the fill gauge.
    if (!d.isSidechain) {
      this.contextTokens = c.input + c.cacheRead + c.cacheCreate;
      if (typeof msg.model === 'string' && msg.model && msg.model !== '<synthetic>') this.model = msg.model;
    }
    return true;
  }

  totals(): UsageTotals {
    const t = { ...this.extra };
    for (const c of this.byId.values()) {
      t.input += c.input;
      t.output += c.output;
      t.cacheRead += c.cacheRead;
      t.cacheCreate += c.cacheCreate;
    }
    return {
      model: this.model,
      ...t,
      turns: this.byId.size + this.extraTurns,
      contextTokens: this.contextTokens,
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
