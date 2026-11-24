// Unit tests (run `npm test`; builds first). Uses the built output in dist/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore } = require('../dist/sessions');
const { UsageAccumulator, TranscriptReader, contextWindow } = require('../dist/usage');

const line = (o) => JSON.stringify(o);
const asst = (id, usage, extra = {}) =>
  line({ type: 'assistant', message: { id, model: 'claude-test', usage }, ...extra });

test('SessionStore keeps transcriptPath and startedAt across events', () => {
  const store = new SessionStore(() => {});
  store.apply('a', 'SessionStart', 'C:\\p', 1, { transcriptPath: 'C:\\t.jsonl' });
  const first = store.list()[0];
  assert.equal(first.transcriptPath, 'C:\\t.jsonl');
  store.apply('a', 'UserPromptSubmit', 'C:\\p', 1); // no path on this event
  const s = store.list()[0];
  assert.equal(s.state, 'working');
  assert.equal(s.transcriptPath, 'C:\\t.jsonl');
  assert.equal(s.startedAt, first.startedAt);
  store.setState('a', 'done');
  assert.equal(store.list()[0].transcriptPath, 'C:\\t.jsonl');
});

test('SessionStore transitions and non-blocking notifications', () => {
  const store = new SessionStore(() => {});
  store.apply('a', 'SessionStart', '', null);
  store.apply('a', 'Stop', '', null);
  store.apply('a', 'Notification', '', null, { notificationType: 'idle_prompt' });
  assert.equal(store.list()[0].state, 'done');
  store.apply('a', 'Notification', '', null, { notificationType: 'permission_prompt' });
  assert.equal(store.list()[0].state, 'needs-you');
  store.apply('a', 'SessionEnd', '', null);
  assert.equal(store.list().length, 0);
  assert.equal(store.apply('a', 'Bogus', '', null), false);
});

test('UsageAccumulator sums, dedupes streamed ids, and skips junk', () => {
  const acc = new UsageAccumulator();
  acc.addLine(asst('m1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }));
  // Same id streamed again: latest wins, not added twice.
  acc.addLine(asst('m1', { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }));
  acc.addLine(asst('m2', { input_tokens: 20, output_tokens: 7 }));
  assert.equal(acc.addLine('{not json'), false);
  assert.equal(acc.addLine(JSON.stringify({ type: 'assistant', message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 99 } } })), false);
  assert.equal(acc.addLine(line({ type: 'user', message: {} })), false);
  const t = acc.totals();
  assert.deepEqual(
    [t.input, t.output, t.cacheRead, t.cacheCreate, t.turns],
    [30, 57, 100, 5, 2]
  );
  assert.equal(t.model, 'claude-test');
  assert.equal(t.contextTokens, 20); // latest turn: 20 input, no cache
});

test('sidechain turns do not move context fill or model', () => {
  const acc = new UsageAccumulator();
  acc.addLine(asst('m1', { input_tokens: 1000 }));
  acc.addLine(asst('m2', { input_tokens: 5 }, { isSidechain: true }));
  const t = acc.totals();
  assert.equal(t.contextTokens, 1000);
  assert.equal(t.input, 1005); // still counted in totals
});

test('TranscriptReader tails incrementally and waits for half-written lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-'));
  const file = path.join(dir, 't.jsonl');
  try {
    const l1 = asst('m1', { input_tokens: 10, output_tokens: 2 });
    const l2 = asst('m2', { input_tokens: 4, output_tokens: 3 });
    fs.writeFileSync(file, l1 + '\n' + l2.slice(0, 20)); // second line half-written
    const r = new TranscriptReader(file);
    let t = await r.update();
    assert.equal(t.turns, 1);
    fs.appendFileSync(file, l2.slice(20) + '\n');
    t = await r.update();
    assert.equal(t.turns, 2);
    assert.equal(t.input, 14);
    // Truncation resets.
    fs.writeFileSync(file, asst('m9', { input_tokens: 1 }) + '\n');
    t = await r.update();
    assert.equal(t.turns, 1);
    assert.equal(t.input, 1);
    // Missing file degrades to null.
    assert.equal(await new TranscriptReader(path.join(dir, 'nope.jsonl')).update(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('contextWindow defaults to 200k', () => {
  assert.equal(contextWindow(null), 200000);
  assert.equal(contextWindow('claude-x[1m]'), 1000000);
});

test('readClaudeConfig reads settings, plugins, skills and MCP; tolerates junk; hides env', () => {
  const { readClaudeConfig, skillNameFromMarkdown } = require('../dist/claudeConfig');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-proj-'));
  const w = (f, c) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); };
  try {
    w(path.join(home, '.claude', 'settings.json'), JSON.stringify({
      model: 'sonnet', permissions: { defaultMode: 'plan' }, env: { SECRET: 'hunter2' },
      hooks: { Stop: [], Notification: [] }, enabledPlugins: { 'a@m': true, 'b@m': false, 'ghost@m': true },
    }));
    w(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2, plugins: { 'a@m': [{ scope: 'user', version: '1.2.3' }], 'b@m': [{ version: '0.1' }] },
    }));
    w(path.join(home, '.claude', 'skills', 'one', 'SKILL.md'), '---\nname: first-skill\ndescription: x\n---\nbody');
    w(path.join(home, '.claude', 'skills', 'two', 'SKILL.md'), 'no frontmatter');
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'synced')); // not a skill: skipped
    w(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { s1: { command: 'node' } } }));
    w(path.join(proj, '.mcp.json'), '{ broken json');
    w(path.join(proj, '.claude', 'skills', 'p', 'SKILL.md'), '---\nname: proj-skill\n---\n');

    const c = readClaudeConfig(proj, home);
    assert.equal(c.model, 'sonnet');
    assert.equal(c.permissionMode, 'plan');
    assert.deepEqual(c.hookEvents, ['Stop', 'Notification']);
    assert.deepEqual(c.plugins.map((p) => [p.id, p.enabled, p.version]), [['a@m', true, '1.2.3'], ['b@m', false, '0.1'], ['ghost@m', true, undefined]]);
    assert.deepEqual(c.skills.map((s) => [s.name, s.source]), [['first-skill', 'user'], ['proj-skill', 'project'], ['two', 'user']]);
    assert.deepEqual(c.mcpServers, [{ name: 's1', source: 'user', transport: 'stdio' }]);
    assert.ok(!JSON.stringify(c).includes('hunter2'));
    // Nothing exists at all: empty, no throw.
    assert.deepEqual(readClaudeConfig(undefined, path.join(home, 'nope')).plugins, []);
    assert.equal(skillNameFromMarkdown('---\nname: "quoted"\n---'), 'quoted');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('pricing: matches by substring, unknown models are partial, bad file falls back', () => {
  const { loadPrices, costOf, costOfModels, DEFAULT_PRICES } = require('../dist/pricing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-price-'));
  try {
    const prices = loadPrices(dir); // creates prices.json
    assert.ok(fs.existsSync(path.join(dir, 'prices.json')));
    assert.deepEqual(prices, DEFAULT_PRICES);
    const c = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreate: 1e6 };
    assert.equal(costOf(prices, 'claude-SONNET-x', c), 3 + 15 + 0.3 + 3.75);
    assert.equal(costOf(prices, 'mystery', c), null);
    assert.deepEqual(costOfModels(prices, { 'claude-haiku-x': c, mystery: c }), { usd: 1 + 5 + 0.1 + 1.25, partial: true });
    fs.writeFileSync(path.join(dir, 'prices.json'), '{ nope');
    assert.deepEqual(loadPrices(dir), DEFAULT_PRICES);
    fs.writeFileSync(path.join(dir, 'prices.json'), JSON.stringify({ models: [{ match: 'x', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }] }));
    assert.equal(loadPrices(dir)[0].match, 'x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RollupScanner buckets by day/model/project, replaces streamed repeats, resumes incrementally', async () => {
  const { RollupScanner, localDay } = require('../dist/rollup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-roll-'));
  const root = path.join(dir, 'projects', 'C--p-alpha');
  const cache = path.join(dir, 'cache.json');
  fs.mkdirSync(root, { recursive: true });
  const now = Date.now();
  const ts = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString();
  const L = (id, daysAgo, usage, model = 'claude-sonnet-x') =>
    JSON.stringify({ type: 'assistant', timestamp: ts(daysAgo), cwd: ['C:', 'p', 'alpha'].join(path.sep), message: { id, model, usage } }) + '\n';
  try {
    const file = path.join(root, 's.jsonl');
    fs.writeFileSync(
      file,
      L('m1', 0, { input_tokens: 10, output_tokens: 1 }) +
        L('m1', 0, { input_tokens: 10, output_tokens: 9 }) + // streamed repeat: replaces
        L('m2', 3, { input_tokens: 100 }) +
        L('m3', 40, { input_tokens: 1000 }, 'claude-opus-x') +
        '{"type":"assistant","message":{"id":"half'
    );
    const s = new RollupScanner(cache, path.join(dir, 'projects'));
    await s.scan();
    let r = s.rollup(now);
    assert.equal(r.today.totals.input, 10);
    assert.equal(r.today.totals.output, 9);
    assert.equal(r.week.totals.input, 110);
    assert.equal(r.all.totals.input, 1110);
    assert.equal(r.all.byModel['claude-opus-x'].input, 1000);
    assert.equal(r.all.byProject['alpha']['claude-sonnet-x'].input, 110);

    // Finish the half-written line, add a line, rescan from the persisted cache.
    fs.appendFileSync(file, 'x","model":"claude-sonnet-x","usage":{"input_tokens":5}}}\n'); // still malformed json: ignored
    fs.appendFileSync(file, L('m4', 0, { input_tokens: 7 }));
    const s2 = new RollupScanner(cache, path.join(dir, 'projects'));
    assert.equal(s2.rollup(now).all.totals.input, 1110); // served from cache before any scan
    await s2.scan();
    r = s2.rollup(now);
    assert.equal(r.today.totals.input, 17);
    assert.equal(r.all.totals.input, 1117); // nothing double counted

    // Deleted transcripts stop counting.
    fs.rmSync(file);
    await s2.scan();
    assert.equal(s2.rollup(now).all.totals.input, 0);
    assert.ok(localDay(now).match(/^\d{4}-\d{2}-\d{2}$/));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('attention: badge priority, fullscreen states, badge painting, mute flag', () => {
  const { badgeFor, coversScreen, paintBadge, FlagFile } = require('../dist/attention');
  assert.strictEqual(badgeFor([]), null);
  assert.strictEqual(badgeFor([{ state: 'working' }, { state: 'idle' }]), null);
  assert.strictEqual(badgeFor([{ state: 'done' }, { state: 'working' }]), 'done');
  assert.strictEqual(badgeFor([{ state: 'done' }, { state: 'needs-you' }]), 'needs-you');
  assert.deepStrictEqual([1, 2, 3, 4, 5, null].map(coversScreen), [false, true, true, true, false, false]);

  const src = Buffer.alloc(16 * 16 * 4); // transparent
  const out = paintBadge(src, 16, 'done');
  assert.strictEqual(src.readUInt8(15 * 64 + 15 * 4 + 3), 0, 'input untouched');
  assert.strictEqual(out.readUInt8(13 * 64 + 13 * 4 + 3), 255, 'bottom-right is painted');
  assert.strictEqual(out.readUInt8(0 * 64 + 0 * 4 + 3), 0, 'top-left stays transparent');

  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-')), 'muted');
  const flag = new FlagFile(f);
  assert.strictEqual(flag.get(), false);
  flag.set(true);
  assert.strictEqual(new FlagFile(f).get(), true);
  flag.set(false);
  assert.strictEqual(flag.get(), false);
});
