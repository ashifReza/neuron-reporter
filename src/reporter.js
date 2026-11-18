'use strict';
// StepReporter: record a test run as a tree of named steps and groups, then
// write it as an HTML report (and, optionally, append it to the run history).
//
//   const { StepReporter } = require('neuron-reporter');
//   const report = new StepReporter('checkout', { screenshot: () => driver.takeScreenshot() });
//   await report.group('Add to cart', async () => {
//     await report.step('Tap Add', () => addButton.click());
//     await report.softStep('Badge shows 1', async () => { if (await badge.getText() !== '1') throw new Error('Expected 1'); });
//     await report.optionalStep('Dismiss promo (if shown)', () => closePromoIfShown());
//   });
//   report.writeReport('reports/checkout.html');
//
// Step kinds:
//   step          mandatory — FAILED and rethrown if it throws
//   softStep      FAILED but NOT rethrown, so the run carries on (call
//                 assertNoFailures() at the end so the test still fails)
//   optionalStep  allowed not to happen — WARNED when it returns a falsy value
//   group         collapsible test case; FAILED if any step inside failed
//
// Retries: pass { retries: n } as the third argument of step()/softStep(), or
// set options.retries for every step. A step that fails and then passes on a
// retry is COMPLETED but marked flaky; every attempt is kept in the report.
//
// Attachments (logs, text, JSON, video, trace files, links) go on the most
// recent step with attach(), attachLog(), attachFile()/attachVideo() and attachLink().

const path = require('path');
const { writeReport, fmtDuration } = require('./renderer');
const history = require('./history');
const attachments = require('./attachments');
const { createRedactor, redactTree, redactObject } = require('./redact');
const fs = require('fs');

const C = { green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', dim: '\x1b[2m', reset: '\x1b[0m' };

class StepReporter {
  /**
   * @param {string} name - Report and history name (e.g. the spec or suite name)
   * @param {Object} [options]
   * @param {() => Promise<string|Buffer|null>} [options.screenshot] - returns a PNG (base64 string or Buffer); see adapters/
   * @param {boolean} [options.screenshotOnFailure=true] - capture automatically when a step fails
   * @param {boolean|Object} [options.history=true] - false to disable; { dir, maxRuns } to configure
   * @param {Object|() => Object} [options.runInfo] - { label: value } facts for the Run details card
   * @param {string[]|() => string[]} [options.highlights] - short facts under the headline
   * @param {Object} [options.labels] - { key: value } pills in the header (e.g. { environment: 'staging' })
   * @param {Array} [options.rules] - extra failure-classification rules (see history.createClassifier)
   * @param {boolean} [options.console=true] - print live ✔/✘ lines while the test runs
   * @param {number} [options.retries=0] - default retries for step() and softStep() (never optionalStep)
   * @param {number} [options.retryDelay=0] - milliseconds to wait between attempts
   * @param {boolean|Object} [options.redact] - secret redaction (on by default); false, or { values, patterns, env, replacement }
   */
  constructor(name, options = {}) {
    this.name = name;
    this.options = { screenshotOnFailure: true, console: true, history: true, retries: 0, retryDelay: 0, ...options };
    this.classify = history.createClassifier(options.rules || []);
    this.redact = createRedactor(options.redact === undefined ? {} : options.redact);
    this.root = [];
    this.stack = [{ children: this.root }];
    this.startTime = Date.now();
  }

  // ---------- recording ----------

  _children() {
    return this.stack[this.stack.length - 1].children;
  }

  _last() {
    const children = this._children();
    return children[children.length - 1];
  }

  _log(text) {
    if (this.options.console) console.log('  '.repeat(this.stack.length - 1) + text);
  }

  async _capture(target, caption) {
    if (!target || !this.options.screenshot) return;
    try {
      const shot = await this.options.screenshot();
      if (!shot) return;
      const base64 = Buffer.isBuffer(shot) ? shot.toString('base64') : String(shot);
      target.screenshot = { dataUri: base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`, caption };
    } catch (error) {
      // A screenshot that cannot be taken must never fail the step it belongs to.
    }
  }

  async _run(description, fn, { kind, retries, retryDelay, id }) {
    const node = { description, status: 'COMPLETED', duration: 0, isGroup: false, children: [] };
    if (id !== undefined) node.id = String(id);
    this._children().push(node);
    const maxRetries = kind === 'optional' && retries === undefined ? 0 : Math.max(0, Number(retries ?? this.options.retries) || 0);
    const delay = Math.max(0, Number(retryDelay ?? this.options.retryDelay) || 0);
    const start = Date.now();
    const attempts = [];
    for (let attempt = 0; ; attempt++) {
      const attemptStart = Date.now();
      try {
        const result = await fn({ attempt });
        attempts.push({ status: 'COMPLETED', duration: Date.now() - attemptStart });
        node.duration = Date.now() - start;
        if (attempts.length > 1) {
          node.attempts = attempts;
          node.flaky = true;
        }
        const tag = node.flaky ? ` ${C.yellow}(flaky — passed on attempt ${attempts.length})${C.reset}` : '';
        if (kind === 'optional' && !result) {
          node.status = 'WARNED';
          this._log(`${C.yellow}⚠ ${description}${C.reset} ${C.dim}(${fmtDuration(node.duration)})${C.reset}`);
        } else {
          this._log(`${C.green}✔ ${description}${C.reset} ${C.dim}(${fmtDuration(node.duration)})${C.reset}${tag}`);
        }
        return kind === 'soft' ? (result === undefined ? true : result) : result;
      } catch (error) {
        const message = (error && error.message) || String(error);
        attempts.push({ status: 'FAILED', duration: Date.now() - attemptStart, error: message });
        if (attempt < maxRetries) {
          this._log(`${C.yellow}↻ ${description} — attempt ${attempt + 1} failed, retrying (${message})${C.reset}`);
          if (delay) await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        node.status = 'FAILED';
        node.error = message;
        node.duration = Date.now() - start;
        if (attempts.length > 1) node.attempts = attempts;
        this._log(`${C.red}✘ ${description} — ${node.error}${C.reset}${attempts.length > 1 ? ` ${C.dim}(${attempts.length} attempts)${C.reset}` : ''}`);
        if (this.options.screenshotOnFailure) await this._capture(node, `Failure — ${description}`);
        if (kind === 'soft') return false;
        throw error;
      }
    }
  }

  /**
   * A mandatory action: FAILED and rethrown if it throws.
   * @param {{ retries?: number, retryDelay?: number }} [opts] - retry a failing step; a pass after a failure is flaky
   */
  step(description, fn, opts = {}) {
    return this._run(description, fn, { kind: 'step', ...opts });
  }

  /** A check that records FAILED but lets the run continue. Resolves to false on failure. */
  softStep(description, fn, opts = {}) {
    return this._run(description, fn, { kind: 'soft', ...opts });
  }

  /** An action allowed not to happen: WARNED when fn resolves to a falsy value. */
  optionalStep(description, fn, opts = {}) {
    return this._run(description, fn, { kind: 'optional', ...opts });
  }

  /** A collapsible test case. FAILED if fn throws or any step inside failed. */
  async group(description, fn, { id } = {}) {
    const node = { description, status: 'COMPLETED', duration: 0, isGroup: true, children: [] };
    if (id !== undefined) node.id = String(id);
    this._children().push(node);
    this._log(`${C.cyan}▶ ${description}${C.reset}`);
    this.stack.push(node);
    const start = Date.now();
    try {
      return await fn();
    } catch (error) {
      node.status = 'FAILED';
      throw error;
    } finally {
      node.duration = Date.now() - start;
      this.stack.pop();
      if (node.status !== 'FAILED' && this._anyFailed(node.children)) node.status = 'FAILED';
      const icon = node.status === 'FAILED' ? `${C.red}✘` : `${C.green}✔`;
      this._log(`${icon} ${description}${C.reset} ${C.dim}(${fmtDuration(node.duration)})${C.reset}`);
    }
  }

  _anyFailed(children) {
    return children.some((c) => c.status === 'FAILED' || (c.isGroup && this._anyFailed(c.children)));
  }

  /** Attach a screenshot to the most recent step or group at the current level. */
  async attachScreenshot(caption) {
    return this._capture(this._last(), caption);
  }

  /** Attach text (e.g. "Expected: X / Actual: Y") to the most recent step at the current level. */
  attachDetail(text) {
    const target = this._last();
    if (target) target.detail = String(text);
  }

  _push(attachment) {
    const target = this._last();
    if (!target || !attachment) return null;
    (target.attachments = target.attachments || []).push(attachment);
    return attachment;
  }

  /**
   * Attach anything to the most recent step or group at the current level.
   * @param {string} name
   * @param {string|Buffer|Object} content - text, a Buffer, or an object (written as JSON)
   * @param {{ contentType?: string }} [opts] - e.g. 'text/plain', 'application/json', 'image/png', 'video/webm'
   */
  attach(name, content, opts = {}) {
    return this._push(attachments.fromContent(name, content, opts));
  }

  /** Attach log lines (a string or an array of strings), shown as a collapsible monospace block. */
  attachLog(name, lines) {
    return this._push(attachments.fromContent(name, Array.isArray(lines) ? lines.join('\n') : String(lines), { contentType: 'text/x-log' }));
  }

  /**
   * Attach a file from disk (video, trace, HAR, log...). Files up to
   * maxEmbedBytes (default 8 MB) are embedded so the report stays one file;
   * larger ones are linked relative to the report.
   * @param {{ embed?: boolean|'auto', maxEmbedBytes?: number, contentType?: string }} [opts]
   */
  attachFile(name, filePath, opts = {}) {
    return this._push(attachments.fromFile(name, filePath, opts));
  }

  /** Attach a video file (webm/mp4). Same embedding rules as attachFile(). */
  attachVideo(name, filePath, opts = {}) {
    return this.attachFile(name, filePath, opts);
  }

  /** Attach a link (a CI job, a ticket, a hosted trace...). */
  attachLink(name, url) {
    return this._push({ name: String(name), contentType: 'text/uri-list', path: String(url) });
  }

  // ---------- results ----------

  /** Every failed step so far, with its cause. */
  failures() {
    return history.collectFailures(this.root, this.classify);
  }

  /** Steps that failed at least once but passed on a retry. */
  flakySteps() {
    return history.collectFlaky(this.root);
  }

  /** Throw if any step failed — call at the end of a test that used softStep(). */
  assertNoFailures() {
    const failed = this.failures();
    if (failed.length) {
      throw new Error(`${failed.length} check(s) failed:\n${failed.map((f) => `  • ${f.step}${f.message ? ` — ${f.message}` : ''}`).join('\n')}`);
    }
  }

  /** The recorded tree as plain JSON (for the CLI or your own tooling). */
  toJSON() {
    return { name: this.name, startedAt: new Date(this.startTime).toISOString(), duration: Date.now() - this.startTime, tree: this.root };
  }

  /**
   * Write this run as a JSON file (redacted, attachment paths relative to it)
   * instead of, or as well as, the HTML report. Parallel jobs or shards each
   * write one, then `neuron-reporter merge <files|dir> -o report.html` builds a
   * single report and records history once.
   */
  writeJSON(outPath) {
    const resolve = (v) => (typeof v === 'function' ? v() : v);
    const tree = redactTree(JSON.parse(JSON.stringify(this.root)), this.redact);
    attachments.resolveLinks(tree, outPath);
    const data = {
      ...this.toJSON(),
      tree,
      labels: redactObject(resolve(this.options.labels) || {}, this.redact),
      runInfo: redactObject(resolve(this.options.runInfo) || {}, this.redact),
    };
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(data));
    return outPath;
  }

  /**
   * Write the HTML report (and append to the run history unless disabled).
   * @param {string} outPath
   * @returns {{ path: string, counts: Object, flaky: number, historyFile: string|null }}
   */
  writeReport(outPath) {
    const duration = Date.now() - this.startTime;
    const resolve = (v) => (typeof v === 'function' ? v() : v);
    const labels = resolve(this.options.labels) || {};
    const runInfo = {
      Suite: this.name,
      ...(resolve(this.options.runInfo) || {}),
      Started: readable(this.startTime, true),
      Finished: readable(Date.now(), true),
    };

    let runs = null;
    let file = null;
    if (this.options.history !== false) {
      const opts = typeof this.options.history === 'object' ? this.options.history : {};
      file = history.historyFile(opts.dir || path.join(path.dirname(outPath), 'history'), this.name);
      runs = history.record(file, { startTime: this.startTime, duration, tree: this.root, labels, classify: this.classify, maxRuns: opts.maxRuns || 50, redact: this.redact });
    }

    attachments.resolveLinks(this.root, outPath);
    writeReport(outPath, {
      title: this.name,
      subtitle: `Run on ${readable(this.startTime)}`,
      labels,
      highlights: resolve(this.options.highlights) || [],
      tree: this.root,
      history: runs,
      runInfo,
      classify: this.classify,
      redact: this.redact,
    });

    const counts = { COMPLETED: 0, FAILED: 0, WARNED: 0 };
    for (const n of this.root) counts[n.status] = (counts[n.status] || 0) + 1;
    const flaky = this.flakySteps().length;
    if (this.options.console) {
      console.log(`📊 ${counts.COMPLETED}/${this.root.length} test cases passed, ${counts.FAILED} failed, ${counts.WARNED} warned${flaky ? `, ${flaky} flaky` : ''} — ${fmtDuration(duration)} → ${outPath}`);
    }
    return { path: outPath, counts, flaky, historyFile: file };
  }
}

/** "Mon, 16 Nov 2026 at 4:53 PM" (or "16 Nov 2026, 4:53:05 PM" with seconds) in local time. */
function readable(ms, withSeconds = false) {
  const d = new Date(ms);
  if (withSeconds) {
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  }
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

module.exports = { StepReporter, readable };
