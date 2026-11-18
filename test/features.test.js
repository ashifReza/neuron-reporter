'use strict';
// Tests for retries / flaky detection, attachments, JUnit import and the
// Playwright Test reporter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { StepReporter, render, history } = require('../src');
const junit = require('../src/adapters/junit');
const PlaywrightReporter = require('../src/playwright-reporter');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'neuron-reporter-'));
const quiet = { console: false };
const FIXTURES = path.join(__dirname, 'fixtures', 'junit');

// ---------- retries & flaky ----------

test('a step that fails then passes on a retry is COMPLETED and flaky, with every attempt kept', async () => {
  const r = new StepReporter('retry', quiet);
  let calls = 0;
  await r.step('flaky step', async ({ attempt }) => {
    calls += 1;
    if (attempt < 2) throw new Error(`503 on attempt ${attempt + 1}`);
  }, { retries: 3 });
  const [node] = r.root;
  assert.equal(calls, 3);
  assert.equal(node.status, 'COMPLETED');
  assert.equal(node.flaky, true);
  assert.deepEqual(node.attempts.map((a) => a.status), ['FAILED', 'FAILED', 'COMPLETED']);
  assert.equal(r.flakySteps().length, 1);
  assert.equal(r.failures().length, 0);
});

test('a step that fails every attempt is FAILED (not flaky) and rethrows after the last one', async () => {
  const r = new StepReporter('retry-fail', quiet);
  await assert.rejects(r.step('always fails', async () => { throw new Error('nope'); }, { retries: 2 }), /nope/);
  const [node] = r.root;
  assert.equal(node.status, 'FAILED');
  assert.equal(node.attempts.length, 3);
  assert.equal(node.flaky, undefined);
  assert.equal(r.flakySteps().length, 0);
});

test('options.retries applies to step and softStep but never to optionalStep', async () => {
  const r = new StepReporter('defaults', { ...quiet, retries: 1 });
  let soft = 0;
  let optional = 0;
  await r.softStep('soft', async () => { soft += 1; throw new Error('x'); });
  await assert.rejects(r.optionalStep('optional', async () => { optional += 1; throw new Error('y'); }));
  assert.equal(soft, 2);
  assert.equal(optional, 1);
});

test('history records flaky steps and flakySteps() tells flaky from consistent failures', () => {
  const run = (failures, flaky = []) => ({ startedAt: new Date().toISOString(), failures, flaky });
  const f = (step) => ({ testCase: 'TC', step, category: 'other', message: '' });
  const runs = [
    run([f('flip')]),
    run([]),
    run([f('flip'), f('broken')]),
    run([f('broken')], [{ testCase: 'TC', step: 'retried', attempts: 2 }]),
    run([f('broken')]),
  ];
  const byStep = Object.fromEntries(history.flakySteps(runs).map((s) => [s.step, s]));
  assert.equal(byStep.flip.flaky, true); // F P F P P
  assert.equal(byStep.flip.flips, 3);
  assert.deepEqual(byStep.flip.outcomes, ['F', 'P', 'F', 'P', 'P']);
  assert.equal(byStep.retried.flaky, true);
  assert.equal(byStep.retried.retriedRuns, 1);
  assert.equal(byStep.broken.flaky, false);
  assert.equal(byStep.broken.consistent, true);
  assert.deepEqual(byStep.broken.outcomes, ['F', 'F', 'F']);
});

test('writeReport stores flaky steps in the history and the report shows them', async () => {
  const dir = tmp();
  const r = new StepReporter('flaky-suite', quiet);
  await r.group('Case', () => r.step('sometimes', async ({ attempt }) => { if (!attempt) throw new Error('blip'); }, { retries: 1 }));
  const out = path.join(dir, 'r.html');
  const result = r.writeReport(out);
  assert.equal(result.flaky, 1);
  const runs = history.load(result.historyFile);
  assert.deepEqual(runs[0].flaky.map((x) => x.step), ['sometimes']);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /Flaky this run/);
  assert.match(html, /data-filter="FLAKY"/);
  assert.match(html, /2 attempts/);
});

// ---------- attachments ----------

test('attachments: text, JSON, logs, files (embedded or linked) and links', async () => {
  const dir = tmp();
  const small = path.join(dir, 'clip.webm');
  fs.writeFileSync(small, Buffer.from('fake-video'));
  const big = path.join(dir, 'trace.zip');
  fs.writeFileSync(big, Buffer.alloc(2048));

  const r = new StepReporter('att', { ...quiet, history: false });
  await r.step('with attachments', async () => {});
  r.attach('note', 'hello <world>');
  r.attach('response', { ok: true });
  r.attachLog('console', ['line 1', 'line 2']);
  r.attachVideo('video', small);
  r.attachFile('trace', big, { maxEmbedBytes: 1024 });
  r.attachLink('ticket', 'https://example.com/T-1');
  r.attachLink('evil', 'javascript:alert(1)');
  r.attachFile('missing', path.join(dir, 'nope.txt'));

  const atts = r.root[0].attachments;
  assert.equal(atts.length, 8);
  assert.equal(atts[1].contentType, 'application/json');
  assert.match(atts[3].dataUri, /^data:video\/webm;base64,/);
  assert.equal(atts[4].dataUri, undefined);
  assert.ok(path.isAbsolute(atts[4].path));

  const out = path.join(dir, 'report', 'r.html');
  r.writeReport(out);
  assert.equal(atts[4].path, '../trace.zip'); // linked relative to the report
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /data-panel="files"/);
  assert.match(html, /hello &lt;world&gt;/);
  assert.match(html, /<video controls/);
  assert.match(html, /href="\.\.\/trace\.zip"/);
  assert.match(html, /npx playwright show-trace/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /attachment not found/);
});

// ---------- JUnit ----------

test('junit adapter maps Surefire reruns, pytest skips, repeated cases and attachments', () => {
  const { tree, name, startedAt } = junit.buildTree([FIXTURES]);
  const byName = Object.fromEntries(tree.map((n) => [n.description, n]));
  assert.equal(name, 'pytest-suite');
  assert.equal(startedAt, new Date('2026-11-18T09:59:00.000000').toISOString());

  assert.equal(byName.addsItemToCart.status, 'COMPLETED');

  const pays = byName.paysWithCard;
  assert.equal(pays.status, 'COMPLETED');
  assert.equal(pays.flaky, true);
  assert.equal(pays.attempts.length, 2);
  assert.match(pays.attempts[0].error, /503 Service Unavailable/);
  const out = pays.attachments.find((a) => a.name === 'system-out');
  assert.equal(out.body, 'paying & waiting');
  assert.ok(pays.attachments.find((a) => /attachment not found/.test(a.body || '')));

  const total = byName.showsTotal;
  assert.equal(total.status, 'FAILED');
  assert.equal(total.attempts.length, 2);
  assert.match(total.error, /expected: <\$24.00> but was: <\$24>/);

  assert.equal(byName.test_sso.status, 'SKIPPED');

  const search = byName.test_search; // listed twice: a retry that passed
  assert.equal(search.status, 'COMPLETED');
  assert.equal(search.flaky, true);
  assert.equal(search.duration, 1500);
});

test('junit adapter can group by suite', () => {
  const { tree } = junit.buildTree([FIXTURES], { groupBy: 'suite' });
  assert.deepEqual(tree.map((g) => g.description).sort(), ['com.example.CheckoutTest', 'pytest']);
  const checkout = tree.find((g) => g.description === 'com.example.CheckoutTest');
  assert.equal(checkout.isGroup, true);
  assert.equal(checkout.status, 'FAILED');
  assert.equal(checkout.children.length, 3);
});

test('xml parser handles entities, CDATA, comments and quoted ">"', () => {
  const doc = junit.parseXml('<?xml version="1.0"?><!-- c --><a x="1 &gt; 0" y=\'q\'><b><![CDATA[<raw>]]></b>&#65;&#x42;</a>');
  const a = doc.children[0];
  assert.equal(a.attrs.x, '1 > 0');
  assert.equal(a.attrs.y, 'q');
  assert.equal(a.children[0].text, '<raw>');
  assert.equal(a.text, 'AB');
});

test('CLI junit command renders the report and exits 1 on a failed case', () => {
  const dir = tmp();
  const out = path.join(dir, 'junit.html');
  const bin = path.join(__dirname, '..', 'bin', 'neuron-reporter.js');
  let code = 0;
  try {
    execFileSync(process.execPath, [bin, 'junit', FIXTURES, '-o', out, '--title', 'jx'], { stdio: 'pipe' });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 1);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /4 of 6 test cases passed/);
  assert.match(html, /flaky/);
});

test('CLI --fail-on-flaky exits 1 when the only problem is a flaky test', () => {
  const dir = tmp();
  const input = path.join(dir, 'run.json');
  fs.writeFileSync(input, JSON.stringify([{ description: 'retried', status: 'COMPLETED', duration: 10, isGroup: false, children: [], attempts: [{ status: 'FAILED', duration: 5, error: 'blip' }, { status: 'COMPLETED', duration: 5 }] }]));
  const bin = path.join(__dirname, '..', 'bin', 'neuron-reporter.js');
  const run = (extra) => {
    try {
      execFileSync(process.execPath, [bin, 'render', input, '-o', path.join(dir, 'o.html'), '--no-history', ...extra], { stdio: 'pipe' });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(run([]), 0);
  assert.equal(run(['--fail-on-flaky']), 1);
});

// ---------- Playwright reporter ----------

function fakeTest(id, titles, outcome) {
  return { id, title: titles[titles.length - 1], titlePath: () => ['', 'chromium', 'checkout.spec.ts', ...titles], outcome: () => outcome, location: { file: path.join(process.cwd(), 'checkout.spec.ts'), line: 3 } };
}

test('Playwright reporter: steps, retries → flaky, failure screenshot, video and stdout', () => {
  const dir = tmp();
  const video = path.join(dir, 'video.webm');
  fs.writeFileSync(video, Buffer.from('webm'));
  const reporter = new PlaywrightReporter({ outputFile: path.join(dir, 'pw', 'index.html') });
  reporter.onBegin({ version: '1.48.0', workers: 2, projects: [{ name: 'chromium' }] }, {});

  const step = (title, category, extra = {}) => ({ title, category, duration: 10, steps: [], ...extra });
  const t1 = fakeTest('t1', ['Checkout', 'pays'], 'flaky');
  reporter.onTestEnd(t1, {
    status: 'failed', duration: 100, retry: 0,
    error: { message: '\x1b[31mTimeout 5000ms exceeded\x1b[39m' },
    steps: [step('Before Hooks', 'hook', { steps: [step('page.goto(/)', 'pw:api')] }), step('click Pay', 'pw:api', { error: { message: 'Timeout 5000ms exceeded' } })],
    attachments: [{ name: 'video', contentType: 'video/webm', path: video }],
    stdout: [], stderr: [],
  });
  reporter.onTestEnd(t1, {
    status: 'passed', duration: 80, retry: 1,
    steps: [step('Pay', 'test.step', { steps: [step('click Pay', 'pw:api'), step('expect toBeVisible', 'expect')] })],
    attachments: [{ name: 'screenshot', contentType: 'image/png', body: Buffer.from('png') }],
    stdout: ['paid\n'], stderr: [],
  });
  const t2 = fakeTest('t2', ['Checkout', 'total'], 'unexpected');
  reporter.onTestEnd(t2, { status: 'failed', duration: 50, retry: 0, error: { message: 'Expected "$24.00" but got "$24"' }, steps: [], attachments: [], stdout: [], stderr: [] });

  const tree = reporter.buildTree();
  assert.equal(tree.length, 2);
  const [pays, total] = tree;
  assert.equal(pays.description, 'Checkout › pays');
  assert.equal(pays.status, 'COMPLETED');
  assert.equal(pays.flaky, true);
  assert.equal(pays.attempts.length, 2);
  assert.equal(pays.attempts[0].error, 'Timeout 5000ms exceeded'); // ANSI stripped
  assert.equal(pays.isGroup, true);
  assert.deepEqual(pays.children.map((c) => c.description), ['Pay']);
  assert.deepEqual(pays.children[0].children.map((c) => c.description), ['click Pay', 'expect toBeVisible']);
  assert.match(pays.screenshot.dataUri, /^data:image\/png;base64,/);
  assert.ok(pays.attachments.some((a) => a.name === 'stdout' && a.body === 'paid'));
  assert.ok(pays.attachments.some((a) => a.name === 'attempt 1: video' && /^data:video\/webm/.test(a.dataUri)));

  assert.equal(total.status, 'FAILED');
  assert.equal(total.isGroup, false);
  assert.match(total.error, /\$24/);

  reporter.onEnd({ duration: 230, startTime: new Date() });
  const html = fs.readFileSync(path.join(dir, 'pw', 'index.html'), 'utf8');
  assert.match(html, /1 of 2 test cases passed/);
  assert.match(html, /Playwright 1\.48\.0/);
  assert.match(html, /Flaky this run/);
});

test('a failed group with no failed step inside still appears in the failure list', () => {
  const html = render({
    title: 't',
    tree: [{ description: 'times out', status: 'FAILED', duration: 5, isGroup: true, error: 'Test timeout of 30000ms exceeded', children: [{ description: 'ok', status: 'COMPLETED', duration: 1, isGroup: false, children: [] }] }],
  });
  assert.match(html, /Test timeout of 30000ms exceeded/);
  assert.doesNotMatch(html, /No failed steps in this run/);
});
