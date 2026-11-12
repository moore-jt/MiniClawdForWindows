// Smoke test for the event bus. Start the app first (npm start), then:
//   node scripts/test-bus.js            -> adds two clawds, changes states, removes one
//   node scripts/test-bus.js clear      -> removes the test clawds
const http = require('http');

const PORT = Number(process.env.CLAWD_PORT) || 47821;

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/event', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = async (id, event, cwd) => {
  const status = await post({ session_id: id, event, cwd, pid: process.pid });
  console.log(`${id} ${event} -> ${status}`);
};

(async () => {
  if (process.argv[2] === 'clear') {
    await send('test-a', 'SessionEnd');
    await send('test-b', 'SessionEnd');
    return;
  }
  await send('test-a', 'SessionStart', 'C:\\projects\\alpha');
  await sleep(2500);
  await send('test-b', 'SessionStart', 'C:\\projects\\beta');
  await sleep(2500);
  await send('test-a', 'UserPromptSubmit', 'C:\\projects\\alpha');
  await sleep(2500);
  await send('test-b', 'Notification', 'C:\\projects\\beta');
  await sleep(2500);
  await send('test-a', 'Stop', 'C:\\projects\\alpha');
  await sleep(2500);
  await send('test-b', 'SessionEnd');
  console.log('bad event ->', await post({ session_id: 'x', event: 'Nope' }));
  console.log('bad body  ->', await post({ nope: true }));
  console.log('(test-a stays; run with "clear" to remove it)');
})().catch((e) => { console.error('Could not reach the bus. Is the app running?', e.message); process.exit(1); });
