// Installs or removes Mini Clawd's hooks in a Claude Code settings.json (dev checkout).
//
//   node scripts/hooks-installer.js install   [--settings <path>] [--dry-run]
//   node scripts/hooks-installer.js uninstall [--settings <path>] [--dry-run]
//
// Default settings file: ~/.claude/settings.json. Logic lives in src/hooksInstaller.ts
// (compiled to dist/), which the packaged app uses too.
const path = require('path');
const { applyHooks, defaultSettingsPath } = require('../dist/hooksInstaller');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const argv = process.argv.slice(2);
const action = argv[0];
if (action !== 'install' && action !== 'uninstall') {
  fail('Usage: hooks-installer.js <install|uninstall> [--settings <path>] [--dry-run]');
}
let settingsPath = defaultSettingsPath();
let dryRun = false;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--settings') settingsPath = path.resolve(argv[++i]);
  else if (argv[i] === '--dry-run') dryRun = true;
  else fail(`Unknown option: ${argv[i]}`);
}

try {
  const r = applyHooks(action, {
    settingsPath,
    dryRun,
    hookScript: path.resolve(__dirname, '..', 'hooks', 'clawd-hook.js'),
  });
  if (!r.changed) console.log(`No changes needed in ${r.settingsPath}`);
  else if (dryRun) console.log(`[dry run] would write ${r.settingsPath}:\n${r.preview}`);
  else {
    if (r.backup) console.log(`Backed up to ${r.backup}`);
    console.log(`${action === 'install' ? 'Installed' : 'Removed'} Mini Clawd hooks in ${r.settingsPath}`);
  }
} catch (e) {
  fail(e.message);
}
