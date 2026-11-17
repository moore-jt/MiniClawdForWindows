interface Usage { model: string | null; input: number; output: number; cacheRead: number; cacheCreate: number; turns: number; contextTokens: number }
interface Sess { id: string; state: string; cwd: string; startedAt: number; usage: Usage | null; contextWindow: number }
interface Data { now: number; sessions: Sess[] }

declare const dash: {
  get(): Promise<Data>;
  onUpdate(cb: (d: Data) => void): void;
  onSelect(cb: (id: string) => void): void;
  fit(height: number): void;
  close(): void;
};

const $ = (id: string) => document.getElementById(id)!;
let data: Data = { now: Date.now(), sessions: [] };
const params = new URLSearchParams(location.search);
let selected = params.get('select') ?? '';

// Where the tail points (px from the window's left edge); -1 means no tail (opened from the tray).
const tailX = Number(params.get('tail') ?? -1);
if (tailX < 0) document.body.classList.add('no-tail');
else document.documentElement.style.setProperty('--tail', tailX + 'px');

const fmt = (n: number | undefined) => (n === undefined ? 'n/a' : n.toLocaleString());
const folder = (cwd: string, id: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? id.slice(0, 8);

function uptime(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render() {
  const s = data.sessions.find((x) => x.id === selected);
  $('empty').hidden = !!s;
  $('content').hidden = !s;
  if (s) {
    $('name').textContent = folder(s.cwd, s.id);
    $('name').title = s.cwd;
    const st = $('state');
    st.textContent = s.state;
    st.dataset.state = s.state;
    const u = s.usage;
    $('model').textContent = u?.model ?? 'n/a';
    $('turns').textContent = u ? fmt(u.turns) : 'n/a';
    $('uptime').textContent = uptime(data.now - s.startedAt);
    $('t-input').textContent = fmt(u?.input);
    $('t-output').textContent = fmt(u?.output);
    $('t-cread').textContent = fmt(u?.cacheRead);
    $('t-cwrite').textContent = fmt(u?.cacheCreate);
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
  // Let the window shrink-wrap the bubble (body padding included).
  dash.fit(document.body.scrollHeight);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dash.close(); });
dash.onSelect((id) => { selected = id; render(); });
dash.onUpdate((d) => { data = d; render(); });
dash.get().then((d) => { data = d; render(); });
setInterval(() => { data.now = Date.now(); render(); }, 30000); // keep uptime ticking
