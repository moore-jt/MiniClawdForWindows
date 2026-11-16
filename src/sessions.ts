export type ClawdState = 'idle' | 'working' | 'needs-you' | 'done';

export interface Session {
  id: string;
  state: ClawdState;
  cwd: string;
  pid: number | null;
  lastSeen: number;
}

export type SessionChange =
  | { type: 'upsert'; session: Session }
  | { type: 'remove'; id: string };

/** Extra fields the hook may send along with an event. */
export interface EventDetail {
  notificationType?: string;
  message?: string;
}

/** Hook event name -> resulting state. SessionEnd is handled separately (removal). */
const EVENT_STATE: Record<string, ClawdState> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs-you',
  Stop: 'done',
};

/** Notification types that really mean "Claude is blocked on you". */
const BLOCKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog']);

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private onChange: (c: SessionChange) => void) {}

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Applies a hook event. Returns false if the event is unknown. */
  apply(id: string, event: string, cwd: string, pid: number | null, detail: EventDetail = {}): boolean {
    if (event === 'SessionEnd') {
      if (this.sessions.delete(id)) this.onChange({ type: 'remove', id });
      return true;
    }
    const state = EVENT_STATE[event];
    if (!state) return false;
    if (event === 'Notification' && !this.isBlockingNotification(id, detail)) return true;
    const session: Session = { id, state, cwd, pid, lastSeen: Date.now() };
    this.sessions.set(id, session);
    this.onChange({ type: 'upsert', session });
    return true;
  }

  /**
   * Claude also sends Notification for the idle reminder ("waiting for your input") and for
   * things like auth success. Only permission/input prompts should flip a clawd to needs-you.
   */
  private isBlockingNotification(id: string, { notificationType, message }: EventDetail): boolean {
    if (notificationType) return BLOCKING_NOTIFICATIONS.has(notificationType);
    // Older Claude Code versions send no type: treat the idle reminder as noise once done.
    if (this.sessions.get(id)?.state === 'done' && /waiting for your input/i.test(message ?? '')) return false;
    return true;
  }

  removeWhere(pred: (s: Session) => boolean) {
    for (const s of this.list()) {
      if (pred(s) && this.sessions.delete(s.id)) this.onChange({ type: 'remove', id: s.id });
    }
  }

  /** Sets a session's state without touching its other fields (used by recovery timers). */
  setState(id: string, state: ClawdState) {
    const cur = this.sessions.get(id);
    if (!cur || cur.state === state) return;
    const session = { ...cur, state, lastSeen: Date.now() };
    this.sessions.set(id, session);
    this.onChange({ type: 'upsert', session });
  }
}
