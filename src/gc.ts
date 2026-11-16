import { SessionStore } from './sessions';
import { claudePidFor, isPidAlive } from './claudeSessions';

const SWEEP_MS = 15_000;
/** No claude pid known and no events for this long: assume the session is gone. */
const UNKNOWN_PID_TTL_MS = 4 * 60 * 60 * 1000;
/**
 * Esc-interrupting Claude may skip the Stop hook, leaving a clawd "working" forever.
 * With no event for this long, drop it back to idle. (Unverified: see PLAN.md.)
 */
const WORKING_TTL_MS = 15 * 60 * 1000;

/** Removes clawds whose Claude process died, and recovers ones stuck on "working". */
export function startSessionGc(store: SessionStore): () => void {
  const claudePids = new Map<string, number>(); // session id -> claude.exe pid, once seen

  const sweep = () => {
    const now = Date.now();
    store.removeWhere((s) => {
      let cpid = claudePids.get(s.id) ?? null;
      if (cpid === null) {
        cpid = claudePidFor(s.id);
        if (cpid !== null) claudePids.set(s.id, cpid);
      }
      if (cpid !== null) return !isPidAlive(cpid);
      return now - s.lastSeen > UNKNOWN_PID_TTL_MS;
    });
    for (const s of store.list()) {
      if (s.state === 'working' && now - s.lastSeen > WORKING_TTL_MS) store.setState(s.id, 'idle');
    }
    // Forget pids of sessions that are gone.
    const live = new Set(store.list().map((s) => s.id));
    for (const id of claudePids.keys()) if (!live.has(id)) claudePids.delete(id);
  };

  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();
  return () => clearInterval(timer);
}
