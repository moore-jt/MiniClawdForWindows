import * as fs from 'fs';
import * as path from 'path';
import { Counts } from './usage';

/** US dollars per million tokens. */
export interface Price {
  /** Case-insensitive substring matched against the model id; first match wins. */
  match: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Starting prices, used to write prices.json the first time. They are an estimate: published
 * prices change and differ between model generations, so the file is meant to be edited.
 * Cache reads are billed at 0.1x input and 5-minute cache writes at 1.25x.
 */
export const DEFAULT_PRICES: Price[] = [
  { match: 'opus', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: 'sonnet', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'haiku', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

const FILE = 'prices.json';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Loads <dir>/prices.json, creating it with the defaults if absent. A broken file falls back to defaults. */
export function loadPrices(dir: string): Price[] {
  const file = path.join(dir, FILE);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(j?.models) ? j.models : [];
    const ok = list.filter(
      (p: any): p is Price =>
        typeof p?.match === 'string' && p.match && isNum(p.input) && isNum(p.output) && isNum(p.cacheRead) && isNum(p.cacheWrite)
    );
    if (ok.length) return ok;
    console.warn(`[pricing] ${file} has no usable entries; using the built-in defaults`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify(
            { note: 'Estimated USD per million tokens. Edit freely; restart Mini Clawd to apply. First matching entry wins.', models: DEFAULT_PRICES },
            null,
            2
          )
        );
      } catch { /* read-only profile: defaults still work */ }
    } else console.warn(`[pricing] could not read ${file}; using the built-in defaults`);
  }
  return DEFAULT_PRICES;
}

export function priceFor(prices: Price[], model: string): Price | null {
  const m = model.toLowerCase();
  return prices.find((p) => m.includes(p.match.toLowerCase())) ?? null;
}

/** Estimated dollars for token counts under a model, or null if the model has no price. */
export function costOf(prices: Price[], model: string, c: Counts): number | null {
  const p = priceFor(prices, model);
  if (!p) return null;
  return (c.input * p.input + c.output * p.output + c.cacheRead * p.cacheRead + c.cacheCreate * p.cacheWrite) / 1e6;
}

export interface Cost {
  usd: number;
  /** True if some of the tokens belong to models with no price, so usd is a lower bound. */
  partial: boolean;
}

/** Cost of a per-model token breakdown. */
export function costOfModels(prices: Price[], byModel: Record<string, Counts>): Cost {
  let usd = 0;
  let partial = false;
  for (const [model, c] of Object.entries(byModel)) {
    const x = costOf(prices, model, c);
    if (x === null) partial = true;
    else usd += x;
  }
  return { usd, partial };
}
