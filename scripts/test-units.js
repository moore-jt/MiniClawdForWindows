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
