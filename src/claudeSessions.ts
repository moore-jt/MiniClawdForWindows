import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let warnedDrift = false;

/**
 * Claude Code keeps ~/.claude/sessions/<pid>.json for each live session ({pid, sessionId, ...}).
 * That gives us the long-lived claude process for a session with zero cost to Claude itself.
 * Internal, undocumented format: returns null if anything is off, and callers fall back.
 * Logs once if the directory has session files but none parse in the shape we expect.
 */
export function claudePidFor(sessionId: string): number | null {
  try {
    const dir = path.join(os.homedir(), '.claude', 'sessions');
    let parsedAny = false;
    let jsonFiles = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      jsonFiles++;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (typeof j.sessionId === 'string' && Number.isInteger(j.pid)) {
          parsedAny = true;
          if (j.sessionId === sessionId) return j.pid;
        }
      } catch { /* unreadable or half-written file: skip */ }
    }
    if (jsonFiles > 0 && !parsedAny && !warnedDrift) {
      warnedDrift = true;
      console.warn('[claudeSessions] ~/.claude/sessions has files but none match {pid, sessionId}; format may have changed. Click-to-focus and stale-session cleanup fall back to timeouts.');
    }
  } catch { /* no sessions dir */ }
  return null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
  }
}

/** When Claude Code says a session started (ms epoch), from ~/.claude/sessions/<pid>.json, or null. */
export function claudeStartedAt(sessionId: string): number | null {
  try {
    const dir = path.join(os.homedir(), '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.sessionId === sessionId && typeof j.startedAt === 'number' && j.startedAt > 0) return j.startedAt;
      } catch { /* unreadable or half-written file: skip */ }
    }
  } catch { /* no sessions dir */ }
  return null;
}

/**
 * Transcripts live at ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl. Used when a session's
 * hook events never carried transcript_path (e.g. it started before the hook was updated).
 */
export function findTranscript(sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null; // ids become a file name: no path tricks
  try {
    const root = path.join(os.homedir(), '.claude', 'projects');
    for (const d of fs.readdirSync(root)) {
      const file = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(file)) return file;
    }
  } catch { /* no projects dir */ }
  return null;
}
