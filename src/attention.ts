import * as fs from 'fs';
import type { Session } from './sessions';

export type Badge = 'needs-you' | 'done';

/** Most urgent thing waiting on the user: needs-you beats done; null when nothing is waiting. */
export function badgeFor(sessions: Pick<Session, 'state'>[]): Badge | null {
  if (sessions.some((s) => s.state === 'needs-you')) return 'needs-you';
  if (sessions.some((s) => s.state === 'done')) return 'done';
  return null;
}

/**
 * SHQueryUserNotificationState values that mean a fullscreen app (or presentation) owns the screen:
 * 2 busy (fullscreen), 3 running D3D fullscreen, 4 presentation mode.
 */
export function coversScreen(notificationState: number | null): boolean {
  return notificationState === 2 || notificationState === 3 || notificationState === 4;
}

const BADGE_RGB: Record<Badge, [number, number, number]> = {
  'needs-you': [240, 180, 40],
  done: [90, 200, 110],
};

/**
 * Paints a round dot with a dark rim into the bottom-right corner of a BGRA bitmap (as returned by
 * nativeImage.toBitmap on Windows). Returns a new buffer; the input is untouched.
 */
export function paintBadge(bitmap: Buffer, size: number, badge: Badge): Buffer {
  const out = Buffer.from(bitmap);
  const r = Math.max(3, Math.round(size * 0.3));
  const cx = size - r - 0.5, cy = size - r - 0.5;
  const [R, G, B] = BADGE_RGB[badge];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r + 1) continue;
      const i = (y * size + x) * 4;
      const rim = d > r - 0.5;
      out[i] = rim ? 30 : B;
      out[i + 1] = rim ? 30 : G;
      out[i + 2] = rim ? 30 : R;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** A boolean setting persisted as the presence of a file (same trick as hooks-opt-out). */
export class FlagFile {
  constructor(private file: string) {}
  get(): boolean {
    return fs.existsSync(this.file);
  }
  set(on: boolean) {
    try {
      if (on) fs.writeFileSync(this.file, 'on');
      else fs.rmSync(this.file, { force: true });
    } catch (e) {
      console.error('[clawd] could not save setting:', e);
    }
  }
}
