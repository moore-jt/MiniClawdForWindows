// Installs or removes MiniClawd's hooks in a Claude Code settings.json.
//
//   node scripts/hooks-installer.js install   [--settings <path>] [--dry-run]
//   node scripts/hooks-installer.js uninstall [--settings <path>] [--dry-run]
//
// Default settings file: ~/.claude/settings.json. The merge is non-destructive:
// existing hooks are kept, only entries whose command contains MARKER are
// added/removed, and the original file is backed up before any write.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MARKER = 'clawd-hook.js';
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'];
const HOOK_SCRIPT = path.resolve(__dirname, '..', 'hooks', MARKER).replace(/\\/g, '/');
// Forward slashes + quotes work in both Git Bash and cmd, even with spaces in the path.
const COMMAND = `node "${HOOK_SCRIPT}"`;

function parseArgs(argv) {
  const args = { action: argv[0], settings: path.join(os.homedir(), '.claude', 'settings.json'), dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--settings') args.settings = path.resolve(argv[++i]);
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else fail(`Unknown option: ${argv[i]}`);
  }
  return args;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const isOurs = (h) => typeof h?.command === 'string' && h.command.includes(MARKER);

function load(file) {
  if (!fs.existsSync(file)) return { settings: {}, existed: false };
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { settings: text.trim() ? JSON.parse(text) : {}, existed: true };
  } catch (e) {
    fail(`Refusing to touch ${file}: it is not valid JSON (${e.message}). Fix it first.`);
  }
}

function install(settings) {
  if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    fail('settings.hooks has an unexpected shape; refusing to modify it.');
  }
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Drop any previous copy of ours (e.g. from a moved checkout), then add the current one.
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    kept.push({ hooks: [{ type: 'command', command: COMMAND, timeout: 2 }] });
    settings.hooks[event] = kept;
  }
  return settings;
}

function uninstall(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    const kept = settings.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.action !== 'install' && args.action !== 'uninstall') {
    fail('Usage: hooks-installer.js <install|uninstall> [--settings <path>] [--dry-run]');
  }
  const { settings, existed } = load(args.settings);
  const before = JSON.stringify(settings, null, 2);
  const after = JSON.stringify(args.action === 'install' ? install(settings) : uninstall(settings), null, 2);

  if (before === after) {
    console.log(`No changes needed in ${args.settings}`);
    return;
  }
  if (args.dryRun) {
    console.log(`[dry run] would write ${args.settings}:\n${after}`);
    return;
  }
  if (existed) {
    const backup = `${args.settings}.clawd-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(args.settings, backup);
    console.log(`Backed up to ${backup}`);
  } else {
    fs.mkdirSync(path.dirname(args.settings), { recursive: true });
  }
  fs.writeFileSync(args.settings, after + '\n');
  console.log(`${args.action === 'install' ? 'Installed' : 'Removed'} MiniClawd hooks in ${args.settings}`);
}

main();
