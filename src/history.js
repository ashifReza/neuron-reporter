'use strict';
// Run history and failure classification.
//
// Every report write can append one compact record per run to
// <dir>/<report name>.json, so a report shows how a suite has been doing
// across runs and which problems keep coming back, not just this one run.
//
// The classifier turns raw error text into a small set of named causes, each
// rolled up into a QA triage bucket:
//   defect       — the app and the expectation disagree (log a bug if it reproduces)
//   script       — the screen looked different from what the test expects
//   environment  — network, auth, rate limits, servers: not the app under test
//
// Step identity: every step gets a stable key — its node `id` when the producer
// gives one (Playwright test ids, JUnit class+name, StepReporter { id }), else
// its path "Test case › group › step", with " #2", " #3" for repeated names.
// Each run records the outcome of every step that ran (P passed, F failed,
// R passed on a retry, W warned, S skipped), so the Trends tab knows when a
// step did not run at all instead of assuming it passed.
//
// Writes are safe under parallel runs: a lock folder serialises writers and
// the file is replaced atomically (write to a temp file, then rename).

const fs = require('fs');
const path = require('path');

const TRIAGE = {
  defect: { label: 'Potential product defects', short: 'Defects', hint: 'The app and the expected value disagree — log a bug if it reproduces.' },
  script: { label: 'Needs triage (UI change / locator)', short: 'To triage', hint: 'The screen looked different from what the test expects.' },
  environment: { label: 'Environment / infrastructure', short: 'Environment', hint: 'Network, auth, rate limits or servers — not the app under test.' },
};

// Order matters: the first matching rule wins, most specific first.
const DEFAULT_RULES = [
  { key: 'rate-limit', type: 'environment', label: 'Rate limited (429)', hint: 'Too many requests in a short time — wait, or reuse a session/token.', test: /\b429\b|too many requests?/i },
  { key: 'blocked', type: 'environment', label: 'Blocked / forbidden (403)', hint: 'A firewall, VPN, proxy or missing permission refused the request.', test: /\b403\b|forbidden|you have been blocked/i },
  { key: 'auth', type: 'environment', label: 'Authentication failed', hint: 'Bad credentials, an expired token, or a logged-out session.', test: /\b401\b|unauthori[sz]ed|login failed|invalid (token|credentials)/i },
  { key: 'server', type: 'environment', label: 'Server error (5xx)', hint: 'The backend answered with an error — retry, then check the service.', test: /\b5\d\d\b(?!\d)|internal server error|bad gateway|service unavailable/i },
  { key: 'network', type: 'environment', label: 'Network drop / timeout', hint: 'The request got no answer. Check the connection.', test: /fetch failed|\(network\)|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|aborted due to timeout|net::ERR_/i },
  { key: 'element', type: 'script', label: 'Element not found', hint: 'A screen changed, or a sheet/tooltip/dialog covered it.', test: /still not displayed|not displayed after|wasn't found|was not found|not existing|no such element|stale element|element not found|element\(s\) not found|unable to find/i },
  { key: 'ui-wait', type: 'script', label: 'Expected state never appeared', hint: 'A status or text never appeared within the wait.', test: /never (showed|reached|appeared)|timed? ?out waiting|within \d+ ?m?s/i },
  // "Expected … but …" prose, and the Expected:/Received: blocks of Playwright, Jest and Vitest.
  { key: 'mismatch', type: 'defect', label: 'Value mismatch', hint: 'The app showed a different value than expected — a real bug or a format change.', test: /expected .* (but|to (be|equal|include|contain))|\bexpected\b[^\n]*:[\s\S]*\breceived\b[^\n]*:|does(n't| not) (match|include|equal)|mismatch|assertion ?error/i },
  { key: 'test-timeout', type: 'script', label: 'Test timed out', hint: 'The whole test ran past its time limit — a slow app, a hang, or a wait that never ends.', test: /test timeout of \d+ ?ms exceeded|timeout of \d+ ?ms exceeded|exceeded timeout of \d+/i },
];
const OTHER = { key: 'other', type: 'script', label: 'Other', hint: '' };

/**
 * Build a classifier. Custom rules are checked first, then the defaults
 * (unless `replaceDefaults` is set). A rule is
 * `{ key, label, type: 'defect'|'script'|'environment', hint?, test: RegExp | (message) => boolean }`.
 */
function createClassifier(customRules = [], { replaceDefaults = false } = {}) {
  const rules = replaceDefaults ? customRules : [...customRules, ...DEFAULT_RULES];
  const matches = (rule, text) => (typeof rule.test === 'function' ? rule.test(text) : rule.test.test(text));
  const classify = (message) => {
    const text = String(message || '');
    return rules.find((r) => matches(r, text)) || OTHER;
  };
  classify.info = (key) => rules.find((r) => r.key === key) || (key === OTHER.key ? OTHER : { ...OTHER, key, label: key });
  return classify;
}

const defaultClassifier = createClassifier();


// ---------- step identity ----------

/**
 * A key function for one walk of a tree. Call it for every node in pre-order
 * (parents before children, siblings in order) so repeated names get the same
 * " #2" suffix in every walk.
 */
function makeKeyer() {
  const seen = new Map();
  return (node, pathParts) => {
    const base = node.id ? `id:${node.id}` : pathParts.join(' › ');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} #${n}` : base;
  };
}

/**
 * Pre-order walk handing each node its key, test case and path. Steps under a
 * node with an id are keyed below that id ("id:checkout › Pay"), so renaming
 * the test case keeps its steps' history too.
 */
function walkKeyed(tree, visit) {
  const keyer = makeKeyer();
  const walk = (nodes, keyParents, testCase) => {
    for (const node of nodes || []) {
      const parts = [...keyParents, String(node.description)];
      const key = keyer(node, parts);
      const tc = testCase || String(node.description);
      const descend = visit(node, { key, testCase: tc, step: String(node.description), depth: keyParents.length });
      if (node.isGroup && descend !== false) walk(node.children, node.id ? [key] : parts, tc);
    }
  };
  walk(tree, [], null);
}

const squash = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 300);

function hasFailedLeaf(node) {
  return (node.children || []).some((c) => (c.isGroup ? hasFailedLeaf(c) || (c.status === 'FAILED' && c.error) : c.status === 'FAILED'));
}

/** Every FAILED step in the tree, with its key, test case and cause. */
function collectFailures(tree, classify = defaultClassifier) {
  const out = [];
  walkKeyed(tree, (node, { key, testCase, step }) => {
    // A failed test case with no failed step inside (a timeout, a hook, an
    // error between steps) still counts as one failure, reported on the case.
    const failedGroup = node.isGroup && node.status === 'FAILED' && node.error && !hasFailedLeaf(node);
    if ((!node.isGroup && node.status === 'FAILED') || failedGroup) {
      const message = squash(node.error);
      out.push({ key, testCase, step, category: node.category || classify(message).key, message });
    }
  });
  return out;
}

function isFlakyNode(node) {
  if (node.status !== 'COMPLETED' && node.status !== 'WARNED') return false;
  if (node.flaky) return true;
  const a = node.attempts || [];
  return a.some((x) => x.status === 'FAILED') && a.some((x) => x.status !== 'FAILED');
}

/**
 * Every step (or whole test case — runners like Playwright retry the test, not
 * the step) that failed at least once and then passed on a retry.
 */
function collectFlaky(tree) {
  const out = [];
  walkKeyed(tree, (node, { key, testCase, step }) => {
    if (!isFlakyNode(node)) return true;
    const attempts = (node.attempts || []).length || 2;
    const firstError = (node.attempts || []).find((a) => a.status === 'FAILED');
    out.push({ key, testCase, step, attempts, message: String((firstError && firstError.error) || '').slice(0, 300) });
    return true;
  });
  return out;
}

const CODE = { COMPLETED: 'P', FAILED: 'F', WARNED: 'W', SKIPPED: 'S', PENDING: 'S' };

/**
 * { key: code } for every step that has an outcome of its own: leaves, test
 * cases with no steps, flaky test cases, and failed test cases with no failed
 * step inside. Codes: P passed, F failed, R passed on a retry, W warned, S skipped.
 */
function collectOutcomes(tree) {
  const out = {};
  walkKeyed(tree, (node, { key }) => {
    const leaf = !node.isGroup || !(node.children || []).length;
    if (isFlakyNode(node)) out[key] = 'R';
    else if (leaf) out[key] = CODE[node.status] || 'S';
    else if (node.status === 'FAILED' && node.error && !hasFailedLeaf(node)) out[key] = 'F';
    return true;
  });
  return out;
}

/** Leaf-step outcome counts (a group with no children counts as one leaf). */
function leafCounts(tree) {
  const counts = { COMPLETED: 0, FAILED: 0, WARNED: 0 };
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.isGroup && n.children && n.children.length) walk(n.children);
      else counts[n.status] = (counts[n.status] || 0) + 1;
    }
  };
  walk(tree);
  return counts;
}

// ---------- the history file ----------

function historyFile(dir, name) {
  return path.join(dir, `${String(name).replace(/[^\w.-]+/g, '_')}.json`);
}

function load(file) {
  try {
    const runs = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(runs) ? runs : [];
  } catch (error) {
    return [];
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run fn while holding <file>.lock (a folder: mkdir is atomic on every OS).
 * A lock older than staleMs is assumed abandoned by a crashed writer and
 * taken over; after timeoutMs we warn and go ahead without it.
 */
function withLock(file, fn, { timeoutMs = 15000, staleMs = 30000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      held = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') break;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch (e) {
        continue; // the holder just released it
      }
      if (Date.now() > deadline) {
        console.warn(`neuron-reporter: history is locked by another writer (${lock}); writing without the lock`);
        break;
      }
      sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmSync(lock, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
}

/** Replace a file atomically: readers see the old file or the new one, never half of one. */
function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open; retry briefly.
      if (i < 20 && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY')) {
        sleepSync(25);
        continue;
      }
      try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      throw error;
    }
  }
}

/** The compact history record for one run. */
function buildRun({ startTime, duration, tree, labels = {}, classify = defaultClassifier, shards }) {
  const cases = { COMPLETED: 0, FAILED: 0, WARNED: 0 };
  for (const n of tree) cases[n.status] = (cases[n.status] || 0) + 1;
  const run = {
    startedAt: new Date(startTime).toISOString(),
    duration,
    status: cases.FAILED ? 'FAILED' : cases.WARNED ? 'WARNED' : 'COMPLETED',
    cases,
    steps: leafCounts(tree),
    failures: collectFailures(tree, classify),
    flaky: collectFlaky(tree).map(({ key, testCase, step, attempts }) => ({ key, testCase, step, attempts })),
    outcomes: collectOutcomes(tree),
    labels,
  };
  if (shards) run.shards = shards;
  return run;
}

/**
 * Append this run and return the full history (oldest first, by start time).
 * The same run written twice (same start time) replaces its own record, and
 * runs that finish out of order (parallel jobs) are slotted in by start time.
 * Text is redacted (see redact.js) unless `redact: false`.
 * Never throws — a history problem must not cost the report itself.
 */
function record(file, { startTime, duration, tree, labels = {}, classify = defaultClassifier, maxRuns = 50, redact, shards }) {
  const { createRedactor, redactTree, redactObject } = require('./redact');
  const R = typeof redact === 'function' ? redact : createRedactor(redact === undefined ? {} : redact);
  const run = buildRun({ startTime, duration, tree: redactTree(tree, R), labels: redactObject(labels, R), classify, shards });
  let kept = [run];
  try {
    kept = withLock(file, () => {
      const runs = load(file).filter((r) => r.startedAt !== run.startedAt);
      runs.push(run);
      runs.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0));
      const out = runs.slice(-maxRuns);
      writeAtomic(file, JSON.stringify(out, null, 1));
      return out;
    });
  } catch (error) {
    console.warn(`neuron-reporter: could not write history (${error.message})`);
    kept = [...load(file).filter((r) => r.startedAt !== run.startedAt), run];
  }
  return kept;
}

// ---------- reading the history ----------

/** Causes across the whole history, most frequent first. */
function commonIssues(runs, classify = defaultClassifier) {
  const byCategory = new Map();
  for (const [index, run] of runs.entries()) {
    for (const f of run.failures || []) {
      const e = byCategory.get(f.category) || { key: f.category, count: 0, runs: new Set(), lastSeen: null, example: f.message, steps: new Map() };
      e.count += 1;
      e.runs.add(index);
      e.lastSeen = run.startedAt;
      e.example = f.message || e.example;
      e.steps.set(f.step, (e.steps.get(f.step) || 0) + 1);
      byCategory.set(f.category, e);
    }
  }
  return [...byCategory.values()]
    .map((e) => ({
      ...classify.info(e.key),
      key: e.key,
      count: e.count,
      runsAffected: e.runs.size,
      lastSeen: e.lastSeen,
      example: e.example,
      topStep: [...e.steps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0],
    }))
    .sort((a, b) => b.count - a.count);
}

/** A failure/flaky record's key. Records from before 1.2 have none; their path key is "test case › step". */
const recordKey = (f) => f.key || (f.testCase === f.step ? String(f.step) : `${f.testCase} › ${f.step}`);

/**
 * Steps that failed (or needed a retry) in at least one run, worst first.
 *
 *   outcomes     one per run from the first run that mentions the step:
 *                'F' failed, 'R' passed on a retry, 'P' passed, '-' did not run
 *                (runs recorded before 1.2 have no per-step data, so a step
 *                missing from their failures is taken as passed)
 *   flips        switches between failing and passing across the runs it ran in
 *   flaky        passed on a retry at least once, or flipped two or more times
 *   consistent   failed in every run it ran in since it first failed
 *   notRun       runs in which it did not run
 */
function flakySteps(runs) {
  const steps = new Map();
  const entry = (f) => {
    const k = recordKey(f);
    if (!steps.has(k)) steps.set(k, { key: k, step: f.step, testCase: f.testCase, failedRuns: 0, retriedRuns: 0, category: f.category || null, lastSeen: null, firstIndex: Infinity });
    return steps.get(k);
  };
  runs.forEach((run, index) => {
    const seen = new Set();
    for (const f of run.failures || []) {
      const k = recordKey(f);
      if (seen.has(k)) continue;
      seen.add(k);
      const e = entry(f);
      e.failedRuns += 1;
      e.lastSeen = run.startedAt;
      e.category = f.category;
      e.firstIndex = Math.min(e.firstIndex, index);
    }
    for (const f of run.flaky || []) {
      const e = entry(f);
      e.retriedRuns += 1;
      e.lastSeen = run.startedAt;
      e.firstIndex = Math.min(e.firstIndex, index);
    }
  });
  const outcomeIn = (run, k) => {
    if (run.outcomes) {
      const c = run.outcomes[k];
      if (c === 'F' || c === 'R') return c;
      if (c === 'P' || c === 'W') return 'P';
      return '-';
    }
    if ((run.failures || []).some((f) => recordKey(f) === k)) return 'F';
    if ((run.flaky || []).some((f) => recordKey(f) === k)) return 'R';
    return 'P';
  };
  for (const e of steps.values()) {
    e.outcomes = runs.slice(e.firstIndex).map((run) => outcomeIn(run, e.key));
    const ran = e.outcomes.filter((o) => o !== '-');
    let flips = 0;
    for (let i = 1; i < ran.length; i++) if ((ran[i] === 'F') !== (ran[i - 1] === 'F')) flips += 1;
    e.flips = flips;
    e.notRun = e.outcomes.length - ran.length;
    e.flaky = e.retriedRuns > 0 || flips >= 2;
    e.consistent = !e.flaky && e.failedRuns > 0 && ran.length > 0 && ran.every((o) => o === 'F');
    delete e.firstIndex;
  }
  const score = (e) => (e.flaky ? 1000 : 0) + e.failedRuns + e.retriedRuns;
  return [...steps.values()].sort((a, b) => score(b) - score(a));
}

module.exports = {
  TRIAGE,
  DEFAULT_RULES,
  createClassifier,
  defaultClassifier,
  walkKeyed,
  collectFailures,
  collectFlaky,
  collectOutcomes,
  isFlakyNode,
  leafCounts,
  historyFile,
  load,
  buildRun,
  record,
  withLock,
  writeAtomic,
  commonIssues,
  flakySteps,
};
