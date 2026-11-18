'use strict';
// Playwright Test reporter: one line in playwright.config, no code in tests.
//
//   // playwright.config.js
//   reporter: [['list'], ['neuron-reporter/playwright-reporter', { outputFile: 'neuron-report/index.html' }]],
//   use: { video: 'retain-on-failure', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
//
// Each test becomes a test case; its test.step() blocks, expect() calls and
// page actions become steps. Retries are kept as attempts, and a test that
// passes on a retry is marked flaky. Screenshots, videos and traces Playwright
// records are attached (embedded up to maxEmbedBytes, linked beyond that).
//
// Options:
//   outputFile      report path (default 'neuron-report/index.html')
//   title           report and history name (default: the config's name or 'playwright')
//   history         false, or { dir, maxRuns } (default: <report dir>/history)
//   stepCategories  which step kinds to show (default ['test.step', 'expect', 'pw:api'])
//   embed           'auto' | true | false — how to include video/trace files (default 'auto')
//   maxEmbedBytes   size limit for embedding a file (default 8 MB)
//   rules           extra failure-classification rules
//   labels          { key: value } pills in the header
//   redact          secret redaction, on by default (false, or { values, patterns, env })
//   jsonFile        also write the run as JSON here (automatic with --shard)
//
// Sharding (npx playwright test --shard=1/4): each shard writes its report plus
// <report dir>/shards/shard-1-of-4.json and skips history. Gather the shards'
// JSON files in one folder, then `npx neuron-reporter merge <folder> -o report.html`
// builds one report and records one history entry.

const fs = require('fs');
const path = require('path');
const { writeReport } = require('./renderer');
const history = require('./history');
const attachments = require('./attachments');
const { readable } = require('./reporter');
const runInfo = require('./runinfo');
const { createRedactor, redactTree, redactObject } = require('./redact');

const ANSI = /\x1b\[[0-9;]*m/g;
const clean = (s) => String(s || '').replace(ANSI, '');

const STATUS = { passed: 'COMPLETED', failed: 'FAILED', timedOut: 'FAILED', interrupted: 'FAILED', skipped: 'SKIPPED' };

function errorText(err) {
  if (!err) return '';
  const msg = clean(err.message || err.value || '');
  return msg || clean(err.stack || '');
}

// Setup and teardown: hidden, along with the browser/context/page calls inside
// them, unless something in them failed (a failing beforeEach must be visible).
const SETUP_CATEGORIES = new Set(['hook', 'fixture']);

function hasError(step) {
  return !!step.error || (step.steps || []).some(hasError);
}

function convertSteps(steps, categories) {
  const out = [];
  for (const step of steps || []) {
    if (SETUP_CATEGORIES.has(step.category)) {
      if (!hasError(step)) continue;
      const err = step.error || (function first(s) { for (const c of s.steps || []) { if (c.error) return c.error; const e = first(c); if (e) return e; } return null; })(step);
      out.push({ description: clean(step.title), status: 'FAILED', duration: Math.max(0, Math.round(step.duration || 0)), isGroup: false, children: [], error: errorText(err) });
      continue;
    }
    const children = convertSteps(step.steps, categories);
    if (!categories.includes(step.category)) {
      out.push(...children); // a step kind not shown: keep what it contains
      continue;
    }
    const failed = !!step.error || children.some((c) => c.status === 'FAILED');
    const node = {
      description: clean(step.title),
      status: failed ? 'FAILED' : 'COMPLETED',
      duration: Math.max(0, Math.round(step.duration || 0)),
      isGroup: children.length > 0,
      children,
    };
    if (step.error && !children.length) node.error = errorText(step.error);
    out.push(node);
  }
  return out;
}

class NeuronPlaywrightReporter {
  constructor(options = {}) {
    this.options = {
      outputFile: 'neuron-report/index.html',
      stepCategories: ['test.step', 'expect', 'pw:api'],
      embed: 'auto',
      maxEmbedBytes: attachments.DEFAULT_MAX_EMBED,
      history: true,
      ...options,
    };
    this.tests = new Map(); // test.id -> { test, results: [] }
    this.startTime = Date.now();
  }

  printsToStdio() {
    return false;
  }

  onBegin(config, suite) {
    this.config = config;
    this.rootSuite = suite;
    this.startTime = Date.now();
  }

  onTestEnd(test, result) {
    const key = test.id || (test.titlePath ? test.titlePath().join(' › ') : test.title);
    if (!this.tests.has(key)) this.tests.set(key, { test, results: [] });
    this.tests.get(key).results.push(result);
  }

  _title(test, multiProject) {
    const parts = typeof test.titlePath === 'function' ? test.titlePath() : [test.title];
    // titlePath: ['', project, file, ...describes, title]
    const [, project, file, ...rest] = parts;
    const title = (rest.length ? rest : [test.title]).filter(Boolean).join(' › ');
    const where = multiProject && project ? `[${project}] ` : '';
    return `${where}${title || file || test.title}`;
  }

  _attachmentsOf(result, node) {
    const out = [];
    for (const a of result.attachments || []) {
      const type = a.contentType || attachments.contentTypeFor(a.path || a.name);
      if (type.startsWith('image/') && !node.screenshot) {
        const data = a.body || (a.path && fs.existsSync(a.path) ? fs.readFileSync(a.path) : null);
        if (data) {
          node.screenshot = { dataUri: `data:${type};base64,${Buffer.from(data).toString('base64')}`, caption: node.status === 'FAILED' ? `Failure — ${node.description}` : a.name };
          continue;
        }
      }
      if (a.path) out.push(attachments.fromFile(a.name, a.path, { embed: this.options.embed, maxEmbedBytes: this.options.maxEmbedBytes, contentType: type }));
      else if (a.body) out.push(attachments.fromContent(a.name, Buffer.from(a.body), { contentType: type }));
    }
    for (const [name, chunks] of [['stdout', result.stdout], ['stderr', result.stderr]]) {
      const text = (chunks || []).map((c) => (Buffer.isBuffer(c) ? c.toString('utf8') : String(c))).join('');
      if (text.trim()) out.push(attachments.fromContent(name, clean(text).trimEnd(), { contentType: 'text/x-log' }));
    }
    return out.filter(Boolean);
  }

  buildTree() {
    const projects = new Set([...this.tests.values()].map(({ test }) => (typeof test.titlePath === 'function' ? test.titlePath()[1] : '')));
    const multiProject = projects.size > 1;
    const tree = [];
    for (const { test, results } of this.tests.values()) {
      const last = results[results.length - 1];
      const outcome = typeof test.outcome === 'function' ? test.outcome() : null;
      let status = STATUS[last.status] || 'FAILED';
      // Honour test.fail(): an expected failure is a pass, and the steps that
      // failed inside it failed as intended — shown as warned, not as failures.
      const expectedFailure = outcome === 'expected' && status === 'FAILED';
      if (expectedFailure) status = 'COMPLETED';
      if (outcome === 'skipped') status = 'SKIPPED';
      const children = convertSteps(last.steps, this.options.stepCategories);
      if (expectedFailure) {
        const soften = (nodes) => nodes.forEach((n) => {
          if (n.status === 'FAILED') {
            n.status = 'WARNED';
            n.detail = [`Failed as expected (test.fail())${n.error ? `: ${n.error}` : ''}`, n.detail].filter(Boolean).join('\n');
            delete n.error;
          }
          soften(n.children || []);
        });
        soften(children);
      }
      const node = {
        description: this._title(test, multiProject),
        status,
        duration: results.reduce((s, r) => s + Math.max(0, Math.round(r.duration || 0)), 0),
        isGroup: children.length > 0,
        children,
      };
      if (expectedFailure) node.detail = 'Marked test.fail(): it failed, as expected.';
      // Identity for run history: an { type: 'id' } annotation if the test has one
      // (survives renames), else Playwright's test id (a hash of file, project and
      // title — stable between runs, but new when the test is renamed).
      const idNote = (test.annotations || []).find((a) => a && a.type === 'id' && a.description);
      if (idNote) node.id = String(idNote.description);
      else if (test.id) node.id = String(test.id);
      if (status === 'FAILED') node.error = errorText(last.error || (last.errors || [])[0]);
      if (results.length > 1) {
        node.attempts = results.map((r) => ({ status: STATUS[r.status] || 'FAILED', duration: Math.round(r.duration || 0), ...(r.error ? { error: errorText(r.error) } : {}) }));
        if (status === 'COMPLETED' && node.attempts.some((a) => a.status === 'FAILED')) node.flaky = true;
      }
      const atts = this._attachmentsOf(last, node);
      // Keep the video/trace of failed earlier attempts too — that is where a flaky failure is visible.
      results.slice(0, -1).forEach((r, i) => {
        for (const a of this._attachmentsOf(r, {})) atts.push({ ...a, name: `attempt ${i + 1}: ${a.name}` });
      });
      if (atts.length) node.attachments = atts;
      const loc = test.location ? `${path.relative(process.cwd(), test.location.file)}:${test.location.line}` : '';
      if (loc) node.detail = [node.detail, loc].filter(Boolean).join('\n');
      tree.push(node);
    }
    return tree;
  }

  onEnd(fullResult = {}) {
    const tree = this.buildTree();
    const name = this.options.title || (this.config && this.config.metadata && this.config.metadata.name) || 'playwright';
    const out = path.resolve(this.options.outputFile);
    const duration = Math.round(fullResult.duration || (Date.now() - this.startTime));
    const startTime = fullResult.startTime ? new Date(fullResult.startTime).getTime() : this.startTime;
    const classify = history.createClassifier(this.options.rules || []);
    const labels = this.options.labels || {};
    const redact = createRedactor(this.options.redact === undefined ? {} : this.options.redact);
    const shard = this.config && this.config.shard; // { current, total } with --shard
    const projects = ((this.config && this.config.projects) || []).map((p) => p.name).filter(Boolean);
    const info = {
      Suite: name,
      Runner: this.config && this.config.version ? `Playwright ${this.config.version}` : 'Playwright',
      Projects: projects.join(', '),
      Workers: this.config && this.config.workers,
      ...(shard ? { Shard: `${shard.current} of ${shard.total}` } : {}),
      ...runInfo.git(),
      ...runInfo.ci(),
    };

    // Sharded runs: write this shard's run as JSON for `neuron-reporter merge`,
    // and leave history to the merge so the suite gets one record, not N.
    const jsonFile = this.options.jsonFile || (shard ? path.join(path.dirname(out), 'shards', `shard-${shard.current}-of-${shard.total}.json`) : null);
    if (jsonFile) {
      const jsonTree = redactTree(JSON.parse(JSON.stringify(tree)), redact);
      attachments.resolveLinks(jsonTree, jsonFile);
      fs.mkdirSync(path.dirname(path.resolve(jsonFile)), { recursive: true });
      fs.writeFileSync(jsonFile, JSON.stringify({ name, startedAt: new Date(startTime).toISOString(), duration, labels: redactObject(labels, redact), runInfo: redactObject(info, redact), tree: jsonTree }));
    }

    let runs = null;
    if (this.options.history !== false && !shard) {
      const h = typeof this.options.history === 'object' ? this.options.history : {};
      runs = history.record(history.historyFile(h.dir || path.join(path.dirname(out), 'history'), name), { startTime, duration, tree, labels, classify, maxRuns: h.maxRuns || 50, redact });
    }

    attachments.resolveLinks(tree, out);
    writeReport(out, {
      title: shard ? `${name} (shard ${shard.current}/${shard.total})` : name,
      subtitle: `Run on ${readable(startTime)}`,
      labels,
      tree,
      history: runs,
      classify,
      redact,
      runInfo: { ...info, Started: readable(startTime, true) },
    });
    const flaky = history.collectFlaky(tree).length;
    const count = (s) => tree.filter((n) => n.status === s).length;
    const skipped = count('SKIPPED');
    console.log(`neuron-reporter: ${count('COMPLETED')}/${tree.length} passed, ${count('FAILED')} failed${skipped ? `, ${skipped} skipped` : ''}${flaky ? `, ${flaky} flaky` : ''} → ${path.relative(process.cwd(), out)}`);
    if (shard && jsonFile) {
      console.log(`neuron-reporter: shard ${shard.current}/${shard.total} saved to ${path.relative(process.cwd(), jsonFile)} — collect every shard's file, then: npx neuron-reporter merge <folder> -o ${path.relative(process.cwd(), out)}`);
    }
  }
}

module.exports = NeuronPlaywrightReporter;
module.exports.default = NeuronPlaywrightReporter;
module.exports.convertSteps = convertSteps;
