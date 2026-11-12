interface Session { id: string; state: string; cwd: string }
type Change = { type: 'upsert'; session: Session } | { type: 'remove'; id: string };

declare const clawd: {
  onSessions(cb: (s: Session[]) => void): void;
  onChange(cb: (c: Change) => void): void;
  hover(over: boolean): void;
  ready(): void;
};

const strip = document.getElementById('strip')!;
const tip = document.getElementById('tip')!;
const SLOT = 56; // px between clawds
const order: string[] = [];

// Body colors, handed out in order to sessions (lowest free slot) so neighbors always differ.
// Orange is the classic clawd color, so the first session keeps it.
const PALETTE = ['#d9774f', '#4f9bd9', '#6cc070', '#c277d6', '#e0b33f', '#e0627a', '#4fc9c0', '#9a8cf0'];
const tintOf = new Map<string, number>();

function pickTint(id: string): string {
  const used = new Set(tintOf.values());
  let i = 0;
  while (used.has(i) && i < PALETTE.length) i++;
  tintOf.set(id, i);
  return PALETTE[i % PALETTE.length];
}

// ---- hover: tooltip + click-through hit-testing ----
let overClawd = false;
function liveClawdAt(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('.clawd:not(.leaving)') : null;
}
document.addEventListener('mousemove', (e) => {
  const el = liveClawdAt(e.target);
  const over = el !== null;
  if (over !== overClawd) {
    overClawd = over;
    clawd.hover(over); // main stops ignoring the mouse only while this is true
  }
  if (el) {
    tip.textContent = el.dataset.tip ?? '';
    tip.hidden = false;
    // Keep the tooltip inside the window.
    const x = Math.min(el.offsetLeft, document.documentElement.clientWidth - tip.offsetWidth - 4);
    tip.style.left = Math.max(2, x) + 'px';
  } else {
    tip.hidden = true;
  }
});
document.addEventListener('mouseleave', () => {
  tip.hidden = true;
  if (overClawd) { overClawd = false; clawd.hover(false); }
});

function layout() {
  order.forEach((id, i) => {
    const el = document.getElementById('c-' + id);
    if (el) el.style.left = 24 + i * SLOT + 'px';
  });
}

function upsert(s: Session) {
  const domId = 'c-' + s.id;
  let el = document.getElementById(domId);
  if (!el) {
    const tpl = document.getElementById('clawd-template') as HTMLTemplateElement;
    el = (tpl.content.firstElementChild as Element).cloneNode(true) as HTMLElement;
    el.id = domId;
    // Pop-in animation; the class is dropped when it ends so it can't fight state animations.
    el.classList.add('appear');
    el.addEventListener('animationend', (e) => {
      if (e.target === el && e.animationName === 'pop') el!.classList.remove('appear');
    });
    el.style.setProperty('--tint', pickTint(s.id));
    strip.appendChild(el);
    order.push(s.id);
  }
  el.dataset.state = s.state;
  const folder = (s.cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? s.id.slice(0, 8);
  el.setAttribute('data-tip', `${folder} · ${s.state}`);
  layout();
}

function remove(id: string) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  tintOf.delete(id);
  const el = document.getElementById('c-' + id);
  if (el) {
    // Free the id so a restarted session with the same id gets a fresh clawd,
    // then let this one walk off before deleting it.
    el.removeAttribute('id');
    el.classList.remove('appear');
    el.classList.add('leaving');
    el.addEventListener('animationend', (e) => {
      if (e.target === el && e.animationName === 'walk-off') el.remove();
    });
    setTimeout(() => el.remove(), 2000); // fallback if animationend never fires
  }
  layout();
}

clawd.onSessions((list) => list.forEach(upsert));
clawd.onChange((c) => (c.type === 'upsert' ? upsert(c.session) : remove(c.id)));
clawd.ready();
