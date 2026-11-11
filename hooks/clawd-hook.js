#!/usr/bin/env node
// Claude Code hook -> MiniClawd event bus.
//
// Claude Code runs this for each hook event and pipes a JSON payload to stdin
// (session_id, cwd, hook_event_name, ...). We forward the useful bits to the
// localhost bus. This script must NEVER slow down or break Claude, so:
//   - it prints nothing and always exits 0
//   - it gives up after a very short timeout
//   - if the app isn't running the connection is refused immediately
const http = require('http');

const PORT = Number(process.env.CLAWD_PORT) || 47821;
const TIMEOUT_MS = 400;

let done = false;
function finish() {
  if (done) return;
  done = true;
  process.exit(0);
}
// Hard stop no matter what (stdin never closing, socket hanging, etc.).
setTimeout(finish, TIMEOUT_MS + 200).unref();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { if (input.length < 1 << 20) input += c; });
process.stdin.on('error', finish);
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(input); } catch { return finish(); }
  const event = d.hook_event_name || process.argv[2];
  if (typeof d.session_id !== 'string' || typeof event !== 'string') return finish();

  const body = JSON.stringify({
    session_id: d.session_id,
    event,
    cwd: typeof d.cwd === 'string' ? d.cwd : '',
    // The hook's parent is the shell/Claude process that launched us.
    pid: process.ppid,
  });
  const req = http.request(
    {
      host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    },
    (res) => { res.resume(); res.on('end', finish); }
  );
  req.on('timeout', () => { req.destroy(); finish(); });
  req.on('error', finish);
  req.end(body);
});
