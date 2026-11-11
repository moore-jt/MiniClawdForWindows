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
    strip.appendChild(el);
    order.push(s.id);
  }
  el.dataset.state = s.state;
  el.setAttribute('data-tip', s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.id);
  layout();
}

function remove(id: string) {
  document.getElementById('c-' + id)?.remove();
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  layout();
}

clawd.onSessions((list) => list.forEach(upsert));
clawd.onChange((c) => (c.type === 'upsert' ? upsert(c.session) : remove(c.id)));
clawd.ready();
