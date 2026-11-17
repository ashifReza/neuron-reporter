'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { StepReporter, render, history, createClassifier } = require('../src');
const maestro = require('../src/adapters/maestro');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-reporter-'));
const quiet = { console: false };

test('default classifier maps common failures to causes and triage buckets', () => {
  const classify = createClassifier();
  const cases = [
    ['GET /x failed (network): fetch failed', 'network', 'environment'],
    ['Request failed: 429 Too many requests', 'rate-limit', 'environment'],
    ['403 Forbidden', 'blocked', 'environment'],
    ['element ("~cart") still not displayed after 15000ms', 'element', 'script'],
    ['Expected "$24.00" but screen shows "$24"', 'mismatch', 'defect'],
    ['something odd', 'other', 'script'],
  ];
  for (const [message, key, type] of cases) {
    assert.equal(classify(message).key, key, message);
    assert.equal(classify(message).type, type, message);
  }
});

test('custom rules are checked before the defaults', () => {
  const classify = createClassifier([{ key: 'flaky-otp', type: 'environment', label: 'OTP not delivered', test: /otp/i }]);
  assert.equal(classify('Expected OTP but got nothing').key, 'flaky-otp');
  assert.equal(classify.info('flaky-otp').label, 'OTP not delivered');
});

test('step kinds record the right statuses and groups roll up', async () => {
  const r = new StepReporter('kinds', quiet);
  await r.group('Case A', async () => {
    await r.step('passes', async () => {});
    await r.optionalStep('not there', async () => false);
    assert.equal(await r.softStep('soft fail', async () => { throw new Error('Expected 1 but got 2'); }), false);
  });
  await assert.rejects(r.group('Case B', () => r.step('hard fail', async () => { throw new Error('boom'); })), /boom/);

  const [a, b] = r.root;
  assert.deepEqual(a.children.map((c) => c.status), ['COMPLETED', 'WARNED', 'FAILED']);
  assert.equal(a.status, 'FAILED'); // a failed soft step fails its test case
  assert.equal(b.status, 'FAILED');
  assert.equal(r.failures().length, 2);
  assert.throws(() => r.assertNoFailures(), /2 check\(s\) failed/);
});

test('a failing step captures a screenshot; a broken screenshot never fails the step', async () => {
  const ok = new StepReporter('shots', { ...quiet, screenshot: async () => Buffer.from('png-bytes') });
  await ok.softStep('fails', async () => { throw new Error('x'); });
  assert.match(ok.root[0].screenshot.dataUri, /^data:image\/png;base64,/);

  const broken = new StepReporter('shots2', { ...quiet, screenshot: async () => { throw new Error('no session'); } });
  await broken.softStep('fails', async () => { throw new Error('x'); });
  assert.equal(broken.root[0].status, 'FAILED');
  assert.equal(broken.root[0].screenshot, undefined);
});

test('writeReport writes the HTML and records history; the same run replaces its record', async () => {
  const dir = tmp();
  const r = new StepReporter('suite', { ...quiet, runInfo: { Environment: 'Test' } });
  await r.group('Case', () => r.step('ok', async () => {}));
  const out = path.join(dir, 'suite.html');
  const result = r.writeReport(out);
  r.writeReport(out); // e.g. called again from an afterEach

  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /1 of 1 test case passed/);
  assert.match(html, /data-panel="overview"/);
  assert.match(html, /data-panel="trends"/);
  const runs = history.load(result.historyFile);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'COMPLETED');
});

test('history can be disabled', async () => {
  const dir = tmp();
  const r = new StepReporter('nohist', { ...quiet, history: false });
  await r.step('ok', async () => {});
  const result = r.writeReport(path.join(dir, 'x.html'));
  assert.equal(result.historyFile, null);
  assert.equal(fs.existsSync(path.join(dir, 'history')), false);
});

test('render escapes step text (no HTML injection from test names or errors)', () => {
  const html = render({
    title: '<b>t</b>',
    tree: [{ description: '<script>alert(1)</script>', status: 'FAILED', duration: 1, isGroup: false, children: [], error: '<img src=x onerror=alert(1)>' }],
  });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('CLI renders a tree JSON and exits non-zero when a case failed', () => {
  const dir = tmp();
  const input = path.join(dir, 'run.json');
  fs.writeFileSync(input, JSON.stringify({
    name: 'cli-run',
    startedAt: new Date().toISOString(),
    tree: [
      { description: 'Case 1', status: 'COMPLETED', duration: 1000, isGroup: true, children: [{ description: 'ok', status: 'COMPLETED', duration: 1000, isGroup: false, children: [] }] },
      { description: 'Case 2', status: 'FAILED', duration: 500, isGroup: false, children: [], error: 'fetch failed' },
    ],
  }));
  const out = path.join(dir, 'out.html');
  const bin = path.join(__dirname, '..', 'bin', 'neuron-reporter.js');
  let code = 0;
  try {
    execFileSync(process.execPath, [bin, 'render', input, '-o', out], { stdio: 'pipe' });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 1);
  assert.match(fs.readFileSync(out, 'utf8'), /1 of 2 test cases passed/);
});

test('maestro adapter builds groups from runFlow blocks', () => {
  const dir = tmp();
  const meta = (seq, depth, status, extra = {}) => ({ sequenceNumber: seq, depth, status, duration: 100, ...extra });
  fs.writeFileSync(path.join(dir, 'commands.json'), JSON.stringify([
    { command: { defineVariablesCommand: { env: { USER: 'demo' } } }, metadata: meta(0, 0, 'COMPLETED') },
    { command: { runFlowCommand: { label: 'Log in' } }, metadata: meta(1, 0, 'FAILED') },
    { command: { tapOnElement: { selector: { textRegex: 'Sign in' } } }, metadata: meta(2, 1, 'COMPLETED') },
    { command: { assertConditionCommand: { condition: { visible: { idRegex: 'app:id/home' } } } }, metadata: meta(3, 1, 'FAILED', { error: { message: 'Assertion is false: id: home is visible' } }) },
  ]));
  const { tree, envVars } = maestro.buildTree(dir);
  assert.equal(envVars.USER, 'demo');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].description, 'Log in');
  assert.deepEqual(tree[0].children.map((c) => c.description), ['Tap on text="Sign in"', 'Assert visible: id="home"']);
  assert.equal(tree[0].children[1].error, 'Assertion is false: id: home is visible');
});
