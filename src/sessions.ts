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

/** Hook event name -> resulting state. SessionEnd is handled separately (removal). */
const EVENT_STATE: Record<string, ClawdState> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs-you',
  Stop: 'done',
};

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private onChange: (c: SessionChange) => void) {}

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /** Applies a hook event. Returns false if the event is unknown. */
  apply(id: string, event: string, cwd: string, pid: number | null): boolean {
    if (event === 'SessionEnd') {
      if (this.sessions.delete(id)) this.onChange({ type: 'remove', id });
      return true;
    }
    const state = EVENT_STATE[event];
    if (!state) return false;
    const session: Session = { id, state, cwd, pid, lastSeen: Date.now() };
    this.sessions.set(id, session);
    this.onChange({ type: 'upsert', session });
    return true;
  }
}
