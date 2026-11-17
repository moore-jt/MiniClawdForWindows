// Installs or removes Mini Clawd's hooks in a Claude Code settings.json.
//
// The merge is non-destructive: existing hooks are kept, only entries whose
// command contains MARKER are added/removed, and the original file is backed up
// before any write. Used by the packaged app (first run / tray) and by
// scripts/hooks-installer.js (dev checkout).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MARKER = 'clawd-hook.js';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];

export const defaultSettingsPath = () => path.join(os.homedir(), '.claude', 'settings.json');

type Settings = Record<string, any>;

const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes(MARKER);

// Forward slashes + quotes work in both Git Bash and cmd, even with spaces in the path.
const commandFor = (hookScript: string) => `node "${path.resolve(hookScript).replaceAll('\\', '/')}"`;

function load(file: string): { settings: Settings; existed: boolean } {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { settings: text.trim() ? JSON.parse(text) : {}, existed: true };
  } catch (e: any) {
    throw new Error(`Refusing to touch ${file}: it is not valid JSON (${e.message}). Fix it first.`);
  }
}

function withoutOurs(groups: any[]): any[] {
  return groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h: any) => !isOurs(h)) }))
    .filter((g) => g.hooks.length > 0);
}

function addHooks(settings: Settings, hookScript: string): Settings {
  if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('settings.hooks has an unexpected shape; refusing to modify it.');
  }
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Drop any previous copy of ours (e.g. from a moved checkout), then add the current one.
    const kept = withoutOurs(groups);
    kept.push({ hooks: [{ type: 'command', command: commandFor(hookScript), timeout: 2 }] });
    settings.hooks[event] = kept;
  }
  return settings;
}

function removeHooks(settings: Settings): Settings {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const kept = withoutOurs(settings.hooks[event]);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

export interface HookResult {
  changed: boolean;
  settingsPath: string;
  backup?: string;
  /** Pretty-printed result; only set for dry runs. */
  preview?: string;
}

export function applyHooks(
  action: 'install' | 'uninstall',
  opts: { settingsPath?: string; hookScript?: string; dryRun?: boolean } = {},
): HookResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const { settings, existed } = load(settingsPath);
  const before = JSON.stringify(settings, null, 2);
  let next: Settings;
  if (action === 'install') {
    if (!opts.hookScript) throw new Error('hookScript is required to install');
    next = addHooks(settings, opts.hookScript);
  } else {
    next = removeHooks(settings);
  }
  const after = JSON.stringify(next, null, 2);
  if (before === after) return { changed: false, settingsPath };
  if (opts.dryRun) return { changed: true, settingsPath, preview: after };

  let backup: string | undefined;
  if (existed) {
    backup = `${settingsPath}.clawd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(settingsPath, backup);
  } else {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  }
  fs.writeFileSync(settingsPath, after + '\n');
  return { changed: true, settingsPath, backup };
}

/** True if settings.json already points at exactly this hook script for every event. */
export function hooksCurrent(hookScript: string, settingsPath = defaultSettingsPath()): boolean {
  try {
    return !applyHooks('install', { settingsPath, hookScript, dryRun: true }).changed;
  } catch {
    return false;
  }
}

/** Copies the hook script somewhere stable so moving/updating the app never breaks settings.json. */
export function stageHookScript(source: string, destDir: string): string {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, MARKER);
  fs.copyFileSync(source, dest);
  return dest;
}
