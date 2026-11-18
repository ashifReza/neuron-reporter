'use strict';
// Tests for secret redaction, step identity / "did not run" history, safe
// concurrent history writes, and merging shards.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { StepReporter, render, history, createRedactor, mergeRuns } = require('../src');
const PlaywrightReporter = require('../src/playwright-reporter');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-reporter-'));
const quiet = { console: false };
const BIN = path.join(__dirname, '..', 'bin', 'neuron-reporter.js');
const R = '••••••';

// ---------- redaction ----------

test('built-in redaction hides common secret shapes and keeps the labels', () => {
  const redact = createRedactor({ env: false });
  const cases = [
    ['Authorization: Bearer abc.def-ghi_12345', `Authorization: Bearer ${R}`],
    ['authorization=Basic dXNlcjpwYXNzd29yZA==', `authorization=Basic ${R}`],
    ['curl -H "Bearer abcdefgh12345678"', `curl -H "Bearer ${R}"`],
    ['login failed: password=hunter22&user=a', `login failed: password=${R}&user=a`],
    ['{"token": "s3cr3t-value", "user": "a"}', `{"token": "${R}", "user": "a"}`],
    ['GET https://bob:pa55word@api.example.com/x', `GET https://bob:${R}@api.example.com/x`],
    ['key AKIAABCDEFGHIJKLMNOP used', `key ${R} used`],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked', `${R} leaked`],
    ['jwt eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMe', `jwt ${R}`],
    ['Expected "$24.00" but screen shows "$24"', 'Expected "$24.00" but screen shows "$24"'],
  ];
  for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redaction hides secret-looking env values, extra values and patterns; false turns it off', () => {
  const redact = createRedactor({ envSource: { APP_PASSWORD: 'Tr0ub4dor&3', HOME: '/home/me', DEBUG: 'true' }, values: ['4242-4242'], patterns: [/ORDER-\d+/] });
  assert.equal(redact('typed Tr0ub4dor&3 into /home/me'), `typed ${R} into /home/me`);
  assert.equal(redact('card 4242-4242 for ORDER-991'), `card ${R} for ${R}`);
  const off = createRedactor(false);
  assert.equal(off('password=hunter22'), 'password=hunter22');
});

test('secrets never reach the HTML, the history file or the shard JSON', async () => {
  const secret = 'Zx9-very-secret-otp';
  const dir = tmp();
  const r = new StepReporter('secrets', { ...quiet, redact: { values: [secret] }, runInfo: { Account: `otp ${secret}` } });
  await r.group('Log in', async () => {
    await r.softStep(`Type OTP ${secret}`, async ({ attempt }) => { if (!attempt) throw new Error(`OTP ${secret} rejected`); }, { retries: 1 });
    r.attachLog('console', [`sending password=hunter22`, `otp=${secret}`]);
    r.attachDetail(`Expected ${secret}`);
    await r.softStep('Server says no', async () => { throw new Error(`401 for token=abcdef123456`); });
  });
  const out = path.join(dir, 'r.html');
  const { historyFile } = r.writeReport(out);
  const json = r.writeJSON(path.join(dir, 'shard.json'));
  for (const file of [out, historyFile, json]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(secret), `${path.basename(file)} leaks the OTP`);
    assert.ok(!text.includes('hunter22'), `${path.basename(file)} leaks the password`);
    assert.ok(!text.includes('abcdef123456'), `${path.basename(file)} leaks the token`);
  }
  assert.ok(r.root[0].children[0].description.includes(secret), 'the in-memory tree is left untouched');
});

test('render() redacts by default and can be turned off', () => {
  const tree = [{ description: 'login', status: 'FAILED', duration: 1, isGroup: false, children: [], error: 'password=hunter22' }];
  assert.doesNotMatch(render({ title: 't', tree }), /hunter22/);
  assert.match(render({ title: 't', tree, redact: false }), /hunter22/);
});

// ---------- step identity and "did not run" ----------

test('steps get stable keys: path, " #2" for repeated names, id when given', () => {
  const leaf = (description, status = 'COMPLETED', extra = {}) => ({ description, status, duration: 1, isGroup: false, children: [], ...extra });
  const tree = [
    { description: 'Cart', status: 'FAILED', duration: 3, isGroup: true, children: [leaf('Tap Add'), leaf('Tap Add', 'FAILED', { error: 'x' }), leaf('Total', 'COMPLETED', { id: 'total-check' })] },
    leaf('Standalone', 'SKIPPED'),
  ];
  assert.deepEqual(history.collectOutcomes(tree), { 'Cart › Tap Add': 'P', 'Cart › Tap Add #2': 'F', 'id:total-check': 'P', Standalone: 'S' });
  assert.deepEqual(history.collectFailures(tree).map((f) => f.key), ['Cart › Tap Add #2']);
});

test('a step that did not run is not counted as passing, so it cannot look flaky or fixed', () => {
  const k = 'TC › Pay';
  const fail = { key: k, testCase: 'TC', step: 'Pay', category: 'other', message: '' };
  const run = (outcomes, failures = []) => ({ startedAt: new Date().toISOString(), failures, flaky: [], outcomes });
  const runs = [
    run({ [k]: 'F' }, [fail]),
    run({}), // Pay did not run (an earlier step aborted the test)
    run({ [k]: 'F' }, [fail]),
    run({ [k]: 'S' }), // skipped
    run({ [k]: 'F' }, [fail]),
  ];
  const [s] = history.flakySteps(runs);
  assert.deepEqual(s.outcomes, ['F', '-', 'F', '-', 'F']);
  assert.equal(s.flips, 0);
  assert.equal(s.flaky, false);
  assert.equal(s.consistent, true);
  assert.equal(s.notRun, 2);
});

test('a step with an id keeps its history when it is renamed', async () => {
  const dir = tmp();
  const file = path.join(dir, 'h.json');
  const once = async (name, fail, startTime) => {
    const r = new StepReporter('ids', { ...quiet, history: false });
    await r.softStep(name, async () => { if (fail) throw new Error('boom'); }, { id: 'pay-step' });
    history.record(file, { startTime, duration: 1, tree: r.root });
  };
  await once('Pay with card', true, 1000);
  await once('Pay with saved card', false, 2000);
  await once('Pay with saved card', true, 3000);
  const steps = history.flakySteps(history.load(file));
  assert.equal(steps.length, 1);
  assert.deepEqual(steps[0].outcomes, ['F', 'P', 'F']);
  assert.equal(steps[0].flaky, true);
});

// ---------- safe history writes ----------

test('parallel writers never lose each other\'s runs', async () => {
  const dir = tmp();
  const file = path.join(dir, 'history', 'par.json');
  const historyModule = path.join(__dirname, '..', 'src', 'history.js').replace(/\\/g, '\\\\');
  const N = 8;
  const script = (i) => `
    const h = require('${historyModule}');
    const tree = [{ description: 'case ${i}', status: 'COMPLETED', duration: 1, isGroup: false, children: [] }];
    for (let j = 0; j < 5; j++) h.record(${JSON.stringify(file)}, { startTime: ${i * 100} + j, duration: 1, tree, redact: false });
  `;
  await Promise.all(Array.from({ length: N }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script(i)], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${i} exited ${code}`))));
  })));
  const runs = history.load(file);
  assert.equal(runs.length, N * 5);
  const starts = runs.map((r) => r.startedAt);
  assert.deepEqual(starts, [...starts].sort(), 'runs are ordered by start time');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
});

test('a stale lock left by a crashed writer is taken over', () => {
  const dir = tmp();
  const file = path.join(dir, 'h.json');
  fs.mkdirSync(`${file}.lock`);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  const runs = history.record(file, { startTime: 1, duration: 1, tree: [] });
  assert.equal(runs.length, 1);
  assert.equal(history.load(file).length, 1);
});

// ---------- merging shards ----------

test('merge: shard JSON files become one report and one history record', async () => {
  const dir = tmp();
  const shards = path.join(dir, 'shards');
  const video = path.join(dir, 'clip.webm');
  fs.writeFileSync(video, Buffer.alloc(4096));

  const a = new StepReporter('suite', { ...quiet, labels: { env: 'staging' } });
  await a.group('Login', () => a.step('ok', async () => {}));
  a.writeJSON(path.join(shards, 'shard-1.json'));

  const b = new StepReporter('suite', quiet);
  await b.group('Checkout', async () => {
    await b.softStep('pay', async () => { throw new Error('Expected 1 but got 2'); });
    b.attachVideo('video', video, { maxEmbedBytes: 1024 }); // linked, not embedded
  });
  b.writeJSON(path.join(shards, 'shard-2.json'));

  const merged = mergeRuns([shards]);
  assert.equal(merged.shards, 2);
  assert.deepEqual(merged.tree.map((n) => n.description), ['Login', 'Checkout']);
  assert.equal(merged.labels.env, 'staging');
  assert.equal(merged.tree[1].children[0].attachments[0].path, video); // resolved back to the real file

  const out = path.join(dir, 'report', 'index.html');
  let code = 0;
  try {
    execFileSync(process.execPath, [BIN, 'merge', shards, '-o', out], { stdio: 'pipe' });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 1);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /1 of 2 test cases passed/);
  assert.match(html, /2 merged/);
  assert.match(html, /<video controls preload="none" src="\.\.\/clip\.webm"/);
  const runs = history.load(history.historyFile(path.join(dir, 'report', 'history'), 'suite'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].shards, 2);
});

test('Playwright reporter in shard mode writes shard JSON and leaves history to the merge', () => {
  const dir = tmp();
  const reporter = new PlaywrightReporter({ outputFile: path.join(dir, 'pw', 'index.html'), title: 'e2e' });
  reporter.onBegin({ version: '1.48.0', workers: 1, projects: [{ name: 'chromium' }], shard: { current: 2, total: 3 } }, {});
  const t = { id: 'abc123', title: 'pays', titlePath: () => ['', 'chromium', 'a.spec.ts', 'pays'], outcome: () => 'expected' };
  reporter.onTestEnd(t, { status: 'passed', duration: 10, retry: 0, steps: [], attachments: [], stdout: [], stderr: [] });
  reporter.onEnd({ duration: 10, startTime: new Date() });

  const json = path.join(dir, 'pw', 'shards', 'shard-2-of-3.json');
  assert.ok(fs.existsSync(json));
  const data = JSON.parse(fs.readFileSync(json, 'utf8'));
  assert.equal(data.name, 'e2e');
  assert.equal(data.tree[0].id, 'abc123');
  assert.equal(fs.existsSync(path.join(dir, 'pw', 'history')), false);
  assert.match(fs.readFileSync(path.join(dir, 'pw', 'index.html'), 'utf8'), /shard 2\/3/);
});
