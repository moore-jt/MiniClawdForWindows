// Copies non-TypeScript renderer assets into dist/.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'src', 'renderer');
const dest = path.join(__dirname, '..', 'dist', 'renderer');
fs.mkdirSync(dest, { recursive: true });
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.ts')) fs.copyFileSync(path.join(src, f), path.join(dest, f));
}
