interface Usage { model: string | null; input: number; output: number; cacheRead: number; cacheCreate: number; turns: number; contextTokens: number }
interface Sess { id: string; state: string; cwd: string; startedAt: number; usage: Usage | null; contextWindow: number }
interface Data { now: number; sessions: Sess[] }

declare const dash: {
  get(selectedId?: string): Promise<Data>;
  onUpdate(cb: (d: Data) => void): void;
  onSelect(cb: (id: string) => void): void;
};

const $ = (id: string) => document.getElementById(id)!;
const picker = $('picker') as HTMLSelectElement;
let data: Data = { now: Date.now(), sessions: [] };
let selected = new URLSearchParams(location.search).get('select') ?? '';

const fmt = (n: number | undefined) => (n === undefined ? 'n/a' : n.toLocaleString());
const folder = (cwd: string, id: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? id.slice(0, 8);

function uptime(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function render() {
  const { sessions } = data;
  $('empty').hidden = sessions.length > 0;
  $('content').hidden = sessions.length === 0;
  if (!sessions.some((s) => s.id === selected)) selected = sessions[0]?.id ?? '';

  // Rebuild picker options only when the set changed, so an open dropdown isn't disturbed.
  const sig = sessions.map((s) => s.id + folder(s.cwd, s.id)).join('|');
  if (picker.dataset.sig !== sig) {
    picker.dataset.sig = sig;
    picker.replaceChildren(
      ...sessions.map((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${folder(s.cwd, s.id)} (${s.id.slice(0, 8)})`;
        return o;
      })
    );
  }
  picker.value = selected;

  const s = sessions.find((x) => x.id === selected);
  if (!s) return;
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

picker.addEventListener('change', () => { selected = picker.value; render(); });
dash.onSelect((id) => { selected = id; render(); });
dash.onUpdate((d) => { data = d; render(); });
dash.get(selected).then((d) => { data = d; render(); });
setInterval(() => { data.now = Date.now(); render(); }, 30000); // keep uptime ticking
