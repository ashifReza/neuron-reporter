'use strict';
// JUnit XML adapter: turns JUnit-style XML — what almost every test runner in
// every language can write (pytest --junitxml, Maven Surefire/Failsafe,
// Gradle, TestNG, Go via gotestsum, .NET via JunitXml.TestLogger, Jest via
// jest-junit, Cypress, Playwright, Robot Framework...) — into a step tree.
//
//   const junit = require('neuron-reporter/adapters/junit');
//   const { tree, name } = junit.buildTree(['target/surefire-reports']);
//
// or from the CLI:  npx neuron-reporter junit target/surefire-reports -o report.html
//
// Mapping:
//   <testcase>                       one test case (a top-level node)
//   <failure>/<error>                FAILED, with the message and stack trace
//   <skipped>                        SKIPPED
//   <flakyFailure>/<flakyError>      Surefire reruns that passed: COMPLETED + flaky, attempts kept
//   <rerunFailure>/<rerunError>      Surefire reruns that failed too: attempts kept
//   the same test case listed twice  treated as a retry (Playwright, Gradle test-retry)
//   <system-out>/<system-err>        log attachments
//   [[ATTACHMENT|path]] in output    file attachment (Jenkins JUnit attachments convention)
//   <property name="attachment" value="path"/>  file attachment
//
// With { groupBy: 'suite' } each <testsuite> (or classname) becomes a
// collapsible group and its test cases become steps inside it.

const fs = require('fs');
const path = require('path');
const attachments = require('../attachments');

// ---------- a small, dependency-free XML reader (enough for JUnit files) ----------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

/** Parse XML into { name, attrs, children, text } elements. Returns the root element. */
function parseXml(xml) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const src = String(xml).replace(/^﻿/, '');
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) { top().text += decode(src.slice(i)); break; }
    if (lt > i) top().text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const end = src.indexOf('-->', lt); i = end === -1 ? src.length : end + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const end = src.indexOf(']]>', lt); top().text += src.slice(lt + 9, end === -1 ? src.length : end); i = end === -1 ? src.length : end + 3; continue; }
    if (src.startsWith('<?', lt)) { const end = src.indexOf('?>', lt); i = end === -1 ? src.length : end + 2; continue; }
    if (src.startsWith('<!', lt)) { const end = src.indexOf('>', lt); i = end === -1 ? src.length : end + 1; continue; }
    // Find the tag end, skipping '>' inside quoted attribute values.
    let j = lt + 1;
    let quote = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
    }
    const raw = src.slice(lt + 1, j);
    i = j + 1;
    if (raw[0] === '/') {
      const name = raw.slice(1).trim();
      // Pop to the matching element (tolerates sloppy nesting).
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = body.match(/^\s*([^\s/>]+)/);
    if (!nameMatch) continue;
    const el = { name: nameMatch[1], attrs: {}, children: [], text: '' };
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(body.slice(nameMatch[0].length)))) el.attrs[m[1]] = decode(m[3] !== undefined ? m[3] : m[4]);
    top().children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

const kids = (el, name) => el.children.filter((c) => c.name === name);
const kid = (el, name) => el.children.find((c) => c.name === name);
const local = (name) => name.replace(/^.*:/, '');

// ---------- JUnit → tree ----------

/** Expand files and directories (recursively, *.xml) into a sorted file list. */
function expandInputs(inputs) {
  const list = [].concat(inputs);
  const out = [];
  const visit = (p, explicit) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p).sort()) visit(path.join(p, entry), false);
    } else if (explicit || /\.xml$/i.test(p)) {
      out.push(p);
    }
  };
  for (const input of list) visit(input, true);
  return out;
}

/** All <testsuite> elements under an element, with their nesting path. */
function suitesOf(el, parents = []) {
  const out = [];
  for (const c of el.children) {
    if (local(c.name) === 'testsuite') {
      out.push({ el: c, path: [...parents, c.attrs.name].filter(Boolean) });
      out.push(...suitesOf(c, [...parents, c.attrs.name]));
    } else if (local(c.name) === 'testsuites') {
      out.push(...suitesOf(c, parents));
    }
  }
  return out;
}

const seconds = (v) => Math.round((parseFloat(v) || 0) * 1000);

function problemText(el) {
  const message = el.attrs.message || '';
  const body = (el.text || '').trim();
  const type = el.attrs.type ? `${el.attrs.type}: ` : '';
  if (!body) return `${type}${message}`.trim();
  if (message && body.includes(message)) return body;
  return [`${type}${message}`.trim(), body].filter(Boolean).join('\n');
}

function attachmentsFor(tc, baseDir, embed) {
  const out = [];
  const files = new Set();
  for (const name of ['system-out', 'system-err']) {
    for (const el of kids(tc, name)) {
      const text = (el.text || '').trim();
      if (!text) continue;
      for (const m of text.matchAll(/\[\[ATTACHMENT\|([^\]]+)\]\]/g)) files.add(m[1].trim());
      const cleaned = text.replace(/\[\[ATTACHMENT\|[^\]]+\]\]\s*/g, '').trim();
      if (cleaned) out.push(attachments.fromContent(name, cleaned, { contentType: 'text/x-log' }));
    }
  }
  const props = kid(tc, 'properties');
  for (const p of props ? kids(props, 'property') : []) {
    if (/^attachment/i.test(p.attrs.name || '') && p.attrs.value) files.add(p.attrs.value);
  }
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(baseDir, f);
    out.push(attachments.fromFile(path.basename(f), abs, { embed }));
  }
  return out.filter(Boolean);
}

/** One attempt (or several, for Surefire reruns) from a <testcase>. */
function attemptsOf(tc) {
  const duration = seconds(tc.attrs.time);
  const failure = kid(tc, 'failure') || kid(tc, 'error');
  const skipped = kid(tc, 'skipped');
  const flaky = tc.children.filter((c) => /^flaky(Failure|Error)$/.test(c.name));
  const reruns = tc.children.filter((c) => /^rerun(Failure|Error)$/.test(c.name));
  if (skipped && !failure) return [{ status: 'SKIPPED', duration, error: skipped.attrs.message || '' }];
  if (failure) {
    return [
      { status: 'FAILED', duration, error: problemText(failure) },
      ...reruns.map((r) => ({ status: 'FAILED', duration: seconds(r.attrs.time), error: problemText(r) })),
    ];
  }
  return [
    ...flaky.map((r) => ({ status: 'FAILED', duration: seconds(r.attrs.time), error: problemText(r) })),
    { status: 'COMPLETED', duration },
  ];
}

function shortClass(classname) {
  const parts = String(classname || '').split(/[.\/\\]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * @param {string|string[]} inputs - JUnit XML files and/or directories
 * @param {{ groupBy?: 'none'|'suite'|'class', embed?: boolean|'auto' }} [opts]
 * @returns {{ tree: Array, name: string, startedAt: string|null, duration: number, files: string[] }}
 */
function buildTree(inputs, { groupBy = 'none', embed = 'auto' } = {}) {
  const files = expandInputs(inputs);
  if (!files.length) throw new Error(`No JUnit XML files found in ${[].concat(inputs).join(', ')}`);

  const cases = new Map(); // key -> node, so a repeated test case becomes a retry
  const order = [];
  let startedAt = null;
  let suiteName = null;
  let suiteTime = 0;

  for (const file of files) {
    const doc = parseXml(fs.readFileSync(file, 'utf8'));
    const rootEl = doc.children.find((c) => /^(testsuites|testsuite)$/.test(local(c.name)));
    if (!rootEl) continue;
    if (local(rootEl.name) === 'testsuites' && rootEl.attrs.name && !suiteName) suiteName = rootEl.attrs.name;
    if (rootEl.attrs.time) suiteTime += seconds(rootEl.attrs.time);
    const suites = local(rootEl.name) === 'testsuite' ? [{ el: rootEl, path: [rootEl.attrs.name].filter(Boolean) }, ...suitesOf(rootEl, [rootEl.attrs.name])] : suitesOf(rootEl);
    for (const { el: suite, path: suitePath } of suites) {
      const ts = suite.attrs.timestamp && new Date(suite.attrs.timestamp);
      if (ts && !Number.isNaN(ts.getTime()) && (!startedAt || ts < startedAt)) startedAt = ts;
      for (const tc of kids(suite, 'testcase')) {
        const suiteLabel = suitePath.join(' › ');
        const key = `${tc.attrs.classname || ''}\u0000${tc.attrs.name || ''}\u0000${suiteLabel}`;
        const attempts = attemptsOf(tc);
        const atts = attachmentsFor(tc, path.dirname(file), embed);
        const existing = cases.get(key);
        if (existing) {
          existing.attempts.push(...attempts);
          existing.attachments.push(...atts);
          continue;
        }
        const node = {
          description: tc.attrs.name || '(unnamed test)',
          classname: tc.attrs.classname || '',
          suite: suiteLabel,
          file: tc.attrs.file || '',
          attempts,
          attachments: atts,
        };
        cases.set(key, node);
        order.push(node);
      }
    }
  }

  // Finalise each test case from its attempts.
  const leaves = order.map((c) => {
    const last = c.attempts[c.attempts.length - 1];
    const node = {
      description: c.description,
      status: last.status,
      duration: c.attempts.reduce((s, a) => s + (a.duration || 0), 0),
      isGroup: false,
      children: [],
    };
    // A stable identity for run history: the class and test name, not the display text.
    if (c.classname) node.id = `${c.classname}::${c.description}`;
    if (last.status === 'FAILED' || last.status === 'SKIPPED') node.error = last.error || undefined;
    if (last.status === 'SKIPPED' && !node.error) delete node.error;
    if (c.attempts.length > 1) node.attempts = c.attempts;
    if (c.attempts.length > 1 && last.status === 'COMPLETED' && c.attempts.some((a) => a.status === 'FAILED')) node.flaky = true;
    if (c.attachments.length) node.attachments = c.attachments;
    const detail = [c.classname && `class: ${c.classname}`, c.file && `file: ${c.file}`].filter(Boolean).join('\n');
    if (detail) node.detail = detail;
    return { node, c };
  });

  let tree;
  if (groupBy === 'suite' || groupBy === 'class') {
    const groups = new Map();
    for (const { node, c } of leaves) {
      const label = (groupBy === 'class' ? c.classname : c.suite) || c.classname || c.suite || 'Tests';
      if (!groups.has(label)) groups.set(label, { description: label, status: 'COMPLETED', duration: 0, isGroup: true, children: [] });
      groups.get(label).children.push(node);
    }
    tree = [...groups.values()].map((g) => {
      g.duration = g.children.reduce((s, n) => s + n.duration, 0);
      const st = g.children.map((n) => n.status);
      g.status = st.includes('FAILED') ? 'FAILED' : st.every((s) => s === 'SKIPPED') ? 'SKIPPED' : st.includes('WARNED') ? 'WARNED' : 'COMPLETED';
      return g;
    });
  } else {
    // Prefix the class when test names repeat across classes, so cases stay distinguishable.
    const nameCount = new Map();
    for (const { node } of leaves) nameCount.set(node.description, (nameCount.get(node.description) || 0) + 1);
    tree = leaves.map(({ node, c }) => {
      if (nameCount.get(node.description) > 1 && c.classname) node.description = `${shortClass(c.classname)} › ${node.description}`;
      return node;
    });
  }

  const duration = suiteTime || tree.reduce((s, n) => s + (n.duration || 0), 0);
  const name = suiteName || (files.length === 1 ? path.basename(files[0], '.xml') : 'junit');
  return { tree, name, startedAt: startedAt ? startedAt.toISOString() : null, duration, files };
}

module.exports = { buildTree, parseXml, expandInputs };
