interface Session { id: string; state: string; cwd: string }
type Change = { type: 'upsert'; session: Session } | { type: 'remove'; id: string };

declare const clawd: {
  onSessions(cb: (s: Session[]) => void): void;
  onChange(cb: (c: Change) => void): void;
  ready(): void;
};

const strip = document.getElementById('strip')!;
const SLOT = 56; // px between clawds
const order: string[] = [];

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
    strip.appendChild(el);
    order.push(s.id);
  }
  el.dataset.state = s.state;
  el.setAttribute('data-tip', s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.id);
  layout();
}

function remove(id: string) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
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
