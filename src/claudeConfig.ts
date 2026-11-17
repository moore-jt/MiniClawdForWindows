import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Read-only, tolerant readers for the Claude Code configuration shown in the dashboard.
 * All of these files are Claude Code internals that can change shape, so every reader returns
 * whatever it could understand, never throws, and warns once per file when a file exists but
 * is not in the shape we expect. We never return `env` values (they commonly hold secrets).
 */
export type Source = 'user' | 'project' | 'plugin';

export interface PluginInfo {
  /** "name@marketplace" */
  id: string;
  enabled: boolean;
  version?: string;
  scope?: string;
}
export interface SkillInfo {
  name: string;
  source: Source;
}
export interface McpInfo {
  name: string;
  source: Source;
  /** "stdio", "http", "sse", ... when the entry says. */
  transport?: string;
}
export interface ClaudeConfig {
  model?: string;
  permissionMode?: string;
  /** Hook event names configured in settings.json (e.g. Stop, Notification). */
  hookEvents: string[];
  plugins: PluginInfo[];
  skills: SkillInfo[];
  mcpServers: McpInfo[];
}

const warned = new Set<string>();
function warnOnce(file: string, why: string) {
  if (warned.has(file)) return;
  warned.add(file);
  console.warn(`[claudeConfig] ${file}: ${why}; that part of the dashboard shows n/a. The format may have changed.`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses a JSON file. Returns undefined if it is missing, unreadable or not an object. */
function readJson(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined; // absent is normal
  }
  try {
    const j = JSON.parse(text);
    if (isObj(j)) return j;
    warnOnce(file, 'top level is not an object');
  } catch {
    warnOnce(file, 'not valid JSON');
  }
  return undefined;
}

/** `name:` from a SKILL.md's frontmatter, or null. */
export function skillNameFromMarkdown(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const n = m && /^name:\s*["']?([^\r\n"']+)["']?\s*$/m.exec(m[1]);
  return n ? n[1].trim() : null;
}

function readSkills(dir: string, source: Source): SkillInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    try {
      const text = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8');
      out.push({ name: skillNameFromMarkdown(text) ?? e.name, source });
    } catch { /* not a skill folder (e.g. "synced") */ }
  }
  return out;
}

function readMcp(file: string, source: Source, key = 'mcpServers'): McpInfo[] {
  const servers = readJson(file)?.[key];
  if (!isObj(servers)) return [];
  return Object.entries(servers).map(([name, v]) => ({
    name,
    source,
    transport: isObj(v) && typeof v.type === 'string' ? v.type : isObj(v) && typeof v.command === 'string' ? 'stdio' : undefined,
  }));
}

function readPlugins(claudeDir: string, enabled: Record<string, unknown>): PluginInfo[] {
  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'))?.plugins;
  const byId = new Map<string, PluginInfo>();
  if (isObj(installed)) {
    for (const [id, installs] of Object.entries(installed)) {
      const first = Array.isArray(installs) ? installs.find(isObj) : undefined;
      byId.set(id, {
        id,
        enabled: enabled[id] === true,
        version: typeof first?.version === 'string' ? first.version : undefined,
        scope: typeof first?.scope === 'string' ? first.scope : undefined,
      });
    }
  }
  // Enabled in settings but missing from the install list: still worth showing.
  for (const [id, on] of Object.entries(enabled)) if (!byId.has(id)) byId.set(id, { id, enabled: on === true });
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Reads the config relevant to a session. `cwd` is the session's working directory (for project
 * skills and .mcp.json); `home` is injectable for tests.
 */
export function readClaudeConfig(cwd?: string, home = os.homedir()): ClaudeConfig {
  const claudeDir = path.join(home, '.claude');
  const settings = readJson(path.join(claudeDir, 'settings.json')) ?? {};
  const enabled = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {};

  const skills = readSkills(path.join(claudeDir, 'skills'), 'user');
  const mcpServers = readMcp(path.join(home, '.claude.json'), 'user');
  if (cwd) {
    skills.push(...readSkills(path.join(cwd, '.claude', 'skills'), 'project'));
    mcpServers.push(...readMcp(path.join(cwd, '.mcp.json'), 'project'));
  }

  return {
    model: typeof settings.model === 'string' ? settings.model : undefined,
    permissionMode: isObj(settings.permissions) && typeof settings.permissions.defaultMode === 'string' ? settings.permissions.defaultMode : undefined,
    hookEvents: isObj(settings.hooks) ? Object.keys(settings.hooks) : [],
    plugins: readPlugins(claudeDir, enabled),
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    mcpServers,
  };
}
