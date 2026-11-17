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
  { key: 'element', type: 'script', label: 'Element not found', hint: 'A screen changed, or a sheet/tooltip/dialog covered it.', test: /still not displayed|not displayed after|wasn't found|was not found|not existing|no such element|stale element|element not found|unable to find/i },
  { key: 'ui-wait', type: 'script', label: 'Expected state never appeared', hint: 'A status or text never appeared within the wait.', test: /never (showed|reached|appeared)|timed? ?out waiting|within \d+ ?m?s/i },
  { key: 'mismatch', type: 'defect', label: 'Value mismatch', hint: 'The app showed a different value than expected — a real bug or a format change.', test: /expected .* (but|to (be|equal|include|contain))|does(n't| not) (match|include|equal)|mismatch|assertion ?error/i },
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

/** Every FAILED leaf in the tree, with the test case it sits under and its cause. */
function collectFailures(tree, classify = defaultClassifier) {
  const out = [];
  const walk = (nodes, testCase) => {
    for (const node of nodes) {
      const tc = testCase || node.description;
      if (node.isGroup) walk(node.children || [], tc);
      else if (node.status === 'FAILED') {
        const message = String(node.error || '').replace(/\s+/g, ' ').slice(0, 300);
        out.push({ testCase: tc, step: node.description, category: node.category || classify(message).key, message });
      }
    }
  };
  walk(tree, null);
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

/**
 * Append this run and return the full history (oldest first, this run last).
 * The same run written twice (same start time) replaces its own record.
 * Never throws — a history problem must not cost the report itself.
 */
function record(file, { startTime, duration, tree, labels = {}, classify = defaultClassifier, maxRuns = 50 }) {
  const runs = load(file);
  const cases = { COMPLETED: 0, FAILED: 0, WARNED: 0 };
  for (const n of tree) cases[n.status] = (cases[n.status] || 0) + 1;
  const run = {
    startedAt: new Date(startTime).toISOString(),
    duration,
    status: cases.FAILED ? 'FAILED' : cases.WARNED ? 'WARNED' : 'COMPLETED',
    cases,
    steps: leafCounts(tree),
    failures: collectFailures(tree, classify),
    labels,
  };
  if (runs.length && runs[runs.length - 1].startedAt === run.startedAt) runs[runs.length - 1] = run;
  else runs.push(run);
  const kept = runs.slice(-maxRuns);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(kept, null, 1));
  } catch (error) {
    console.warn(`neuron-reporter: could not write history (${error.message})`);
  }
  return kept;
}

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

/** Steps that failed in at least one run, most often first. */
function flakySteps(runs) {
  const steps = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (const f of run.failures || []) {
      if (seen.has(f.step)) continue;
      seen.add(f.step);
      const e = steps.get(f.step) || { step: f.step, testCase: f.testCase, failedRuns: 0, category: f.category, lastSeen: null };
      e.failedRuns += 1;
      e.lastSeen = run.startedAt;
      e.category = f.category;
      steps.set(f.step, e);
    }
  }
  return [...steps.values()].sort((a, b) => b.failedRuns - a.failedRuns);
}

module.exports = {
  TRIAGE,
  DEFAULT_RULES,
  createClassifier,
  defaultClassifier,
  collectFailures,
  leafCounts,
  historyFile,
  load,
  record,
  commonIssues,
  flakySteps,
};
