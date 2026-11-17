interface Counts { input: number; output: number; cacheRead: number; cacheCreate: number }
interface Usage extends Counts { model: string | null; turns: number; contextTokens: number }
interface Cost { usd: number; partial: boolean }
interface Config {
  model?: string;
  permissionMode?: string;
  hookEvents: string[];
  plugins: { id: string; enabled: boolean; version?: string }[];
  skills: { name: string; source: string }[];
  mcpServers: { name: string; source: string; transport?: string }[];
}
interface Sess { id: string; state: string; cwd: string; startedAt: number; usage: Usage | null; cost: Cost | null; contextWindow: number; config: Config }
interface Row { name: string; tokens: number; cost: Cost }
interface Period { tokens: number; counts: Counts; cost: Cost; models: Row[]; projects: Row[] }
type PeriodKey = 'today' | 'week' | 'all';
interface Data { now: number; sessions: Sess[]; rollup: Record<PeriodKey, Period>; scanning: boolean }

declare const dash: {
  get(): Promise<Data>;
  onUpdate(cb: (d: Data) => void): void;
  onSelect(cb: (id: string) => void): void;
  fit(height: number): void;
  close(): void;
};

const $ = (id: string) => document.getElementById(id)!;
let data: Data | null = null;
const params = new URLSearchParams(location.search);
let selected = params.get('select') ?? '';
let tab = 'overview';
let period: PeriodKey = 'today';

// Where the tail points (px from the window's left edge); -1 means no tail (opened from the tray).
const tailX = Number(params.get('tail') ?? -1);
if (tailX < 0) document.body.classList.add('no-tail');
else document.documentElement.style.setProperty('--tail', tailX + 'px');

const fmt = (n: number | undefined) => (n === undefined ? 'n/a' : n.toLocaleString());
const folder = (cwd: string, id: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? id.slice(0, 8);

/** Compact token counts for tight spots: 1.2k, 3.4M. */
function short(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

/** Estimated dollars; "~" marks it as an estimate and "+" that some tokens had no price. */
function money(c: Cost | null | undefined): string {
  if (!c) return 'n/a';
  const v = c.usd < 0.01 && c.usd > 0 ? '<$0.01' : '$' + c.usd.toFixed(2);
  return '~' + v + (c.partial ? '+' : '');
}

function uptime(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function el(tag: string, text?: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function fillRows(table: HTMLElement, rows: Row[]) {
  table.replaceChildren();
  if (!rows.length) {
    const tr = el('tr');
    tr.append(el('td', 'Nothing yet', 'empty-row'));
    table.append(tr);
    return;
  }
  for (const r of rows) {
    const tr = el('tr');
    const name = el('td', r.name, 'name');
    name.title = r.name;
    tr.append(name, el('td', short(r.tokens)), el('td', money(r.cost), 'dim'));
    table.append(tr);
  }
}

function fillList(ul: HTMLElement, items: { text: string; on?: boolean; src?: string }[], emptyText: string) {
  ul.replaceChildren();
  if (!items.length) ul.append(el('li', emptyText, 'none'));
  for (const it of items) {
    const li = el('li');
    if (it.on === false) li.className = 'off';
    if (it.on !== undefined) li.append(el('i', undefined, 'dot'));
    const n = el('span', it.text, 'n');
    n.title = it.text;
    li.append(n);
    if (it.src) li.append(el('span', it.src, 'src'));
    ul.append(li);
  }
}

function renderOverview(s: Sess) {
  const u = s.usage;
  $('model').textContent = u?.model ?? 'n/a';
  $('turns').textContent = u ? fmt(u.turns) : 'n/a';
  $('uptime').textContent = uptime(data!.now - s.startedAt);
  $('t-input').textContent = fmt(u?.input);
  $('t-output').textContent = fmt(u?.output);
  $('t-cread').textContent = fmt(u?.cacheRead);
  $('t-cwrite').textContent = fmt(u?.cacheCreate);
  $('t-cost').textContent = money(s.cost);
  const bar = $('ctx-bar');
  if (u) {
    const pct = Math.min(100, (u.contextTokens / s.contextWindow) * 100);
    bar.style.width = pct + '%';
    bar.classList.toggle('high', pct >= 80);
    $('ctx-label').textContent = `${fmt(u.contextTokens)} / ${fmt(s.contextWindow)} (${pct.toFixed(0)}%)`;
  } else {
    bar.style.width = '0';
    $('ctx-label').textContent = 'n/a';
  }
  $('cwd').textContent = s.cwd;
}

function renderUsage() {
  const p = data!.rollup[period];
  $('u-tokens').textContent = short(p.tokens);
  $('u-tokens').title = fmt(p.tokens);
  $('u-cost').textContent = money(p.cost);
  fillRows($('u-models'), p.models);
  fillRows($('u-projects'), p.projects);
  $('u-note').textContent = data!.scanning
    ? 'Scanning your history...'
    : 'Estimated from token counts and an editable price table (prices.json in the app data folder).';
}

function renderExtras(s: Sess) {
  const c = s.config;
  const basics = $('x-basics');
  basics.replaceChildren();
  const row = (k: string, v: string) => {
    const tr = el('tr');
    tr.append(el('td', k), el('td', v));
    basics.append(tr);
  };
  row('Default model', c.model ?? 'n/a');
  row('Permission mode', c.permissionMode ?? 'n/a');
  row('Hooks', c.hookEvents.length ? c.hookEvents.join(', ') : 'none');
  fillList(
    $('x-plugins'),
    c.plugins.map((x) => ({ text: x.id, on: x.enabled, src: x.version })),
    'None installed'
  );
  fillList(
    $('x-skills'),
    c.skills.map((x) => ({ text: x.name, src: x.source })),
    'None found'
  );
  fillList(
    $('x-mcp'),
    c.mcpServers.map((x) => ({ text: x.name, src: x.source })),
    'None configured'
  );
}

function render() {
  if (!data) return;
  const s = data.sessions.find((x) => x.id === selected);
  $('empty').hidden = !!s;
  $('content').hidden = !s;
  if (s) {
    $('name').textContent = folder(s.cwd, s.id);
    $('name').title = s.cwd;
    const st = $('state');
    st.textContent = s.state;
    st.dataset.state = s.state;
    for (const b of document.querySelectorAll<HTMLElement>('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
    for (const p of document.querySelectorAll<HTMLElement>('.panel')) p.hidden = p.id !== tab;
    for (const b of document.querySelectorAll<HTMLElement>('#periods button')) b.classList.toggle('active', b.dataset.period === period);
    if (tab === 'overview') renderOverview(s);
    else if (tab === 'usage') renderUsage();
    else renderExtras(s);
  }
  // Let the window shrink-wrap the bubble (body padding included).
  dash.fit(document.body.scrollHeight);
}

$('tabs').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).dataset.tab;
  if (t) { tab = t; render(); }
});
$('periods').addEventListener('click', (e) => {
  const p = (e.target as HTMLElement).dataset.period as PeriodKey | undefined;
  if (p) { period = p; render(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dash.close(); });
dash.onSelect((id) => { selected = id; render(); });
dash.onUpdate((d) => { data = d; render(); });
dash.get().then((d) => { data = d; render(); });
setInterval(() => { if (data) { data.now = Date.now(); render(); } }, 30000); // keep uptime ticking
