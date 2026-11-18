'use strict';
// neuron-reporter HTML renderer: turns a step tree into one self-contained HTML
// page (inline CSS/SVG/JS, no external requests) with a summary header,
// tabs for Overview / Test cases / Screenshots / Trends, light + dark themes.
//
// A tree is an array of nodes shaped as
//   { description, status, duration, isGroup, children, screenshot?, error?, detail? }
// where status is COMPLETED / FAILED / WARNED (also PENDING / SKIPPED) and
// duration is milliseconds. A group's own status/duration is expected to be
// the producer's rollup of its children; the renderer does not re-aggregate.

const fs = require('fs');
const path = require('path');
const ReportHistory = require('./history');
const Redact = require('./redact');
const Attachments = require('./attachments');

// Brand mark: a neuron whose axon becomes a check mark. Inline SVG so the
// report stays a single file; also used (URL-encoded) as the favicon.
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="neuron-reporter">'
  + '<defs><linearGradient id="nr-logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a78d6"/><stop offset="1" stop-color="#7b4fe0"/></linearGradient></defs>'
  + '<rect width="64" height="64" rx="16" fill="url(#nr-logo-g)"/>'
  + '<g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M22 26 L12 16 M22 26 L9 29 M22 26 L17 13.5" stroke-width="3" opacity="0.75"/>'
  + '<path d="M22 26 L29 44 L52 17" stroke-width="5"/></g>'
  + '<g fill="#fff"><circle cx="22" cy="26" r="6.5"/><circle cx="12" cy="16" r="2.6" opacity="0.85"/>'
  + '<circle cx="9" cy="29" r="2.6" opacity="0.85"/><circle cx="17" cy="13.5" r="2.2" opacity="0.85"/><circle cx="52" cy="17" r="3.4"/></g>'
  + '<circle cx="22" cy="26" r="2.4" fill="url(#nr-logo-g)"/></svg>';
const FAVICON = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;

// Set per render() call: the classifier in use.
let CLASSIFY = ReportHistory.defaultClassifier;

const STATUS_COLORS = {
  COMPLETED: { hex: '#0ca30c', label: 'Passed', icon: '✓' },
  FAILED: { hex: '#d03b3b', label: 'Failed', icon: '✕' },
  WARNED: { hex: '#fab219', label: 'Warned', icon: '⚠' },
  PENDING: { hex: '#898781', label: 'Pending', icon: '•' },
  SKIPPED: { hex: '#898781', label: 'Skipped', icon: '–' },
};
function statusInfo(status) {
  return STATUS_COLORS[status] || { hex: '#898781', label: status, icon: '?' };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function countLeaves(node) {
  if (!node.isGroup) return 1;
  if (node.children.length === 0) return 1; // skipped group, no children ever recorded
  return node.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

function collectScreenshots(nodes, acc = []) {
  for (const n of nodes) {
    if (n.screenshot) acc.push(n);
    if (n.children && n.children.length) collectScreenshots(n.children, acc);
  }
  return acc;
}

function fmtMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Only http(s), relative paths and data: URIs may become links — never javascript: and the like. */
function safeHref(href) {
  const s = String(href || '');
  if (/^(https?:|data:|\.{0,2}\/|[^:]*$)/i.test(s)) return s;
  return '#';
}

const MAX_TEXT_ATTACHMENT = 200 * 1024;

/** Logs, text, JSON, video, images, files and links attached to one step. */
function renderAttachments(list) {
  if (!list || !list.length) return '';
  const items = list.map((a) => {
    const kind = Attachments.kindOf(a);
    const name = esc(a.name || 'attachment');
    const size = a.size ? ` · ${fmtBytes(a.size)}` : '';
    if (kind === 'text') {
      const body = String(a.body);
      const cut = body.length > MAX_TEXT_ATTACHMENT;
      return `<details class="att"><summary><span class="att-icon">≡</span>${name}<span class="att-type">${esc(a.contentType || 'text')}${size}</span></summary><pre>${esc(cut ? body.slice(0, MAX_TEXT_ATTACHMENT) : body)}${cut ? '\n… (truncated)' : ''}</pre></details>`;
    }
    const src = esc(safeHref(a.dataUri || a.path));
    if (kind === 'video') {
      return `<details class="att"><summary><span class="att-icon">▶</span>${name}<span class="att-type">${esc(a.contentType)}${size}</span></summary><video controls preload="none" src="${src}"></video></details>`;
    }
    if (kind === 'image' && a.dataUri) {
      return `<a class="att att-link" onclick="openLightbox(this.dataset.src)" data-src="${src}"><span class="att-icon">▣</span>${name}</a>`;
    }
    const isTrace = /trace/i.test(a.name || '') && /zip/.test(a.contentType || '');
    const hint = isTrace ? '<span class="att-type">open with <code>npx playwright show-trace</code></span>' : `<span class="att-type">${esc(kind === 'link' ? 'link' : a.contentType || 'file')}${size}</span>`;
    const dl = a.dataUri ? ` download="${esc(a.name || 'attachment')}"` : ' target="_blank" rel="noopener"';
    return `<a class="att att-link" href="${src}"${dl}><span class="att-icon">↗</span>${name}${hint}</a>`;
  });
  return `<div class="node-attachments">${items.join('')}</div>`;
}

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** "Attempt 1 ✕ 1.2s · Attempt 2 ✓ 0.8s" with the first failure's message. */
function renderAttempts(node) {
  const attempts = node.attempts || [];
  if (attempts.length < 2) return '';
  const chips = attempts.map((a, i) => `<span class="attempt ${a.status === 'FAILED' ? 'bad' : 'ok'}" title="${esc(a.error || '')}">#${i + 1} ${statusInfo(a.status).icon} ${fmtMs(a.duration || 0)}</span>`).join('');
  const firstErr = attempts.find((a) => a.status === 'FAILED' && a.error);
  const msg = ReportHistory.isFlakyNode(node) && firstErr ? `<span class="attempt-msg">first failure: ${esc(firstErr.error.slice(0, 200))}</span>` : '';
  return `<div class="node-attempts"><span class="attempt-label">${attempts.length} attempts</span>${chips}${msg}</div>`;
}

function hasFlaky(node) {
  return ReportHistory.isFlakyNode(node) || (node.isGroup && (node.children || []).some(hasFlaky));
}

function renderNode(node, index) {
  const info = statusInfo(node.status);
  const flaky = hasFlaky(node);
  const topAttrs = index === undefined ? '' : ` id="case-${index}" data-status="${node.status}" data-flaky="${flaky}" data-text="${esc(String(node.description).toLowerCase())}"`;
  const evidence = node.screenshot
    ? `<a class="thumb-link" onclick="openLightbox(this.dataset.src)" data-src="${esc(node.screenshot.dataUri)}">View</a>`
    : '';
  const flakyChip = flaky ? '<span class="flaky-chip" title="Failed at least once, then passed on a retry">flaky</span>' : '';

  if (!node.isGroup) {
    const errorHtml = node.status === 'FAILED' && node.error
      ? `<div class="node-error">${esc(node.error)}</div>`
      : '';
    // Shown regardless of status — a passed assertion should still show
    // what it actually compared, not just a checkmark. See
    // StepReporter.attachDetail().
    const detailHtml = node.detail
      ? `<div class="node-detail">${esc(node.detail)}</div>`
      : '';
    return `
      <div class="node"${topAttrs}>
        <span class="status-icon" style="background:${info.hex}">${info.icon}</span>
        <span class="node-desc" title="${esc(node.description)}">${esc(node.description)}</span>
        ${flakyChip}
        ${index !== undefined ? `<span class="mini" aria-hidden="true"><i style="width:${Math.max(3, ((node.duration || 0) / CASE_MAX_DURATION) * 100)}%"></i></span>` : ''}
        <span class="node-dur">${fmtMs(node.duration)}</span>
        <span class="node-evidence">${evidence}</span>
        ${renderAttempts(node)}
        ${errorHtml}
        ${detailHtml}
        ${renderAttachments(node.attachments)}
      </div>`;
  }

  const leafCount = countLeaves(node);
  const childrenHtml = node.children.length
    ? node.children.map((c) => renderNode(c)).join('')
    : `<div class="node"><span class="node-desc" style="color:var(--text-muted)">No steps ran (condition was false)</span></div>`;

  return `
    <details class="group"${topAttrs}>
      <summary>
        <span class="chevron">▸</span>
        <span class="status-icon" style="background:${info.hex}">${info.icon}</span>
        <span class="node-desc">${esc(node.description)}</span>
        ${flakyChip}
        <span class="step-count">${leafCount} step${leafCount === 1 ? '' : 's'}</span>
        ${index !== undefined ? `<span class="mini" aria-hidden="true"><i style="width:${Math.max(3, ((node.duration || 0) / CASE_MAX_DURATION) * 100)}%"></i></span>` : ''}
        <span class="node-dur">${fmtMs(node.duration)}</span>
        ${index !== undefined ? `<span class="node-evidence">${evidence}</span>` : ''}
      </summary>
      ${(node.attachments && node.attachments.length) || (node.attempts && node.attempts.length > 1) || (node.error && node.status === 'FAILED') ? `<div class="group-attachments">${renderAttempts(node)}${node.error && node.status === 'FAILED' ? `<div class="node-error">${esc(node.error)}</div>` : ''}${renderAttachments(node.attachments)}</div>` : ''}
      <div class="group-children">${childrenHtml}</div>
    </details>`;
}

// ---------- Visual sections (all inline SVG/HTML, no external libraries) ----------

const STATUS_ORDER = ['COMPLETED', 'FAILED', 'WARNED'];

function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Step outcomes for this run as a donut — the headline next to the tiles. */
function renderDonut(steps) {
  const total = STATUS_ORDER.reduce((sum, k) => sum + (steps[k] || 0), 0);
  if (!total) return '';
  const r = 52;
  const C = 2 * Math.PI * r;
  const gap = total > 1 ? 2 : 0; // 2px surface gap between segments
  let offset = 0;
  const arcs = STATUS_ORDER.filter((k) => steps[k]).map((k) => {
    const len = (steps[k] / total) * C;
    const seg = `<circle class="tip" cx="70" cy="70" r="${r}" fill="none" stroke="${statusInfo(k).hex}" stroke-width="16"
      stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"
      data-tip="${statusInfo(k).label}: ${steps[k]} step${steps[k] === 1 ? '' : 's'} (${Math.round((steps[k] / total) * 100)}%)"></circle>`;
    offset += len;
    return seg;
  }).join('');
  const passPct = Math.round(((steps.COMPLETED || 0) / total) * 100);
  return `
    <div class="donut-card">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Step outcomes: ${STATUS_ORDER.map((k) => `${steps[k] || 0} ${statusInfo(k).label.toLowerCase()}`).join(', ')}">
        <circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--gridline)" stroke-width="16"></circle>
        ${arcs}
        <text x="70" y="68" text-anchor="middle" class="donut-num">${passPct}%</text>
        <text x="70" y="88" text-anchor="middle" class="donut-sub">steps passed</text>
      </svg>
      <ul class="legend">
        ${STATUS_ORDER.map((k) => `<li><span class="swatch" style="background:${statusInfo(k).hex}"></span>${statusInfo(k).icon} ${statusInfo(k).label}<b>${steps[k] || 0}</b></li>`).join('')}
      </ul>
    </div>`;
}

/** Every failed step in this run, tagged with its cause, linking to its test case. */
function renderFailureList(tree) {
  const failures = [];
  tree.forEach((n, index) => {
    for (const f of ReportHistory.collectFailures([n], CLASSIFY)) failures.push({ ...f, index });
  });
  if (!failures.length) {
    return `<div class="panel empty-ok"><span class="status-icon" style="background:${statusInfo('COMPLETED').hex}">✓</span> No failed steps in this run.</div>`;
  }
  return `
    <div class="panel failure-list">
      ${failures.map((f) => {
        const cat = CLASSIFY.info(f.category);
        return `
        <a class="failure" href="#case-${f.index}" onclick="openCase(${f.index}); return false;">
          <span class="status-icon" style="background:${statusInfo('FAILED').hex}">✕</span>
          <span class="failure-main">
            <span class="failure-step">${esc(f.step)}</span>
            <span class="failure-case">in ${esc(f.testCase)}</span>
            ${f.message ? `<span class="failure-msg">${esc(f.message.slice(0, 180))}</span>` : ''}
          </span>
          <span class="chip" title="${esc(cat.hint)}">${esc(cat.label)}</span>
        </a>`;
      }).join('')}
    </div>`;
}

/** The slowest individual steps of this run — where the time actually goes. */
function renderSlowest(tree, limit = 8) {
  const leaves = [];
  const walk = (nodes, tc) => {
    for (const n of nodes) {
      if (n.isGroup && n.children && n.children.length) walk(n.children, tc || n.description);
      else if (!n.isGroup) leaves.push({ ...n, testCase: tc || n.description });
    }
  };
  walk(tree, null);
  const top = leaves.sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, limit);
  if (!top.length) return '';
  const max = Math.max(...top.map((n) => n.duration || 0), 1);
  return `
    <div class="chart">
      ${top.map((n) => `
        <div class="chart-row tip" data-tip="${esc(n.description)} — ${fmtMs(n.duration)} (${statusInfo(n.status).label.toLowerCase()}, in ${esc(n.testCase)})">
          <div class="label" title="${esc(n.description)}">${esc(n.description)}</div>
          <div class="track"><div class="bar" style="width:${Math.max(2, (n.duration / max) * 100)}%; background:var(--accent)"></div></div>
          <div class="dur">${fmtMs(n.duration)}</div>
        </div>`).join('')}
    </div>`;
}

/** Tiny pass-rate trend for the KPI card — one line, last point marked. */
function sparkline(runs) {
  const vals = runs.map((r) => {
    const n = STATUS_ORDER.reduce((s, k) => s + (r.cases?.[k] || 0), 0);
    return n ? (r.cases?.COMPLETED || 0) / n : 0;
  });
  const W = 96, H = 26, n = vals.length;
  const x = (i) => (n === 1 ? W / 2 : 2 + (i / (n - 1)) * (W - 4));
  const y = (v) => H - 3 - v * (H - 6);
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true"><polyline points="${pts}"></polyline><circle cx="${x(n - 1)}" cy="${y(vals[n - 1])}" r="3"></circle></svg>`;
}

let CASE_MAX_DURATION = 1;

/**
 * Run details: any ordered { label: value } object, e.g.
 * { Environment: 'Staging', Device: 'Pixel 8', Build: 'main @ 1a2b3c' }.
 * Empty values are skipped; execution time is appended.
 */
function renderRunInfo(info, totalDuration) {
  const rows = [...Object.entries(info), ['Execution time', fmtDuration(totalDuration)]]
    .filter(([, v]) => v !== undefined && v !== null && v !== '');
  return `<dl class="details">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join('')}</dl>`;
}

/**
 * One line chart for one measure across runs. A single series, so no legend
 * box (the heading names it); each point has a hover column with a guide line.
 */
function lineChart({ values, labels, tips, yMax, yFmt, ariaLabel, hollow = [] }) {
  // Drawn at roughly the width it renders at (the page is ~950px wide), so
  // axis text stays at its real size instead of scaling up with the SVG.
  const W = 940;
  const H = 170;
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 22;
  const n = values.length;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / (yMax || 1)) * plotH;
  const ticks = [0, 0.5, 1].map((f) => yMax * f);
  const grid = ticks.map((t) => `
    <line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" class="grid"></line>
    <text x="${padL - 8}" y="${y(t) + 4}" class="axis" text-anchor="end">${esc(yFmt(t))}</text>`).join('');
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const area = n > 1 ? `<path class="area" d="M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z"></path>` : '';
  const slot = n > 1 ? plotW / (n - 1) : plotW;
  const hits = values.map((v, i) => `
    <g class="hit tip" data-tip="${esc(tips[i])}">
      <rect x="${x(i) - slot / 2}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"></rect>
      <line class="guide" x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${padT + plotH}"></line>
      <circle class="pt${hollow[i] ? ' fail' : ''}" cx="${x(i)}" cy="${y(v)}" r="4.5"></circle>
    </g>`).join('');
  const xLabels = labels.map((l, i) => (l ? `<text x="${x(i)}" y="${H - 5}" class="axis${i === n - 1 ? ' now' : ''}" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${esc(l)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="svg-chart line-chart" role="img" aria-label="${esc(ariaLabel)}">${grid}${area}<polyline class="series" points="${pts.join(' ')}"></polyline>${hits}${xLabels}</svg>`;
}

/**
 * Run history as line charts — pass rate and duration as two separate
 * charts, each on its own axis (never one dual-axis chart).
 */
function renderHistory(runs) {
  if (!runs || runs.length < 2) {
    return `<div class="panel muted-note">History starts with this run — trend lines appear from the second run of this spec on.</div>`;
  }
  const n = runs.length;
  const casesOf = (r) => STATUS_ORDER.reduce((s, k) => s + (r.cases?.[k] || 0), 0);
  const passRate = runs.map((r) => (casesOf(r) ? ((r.cases?.COMPLETED || 0) / casesOf(r)) * 100 : 0));
  const durations = runs.map((r) => (r.duration || 0) / 60000);
  const every = Math.max(1, Math.ceil(n / 6));
  const labels = runs.map((r, i) => (i === n - 1 ? 'this run' : i % every === 0 ? fmtWhen(r.startedAt) : ''));
  const tipBase = (r) => `${fmtWhen(r.startedAt)} · ${r.cases?.COMPLETED || 0} passed, ${r.cases?.FAILED || 0} failed, ${r.cases?.WARNED || 0} warned of ${casesOf(r)}`;
  const maxDur = Math.max(...durations, 0.1);
  const durMax = maxDur <= 1 ? 1 : Math.ceil(maxDur / 2) * 2;
  const avgPass = passRate.reduce((a, b) => a + b, 0) / n;
  const failedRuns = runs.filter((r) => r.status === 'FAILED').length;
  const hollow = runs.map((r) => r.status === 'FAILED');
  return `
    <div class="panel">
      <div class="chart-head"><span>Pass rate per run</span><span class="muted">average ${avgPass.toFixed(1)}% · ○ = run had failures</span></div>
      ${lineChart({
        values: passRate, labels, yMax: 100, yFmt: (t) => `${Math.round(t)}%`, hollow,
        tips: runs.map((r, i) => `${tipBase(r)} — ${passRate[i].toFixed(1)}% passed`),
        ariaLabel: `Pass rate over the last ${n} runs, average ${avgPass.toFixed(1)} percent`,
      })}
      <div class="chart-head"><span>Execution time per run</span><span class="muted">longest ${fmtDuration(maxDur * 60000)}</span></div>
      ${lineChart({
        values: durations, labels, yMax: durMax, yFmt: (t) => `${t % 1 ? t.toFixed(1) : t}m`, hollow,
        tips: runs.map((r) => `${tipBase(r)} — ${fmtDuration(r.duration || 0)}`),
        ariaLabel: `Execution time over the last ${n} runs`,
      })}
      <div class="muted small">${n} runs recorded · ${failedRuns} with failures · hover a point for details</div>
    </div>`;
}

function verdictChip(s) {
  if (s.flaky) {
    const why = s.retriedRuns ? `passed on a retry in ${s.retriedRuns} run(s)` : `switched between pass and fail ${s.flips} times`;
    return `<span class="flaky-chip" title="${esc(why)}">flaky</span>`;
  }
  const notRun = s.notRun ? ` (did not run in ${s.notRun} run${s.notRun === 1 ? '' : 's'})` : '';
  if (s.consistent) return `<span class="chip bad" title="${esc(`Failed in every run it ran in since it first failed${notRun}`)}">consistent</span>`;
  return `<span class="chip" title="${esc(`Failed, then kept passing${notRun}`)}">fixed?</span>`;
}

const STRIP = { F: ['f', 'failed'], R: ['r', 'passed on a retry'], P: ['p', 'passed'], '-': ['n', 'did not run'] };

/** Last up-to-12 outcomes as small squares: red failed, amber passed on retry, green passed, grey did not run. */
function outcomeStrip(outcomes = []) {
  const last = outcomes.slice(-12).map((o) => STRIP[o] || STRIP.P);
  return `<span class="strip" role="img" aria-label="${last.map(([, label]) => label).join(', ')}">${last.map(([cls, label]) => `<i class="${cls}" title="${label}"></i>`).join('')}</span>`;
}

/** This run's steps that failed and then passed on a retry. */
function renderFlakyList(tree) {
  const flaky = [];
  tree.forEach((n, index) => {
    for (const f of ReportHistory.collectFlaky([n])) flaky.push({ ...f, index });
  });
  if (!flaky.length) return '';
  return `
    <div class="card">
      <div class="card-head"><h2>Flaky this run <span class="count">${flaky.length}</span></h2><span class="card-hint">failed, then passed on a retry</span></div>
      <div class="panel failure-list">
        ${flaky.map((f) => `
        <a class="failure" href="#case-${f.index}" onclick="openCase(${f.index}); return false;">
          <span class="status-icon" style="background:${statusInfo('WARNED').hex}">↻</span>
          <span class="failure-main">
            <span class="failure-step">${esc(f.step)}</span>
            <span class="failure-case">in ${esc(f.testCase)} · passed on attempt ${f.attempts}</span>
            ${f.message ? `<span class="failure-msg">${esc(f.message.slice(0, 180))}</span>` : ''}
          </span>
          <span class="flaky-chip">flaky</span>
        </a>`).join('')}
      </div>
    </div>`;
}

/** Every attachment in the run, grouped under the step it belongs to. */
function renderAttachmentsTab(tree) {
  const all = Attachments.collect(tree);
  return `
    <div class="cases att-list">
      ${all.map((a) => `
        <div class="node">
          <span class="status-icon" style="background:${statusInfo(a.status).hex}">${statusInfo(a.status).icon}</span>
          <span class="node-desc" title="${esc(a.step)}">${esc(a.step)} <span class="muted">· ${esc(a.testCase)}</span></span>
          ${renderAttachments([a])}
        </div>`).join('')}
    </div>`;
}

/** Causes that keep coming back across all recorded runs. */
function renderCommonIssues(runs) {
  const issues = ReportHistory.commonIssues(runs || [], CLASSIFY);
  const anyFlaky = (runs || []).some((r) => (r.flaky || []).length);
  if (!issues.length && !anyFlaky) {
    return `<div class="panel empty-ok"><span class="status-icon" style="background:${statusInfo('COMPLETED').hex}">✓</span> No failures recorded across ${runs?.length || 0} run(s).</div>`;
  }
  const max = Math.max(...issues.map((i) => i.count), 1);
  const steps = ReportHistory.flakySteps(runs).slice(0, 8);
  return `
    <div class="panel"${issues.length ? '' : ' hidden'}>
      ${issues.map((i) => `
        <div class="issue">
          <div class="issue-top">
            <span class="issue-label">${esc(i.label)}</span>
            <span class="issue-meta">${i.count}× in ${i.runsAffected} of ${runs.length} runs · last ${fmtWhen(i.lastSeen)}</span>
          </div>
          <div class="track"><div class="bar" style="width:${Math.max(3, (i.count / max) * 100)}%; background:var(--accent)"></div></div>
          ${i.hint ? `<div class="issue-hint">${esc(i.hint)}</div>` : ''}
          <div class="issue-example" title="${esc(i.example || '')}">e.g. ${esc((i.topStep ? `${i.topStep}: ` : '') + (i.example || '').slice(0, 160))}</div>
        </div>`).join('')}
    </div>
    ${steps.length ? `
    <div class="panel table-panel">
      <table>
        <thead><tr><th>Step that failed or was retried</th><th>Verdict</th><th>Cause</th><th class="num">Failed in</th><th class="num">Retried in</th><th>Last runs</th><th class="num">Last</th></tr></thead>
        <tbody>
          ${steps.map((s) => `<tr><td title="${esc(s.testCase)}">${esc(s.step)}</td><td>${verdictChip(s)}</td><td>${s.category ? `<span class="chip">${esc(CLASSIFY.info(s.category).label)}</span>` : '<span class="muted">—</span>'}</td><td class="num">${s.failedRuns}/${runs.length}</td><td class="num">${s.retriedRuns}</td><td>${outcomeStrip(s.outcomes)}</td><td class="num">${fmtWhen(s.lastSeen)}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}`;
}

/**
 * @param {Object} opts
 * @param {string} opts.title - Report title (e.g. flow name / spec name)
 * @param {string} opts.subtitle - Raw HTML shown under the title (e.g. `Run <code>...</code>`) — NOT escaped, caller must esc() any dynamic parts itself
 * @param {Object<string,string>} [opts.envVars] - Shown as `key=value` chips in the header
 * @param {Array} opts.tree - Top-level nodes, see file header for shape
 * @param {Array} [opts.history] - Past runs (history.record), this run last; enables the Trends tab
 * @param {Object} [opts.runInfo] - Ordered { label: value } facts for the Run details card
 * @param {string[]} [opts.highlights] - Short facts shown under the headline (device, version, ...)
 * @param {Function} [opts.classify] - Failure classifier from history.createClassifier()
 * @returns {string} Self-contained HTML document
 */
function render({ title, subtitle = '', envVars = {}, labels = null, tree: rawTree, history = null, runInfo: rawRunInfo = null, highlights: rawHighlights = [], classify = null, redact }) {
  CLASSIFY = classify || ReportHistory.defaultClassifier;
  // Everything textual is redacted before it reaches the page (see redact.js).
  const R = typeof redact === 'function' ? redact : Redact.createRedactor(redact === undefined ? {} : redact);
  const tree = Redact.redactTree(rawTree, R);
  const runInfo = Redact.redactObject(rawRunInfo, R);
  const highlights = (rawHighlights || []).map((h) => (typeof h === 'string' ? R(h) : h));
  const pills = Redact.redactObject(labels || envVars, R);
  const total = tree.length;
  const counts = { COMPLETED: 0, FAILED: 0, WARNED: 0, OTHER: 0 };
  let totalDuration = 0;
  for (const n of tree) {
    counts[n.status in counts ? n.status : 'OTHER'] += 1;
    totalDuration += n.duration || 0;
  }
  const overallStatus = counts.FAILED > 0 ? 'FAILED' : counts.WARNED > 0 ? 'WARNED' : 'COMPLETED';
  const maxDuration = Math.max(...tree.map((n) => n.duration || 0), 1);
  CASE_MAX_DURATION = maxDuration;
  const checkpointScreenshots = collectScreenshots(tree);
  const steps = ReportHistory.leafCounts(tree);
  const totalSteps = STATUS_ORDER.reduce((sum, k) => sum + (steps[k] || 0), 0);
  const runs = history || [];
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace(/\.0$/, '')}%` : '—');
  const executed = counts.COMPLETED + counts.FAILED + counts.WARNED;
  const leafDurations = [];
  (function walk(nodes) { for (const n of nodes) { if (n.isGroup && n.children && n.children.length) walk(n.children); else if (!n.isGroup) leafDurations.push(n.duration || 0); } })(tree);
  const avgStep = leafDurations.length ? leafDurations.reduce((a, b) => a + b, 0) / leafDurations.length : 0;
  const failuresNow = ReportHistory.collectFailures(tree, CLASSIFY);
  const triage = { defect: 0, script: 0, environment: 0 };
  for (const f of failuresNow) triage[CLASSIFY.info(f.category).type || 'script'] += 1;
  const flakyNow = ReportHistory.collectFlaky(tree);
  const flakyCases = tree.filter(hasFlaky).length;
  const attachmentCount = Attachments.collect(tree).length;

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — test report</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<style>
  :root {
    color-scheme: light;
    --surface-1: #ffffff;
    --surface-2: #f3f4f6;
    --text-primary: #16181d;
    --text-secondary: #4a4f57;
    --text-muted: #868b93;
    --gridline: #e3e5e9;
    --border: rgba(22,24,29,0.10);
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
    --accent: #2a78d6;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1f2023;
      --surface-2: #151618;
      --text-primary: #eceef1;
      --text-secondary: #b8bcc3;
      --text-muted: #868b93;
      --gridline: #2f3136;
      --border: rgba(255,255,255,0.09);
      --good: #0ca30c;
      --warning: #fab219;
      --critical: #e66767;
      --accent: #3987e5;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1f2023;
    --surface-2: #151618;
    --text-primary: #eceef1;
    --text-secondary: #b8bcc3;
    --text-muted: #868b93;
    --gridline: #2f3136;
    --border: rgba(255,255,255,0.09);
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #e66767;
    --accent: #3987e5;
  }

  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: var(--surface-2);
    color: var(--text-primary);
    margin: 0;
    padding: 32px 16px 64px;
  }
  .wrap { max-width: 980px; margin: 0 auto; }

  header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--text-secondary); font-size: 13px; }
  .meta code { background: var(--surface-1); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }

  .theme-toggle {
    background: var(--surface-1); border: 1px solid var(--border); color: var(--text-secondary);
    border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer;
  }

  .badge { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; padding: 4px 10px; border-radius: 999px; }
  .badge.good { color: var(--good); background: color-mix(in srgb, var(--good) 14%, transparent); }
  .badge.critical { color: var(--critical); background: color-mix(in srgb, var(--critical) 14%, transparent); }
  .badge.warning { color: var(--warning); background: color-mix(in srgb, var(--warning) 18%, transparent); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .tile .label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
  .tile .value { font-size: 26px; font-weight: 600; }
  .tile.good .value { color: var(--good); }
  .tile.critical .value { color: var(--critical); }
  .tile.warning .value { color: var(--warning); }

  section { margin-bottom: 32px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-secondary); margin: 0 0 12px; }
  h2 .hint { text-transform: none; letter-spacing: normal; font-weight: 400; color: var(--text-muted); }

  .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
  .gallery figure { margin: 0; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; cursor: pointer; }
  .gallery img { width: 100%; display: block; aspect-ratio: 9/19; object-fit: cover; object-position: top; }
  .gallery figcaption { font-size: 12px; color: var(--text-secondary); padding: 8px 10px; }

  .chart { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px; max-height: 420px; overflow-y: auto; }
  .chart-row { display: grid; grid-template-columns: 220px 1fr 56px; align-items: center; gap: 10px; padding: 3px 0; }
  .chart-row .label { font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chart-row .track { background: var(--surface-2); border-radius: 4px; height: 12px; position: relative; }
  .chart-row .bar { height: 12px; border-radius: 4px; }
  .chart-row .dur { font-size: 11px; color: var(--text-muted); text-align: right; font-variant-numeric: tabular-nums; }

  .thumb-link { color: var(--accent); font-size: 12px; text-decoration: none; }
  .thumb-link:hover { text-decoration: underline; }

  .cases { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }

  .status-icon { width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: white; flex-shrink: 0; }

  .node {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 9px 14px 9px 40px;
    font-size: 13px; border-bottom: 1px solid var(--gridline);
  }
  .cases > .node:last-child, .cases > details.group:last-child { border-bottom: none; }
  .node-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .node-dur { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .node-evidence { width: 40px; text-align: right; flex-shrink: 0; }
  .node-error {
    flex-basis: 100%; margin-top: 2px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.5; color: var(--critical);
    background: color-mix(in srgb, var(--critical) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--critical) 25%, transparent);
    border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; word-break: break-word;
  }
  .node-detail {
    flex-basis: 100%; margin-top: 2px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.5; color: var(--text-secondary);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 10px; white-space: pre-wrap; word-break: break-word;
  }

  details.group { border-bottom: 1px solid var(--gridline); }
  details.group:last-child { border-bottom: none; }
  details.group summary {
    display: flex; align-items: center; gap: 10px; padding: 11px 14px;
    font-size: 13px; font-weight: 600; cursor: pointer; list-style: none;
  }
  details.group summary::-webkit-details-marker { display: none; }
  details.group summary .node-desc { font-weight: 600; }
  details.group .chevron { display: inline-block; transition: transform 0.15s ease; color: var(--text-muted); font-size: 11px; width: 10px; }
  details.group[open] > summary .chevron { transform: rotate(90deg); }
  .step-count {
    font-size: 11px; font-weight: 500; color: var(--text-secondary); background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; white-space: nowrap;
  }
  .group-children { background: var(--surface-2); }
  .group-children .node { padding-left: 56px; }
  .group-children details.group summary { padding-left: 40px; }
  .group-children .group-children .node { padding-left: 82px; }
  .group-children .group-children details.group summary { padding-left: 66px; }

  .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); align-items: center; justify-content: center; z-index: 10; cursor: zoom-out; }
  .lightbox.open { display: flex; }
  .lightbox img { max-height: 90vh; max-width: 90vw; border-radius: 8px; }

  /* ---- overview ---- */
  .overview { display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr); gap: 16px; margin-bottom: 28px; }
  @media (max-width: 720px) { .overview { grid-template-columns: 1fr; } }
  .panel { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; }
  /* Donut and legend side by side, never wrapping: the card is ~300px wide,
     which used to push the legend onto its own row and leave a tall gap. */
  .donut-card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; padding: 16px; display: grid; grid-template-columns: 120px minmax(0, 1fr); align-items: center; gap: 18px; }
  .donut-card svg { width: 120px; height: 120px; }
  .overview { align-items: start; }
  .donut-num { font-size: 26px; font-weight: 650; fill: var(--text-primary); }
  .donut-sub { font-size: 11px; fill: var(--text-secondary); }
  .legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; font-size: 13px; color: var(--text-secondary); }
  .legend li { display: flex; align-items: center; gap: 8px; }
  .legend b { margin-left: auto; padding-left: 12px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .legend.inline { display: flex; gap: 14px; font-size: 12px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
  .muted, .muted-note { color: var(--text-muted); }
  .small { font-size: 12px; margin-top: 8px; }
  .empty-ok { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-secondary); }

  .failure-list { padding: 4px 0; max-height: 300px; overflow-y: auto; }
  .failure { display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px; text-decoration: none; color: inherit; border-bottom: 1px solid var(--gridline); }
  .failure:last-child { border-bottom: none; }
  .failure:hover { background: var(--surface-2); }
  .failure-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .failure-step { font-size: 13px; font-weight: 600; }
  .failure-case { font-size: 12px; color: var(--text-secondary); }
  .failure-msg { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip { font-size: 11px; font-weight: 500; color: var(--text-secondary); background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; white-space: nowrap; }

  .chart-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin: 4px 0 6px; }
  .svg-chart { width: 100%; height: auto; display: block; margin-bottom: 10px; }
  .svg-chart .grid { stroke: var(--gridline); stroke-width: 1; }
  .svg-chart .axis { font-size: 10px; fill: var(--text-muted); }
  .svg-chart .now { fill: var(--text-secondary); font-weight: 600; }
  .svg-chart g.tip:hover rect:not([fill="transparent"]) { opacity: 0.8; }

  .issue { padding: 10px 0; border-bottom: 1px solid var(--gridline); }
  .issue:first-child { padding-top: 0; }
  .issue:last-child { border-bottom: none; padding-bottom: 0; }
  .issue-top { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
  .issue-label { font-weight: 600; }
  .issue-meta { color: var(--text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .issue .track { background: var(--surface-2); border-radius: 4px; height: 8px; }
  .issue .bar { height: 8px; border-radius: 4px; }
  .issue-hint { font-size: 12px; color: var(--text-secondary); margin-top: 6px; }
  .issue-example { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .table-panel { padding: 0; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); font-weight: 600; padding: 10px 16px; border-bottom: 1px solid var(--gridline); }
  td { padding: 9px 16px; border-bottom: 1px solid var(--gridline); }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
  .toolbar button { background: var(--surface-1); border: 1px solid var(--border); color: var(--text-secondary); border-radius: 999px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
  .toolbar button.active { color: var(--text-primary); border-color: var(--text-secondary); font-weight: 600; }
  .toolbar input { flex: 1; min-width: 160px; background: var(--surface-1); border: 1px solid var(--border); color: var(--text-primary); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
  .cases > .hidden { display: none; }
  .flash { animation: flash 1.2s ease; }
  @keyframes flash { from { background: color-mix(in srgb, var(--accent) 18%, transparent); } to { background: transparent; } }

  .unit { font-size: 14px; font-weight: 500; color: var(--text-muted); margin-left: 4px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 8px; vertical-align: middle; position: relative; top: -3px; }
  .tiles + h2, .run-info + h2 { margin-top: 0; }
  .tiles { margin-bottom: 12px; }
  .tiles:last-of-type { margin-bottom: 28px; }
  .run-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0; margin-bottom: 24px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .run-info div { padding: 10px 14px; border-right: 1px solid var(--gridline); border-bottom: 1px solid var(--gridline); min-width: 0; }
  .run-info dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin-bottom: 3px; }
  .run-info dd { margin: 0; font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .triage { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .triage b { color: var(--text-primary); margin-left: 4px; }
  .line-chart .series { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .line-chart .area { fill: color-mix(in srgb, var(--accent) 10%, transparent); }
  .line-chart .pt { fill: var(--accent); stroke: var(--surface-1); stroke-width: 2; }
  .line-chart .pt.fail { fill: var(--surface-1); stroke: var(--accent); stroke-width: 2; }
  .line-chart .guide { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0; }
  .line-chart g.hit:hover .guide { opacity: 1; }
  .line-chart g.hit:hover .pt { r: 6; }
  /* ================= redesign ================= */
  body { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--surface-2); padding: 0 16px 72px; line-height: 1.45; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1040px; }
  h2 { font-size: 15px; font-weight: 650; text-transform: none; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }

  .hero { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; align-items: center; padding: 40px 0 28px; margin: 0; }
  .brand { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 14px; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-secondary); text-decoration: none; }
  .brand svg { width: 26px; height: 26px; flex: none; border-radius: 7px; box-shadow: 0 1px 2px rgba(0,0,0,0.12); }
  @media print { .brand svg { box-shadow: none; } }
  .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; }
  .hero h1 { font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 700; margin: 0 0 6px; }
  .hero-sub { font-size: 15px; color: var(--text-secondary); margin: 0 0 14px; }
  .hero-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 13px; color: var(--text-secondary); }
  .hero-meta > span:not(.pill) + span:not(.pill)::before { content: "·"; margin-right: 14px; color: var(--text-muted); }
  .pill { background: var(--surface-1); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; font-size: 12px; }
  .hero-ring .donut-card { background: none; border: none; padding: 0; grid-template-columns: 132px auto; }
  .hero-ring .donut-card svg { width: 132px; height: 132px; }
  .theme-toggle { position: absolute; top: 16px; right: 0; width: 34px; height: 34px; padding: 0; border-radius: 50%; font-size: 15px; line-height: 1; }
  @media (max-width: 720px) { .hero { grid-template-columns: 1fr; padding-top: 52px; } .hero h1 { font-size: 26px; } }

  .tabs { position: sticky; top: 0; z-index: 5; display: flex; gap: 4px; padding: 10px 0; margin-bottom: 20px; background: var(--surface-2); border-bottom: 1px solid var(--gridline); overflow-x: auto; }
  .tabs button { border: none; background: none; color: var(--text-secondary); font: inherit; font-size: 14px; font-weight: 550; padding: 7px 14px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
  .tabs button:hover { background: var(--surface-1); color: var(--text-primary); }
  .tabs button.active { background: var(--surface-1); color: var(--text-primary); box-shadow: 0 0 0 1px var(--border); }
  .count { display: inline-block; min-width: 20px; margin-left: 4px; padding: 0 6px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--surface-2); color: var(--text-secondary); text-align: center; }
  .tabs button.active .count { background: var(--surface-2); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
  @media (max-width: 820px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .kpi, .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .kpi { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; min-height: 118px; }
  .kpi-label { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
  .kpi-value { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .kpi-foot { margin-top: auto; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted); }
  .spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.75; stroke-linejoin: round; stroke-linecap: round; }
  .spark circle { fill: var(--accent); }
  .triage-mini { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: auto; }
  .triage-mini div { background: var(--surface-2); border-radius: 10px; padding: 8px 6px; text-align: center; }
  .triage-mini b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .triage-mini span { font-size: 11px; color: var(--text-secondary); }

  .split { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; align-items: start; }
  @media (max-width: 820px) { .split { grid-template-columns: 1fr; } }
  .card { padding: 18px 20px; margin-bottom: 14px; }
  .split .card { margin-bottom: 0; }
  .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .card-hint { font-size: 12px; color: var(--text-muted); }
  .card .panel, .card .chart { background: none; border: none; border-radius: 0; padding: 0; margin: 0; max-height: none; }
  .card .failure-list { margin: 0 -20px -18px; max-height: 340px; }
  .card .failure { padding: 12px 20px; }
  .card .empty-ok { padding: 6px 0 2px; }

  .details { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px 16px; margin: 0; font-size: 13px; }
  .details dt { color: var(--text-muted); }
  .details dd { margin: 0; text-align: right; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .toolbar { gap: 10px; margin-bottom: 14px; }
  .seg { display: inline-flex; background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 3px; gap: 2px; }
  .toolbar .seg button { border: none; border-radius: 7px; padding: 5px 12px; font-size: 13px; background: none; }
  .toolbar .seg button.active { background: var(--surface-2); color: var(--text-primary); }
  .toolbar input { border-radius: 10px; padding: 8px 12px; }
  .toolbar button.ghost { border-radius: 10px; padding: 7px 12px; font-size: 13px; }
  .cases { border-radius: 14px; }
  details.group summary { padding: 13px 16px; }
  .cases > .node { padding-left: 36px; }
  .node-dur { min-width: 52px; text-align: right; }
  .mini { width: 90px; height: 4px; border-radius: 4px; background: var(--surface-2); overflow: hidden; flex-shrink: 0; }
  .mini i { display: block; height: 100%; border-radius: 4px; background: var(--text-muted); opacity: 0.6; }
  @media (max-width: 620px) { .mini { display: none; } }

  .gallery { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 16px; }
  .gallery figure { border-radius: 14px; transition: transform 0.12s ease, box-shadow 0.12s ease; }
  .gallery figure:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.12); }
  .gallery figure.is-fail { box-shadow: 0 0 0 2px var(--critical); }
  .gallery figcaption { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; line-height: 1.35; padding: 10px 12px; color: var(--text-secondary); }
  .shot-n { flex-shrink: 0; font-size: 11px; font-weight: 600; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .shot-tag { margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--critical); }

  @media print { .tabs, .theme-toggle, .toolbar { display: none; } .tab-panel { display: block !important; } }

  /* ---- flaky + attempts ---- */
  .flaky-chip { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #9a6a00; background: color-mix(in srgb, var(--warning) 22%, transparent); border-radius: 999px; padding: 2px 8px; white-space: nowrap; }
  :root[data-theme="dark"] .flaky-chip { color: var(--warning); }
  @media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) .flaky-chip { color: var(--warning); } }
  .chip.bad { color: var(--critical); border-color: color-mix(in srgb, var(--critical) 35%, transparent); }
  .node-attempts { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); }
  .attempt-label { font-weight: 600; }
  .attempt { font-variant-numeric: tabular-nums; border-radius: 6px; padding: 1px 7px; border: 1px solid var(--border); background: var(--surface-1); }
  .attempt.bad { color: var(--critical); }
  .attempt.ok { color: var(--good); }
  .attempt-msg { flex-basis: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .strip { display: inline-flex; gap: 2px; vertical-align: middle; }
  .strip i { width: 8px; height: 12px; border-radius: 2px; display: inline-block; }
  .strip i.p { background: var(--good); opacity: 0.7; }
  .strip i.f { background: var(--critical); }
  .strip i.r { background: var(--warning); }
  .strip i.n { background: repeating-linear-gradient(135deg, transparent 0 2px, color-mix(in srgb, var(--text-muted) 55%, transparent) 2px 3px); box-shadow: inset 0 0 0 1px var(--text-secondary); }
  /* ---- attachments ---- */
  .node-attachments { flex-basis: 100%; display: flex; flex-direction: column; gap: 6px; }
  .group-attachments { padding: 0 16px 10px 40px; }
  .att { font-size: 12px; background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; }
  .att > summary, .att-link { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; list-style: none; color: var(--text-primary); text-decoration: none; }
  .att > summary::-webkit-details-marker { display: none; }
  .att-link:hover, .att > summary:hover { background: var(--surface-2); }
  .att-icon { width: 16px; text-align: center; color: var(--accent); font-weight: 700; }
  .att-type { margin-left: auto; font-size: 11px; color: var(--text-muted); }
  .att pre { margin: 0; padding: 10px 12px; max-height: 360px; overflow: auto; border-top: 1px solid var(--gridline); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .att video { display: block; width: 100%; max-height: 480px; background: #000; border-top: 1px solid var(--gridline); border-radius: 0 0 8px 8px; }
  .att-list .node { padding-left: 16px; }

  #tooltip { position: fixed; pointer-events: none; z-index: 20; max-width: 320px; background: var(--text-primary); color: var(--surface-1); font-size: 12px; line-height: 1.4; padding: 6px 9px; border-radius: 6px; opacity: 0; transition: opacity 0.08s; }
  #tooltip.show { opacity: 1; }
  .tip { cursor: default; }
</style>

<div class="wrap">
  <header class="hero">
    <div class="hero-text">
      <div class="brand">${LOGO_SVG}<span>neuron-reporter</span></div>
      <div class="eyebrow">${esc([runInfo && (runInfo.Environment || runInfo.environment), title].filter(Boolean).join(' · '))}</div>
      <h1>${counts.COMPLETED} of ${total} test case${total === 1 ? '' : 's'} passed</h1>
      <p class="hero-sub">${counts.FAILED ? `${counts.FAILED} failed` : 'No failures'}${counts.WARNED ? ` · ${counts.WARNED} warned` : ''}${flakyNow.length ? ` · ${flakyNow.length} flaky` : ''} · ${totalSteps} steps in ${fmtDuration(totalDuration)}</p>
      <div class="hero-meta">
        ${subtitle ? `<span>${subtitle}</span>` : ''}
        ${highlights.filter(Boolean).map((h) => `<span>${esc(h)}</span>`).join('')}
        ${Object.entries(pills).filter(([k]) => !k.startsWith('MAESTRO_')).map(([k, v]) => `<span class="pill">${esc(k.toLowerCase().replace(/_/g, ' '))}: ${esc(v)}</span>`).join('')}
      </div>
    </div>
    <div class="hero-ring">${renderDonut(steps)}</div>
    <button class="theme-toggle" onclick="toggleTheme()" title="Toggle light / dark">◐</button>
  </header>

  <nav class="tabs" role="tablist">
    <button role="tab" data-tab="overview" onclick="showTab('overview')">Overview</button>
    <button role="tab" data-tab="cases" onclick="showTab('cases')">Test cases <span class="count">${total}</span></button>
    ${checkpointScreenshots.length ? `<button role="tab" data-tab="shots" onclick="showTab('shots')">Screenshots <span class="count">${checkpointScreenshots.length}</span></button>` : ''}
    ${attachmentCount ? `<button role="tab" data-tab="files" onclick="showTab('files')">Attachments <span class="count">${attachmentCount}</span></button>` : ''}
    ${history ? `<button role="tab" data-tab="trends" onclick="showTab('trends')">Trends <span class="count">${runs.length}</span></button>` : ''}
  </nav>

  <section class="tab-panel" data-panel="overview">
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-label">Pass rate</div>
        <div class="kpi-value">${pct(counts.COMPLETED, executed)}</div>
        <div class="kpi-foot">${runs.length > 1 ? `${sparkline(runs)}<span>last ${runs.length} runs</span>` : `<span>${counts.COMPLETED} passed · ${counts.FAILED} failed</span>`}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Step pass rate</div>
        <div class="kpi-value">${pct(steps.COMPLETED || 0, totalSteps)}</div>
        <div class="kpi-foot"><span>${steps.COMPLETED || 0} of ${totalSteps} steps</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Execution time</div>
        <div class="kpi-value">${fmtDuration(totalDuration)}</div>
        <div class="kpi-foot"><span>avg ${fmtMs(Math.round(avgStep))} per step</span></div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Failure triage</div>
        <div class="triage-mini">
          ${Object.entries(ReportHistory.TRIAGE).map(([k, t]) => `<div class="tip" data-tip="${esc(t.hint)}"><b>${triage[k]}</b><span>${esc(t.short)}</span></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="split">
      <div class="card">
        <div class="card-head"><h2>Failures</h2><span class="card-hint">${failuresNow.length ? 'click one to open it' : ''}</span></div>
        ${renderFailureList(tree)}
      </div>
      ${runInfo && Object.keys(runInfo).length ? `<div class="card">
        <div class="card-head"><h2>Run details</h2></div>
        ${renderRunInfo(runInfo, totalDuration)}
      </div>` : ''}
    </div>

    ${renderFlakyList(tree)}

    <div class="card">
      <div class="card-head"><h2>Slowest steps</h2><span class="card-hint">where this run's time went</span></div>
      ${renderSlowest(tree)}
    </div>
  </section>

  <section class="tab-panel" data-panel="cases">
    <div class="toolbar">
      <div class="seg">
        <button class="active" data-filter="ALL" onclick="filterCases('ALL', this)">All <span class="count">${total}</span></button>
        <button data-filter="FAILED" onclick="filterCases('FAILED', this)">Failed <span class="count">${counts.FAILED}</span></button>
        <button data-filter="WARNED" onclick="filterCases('WARNED', this)">Warned <span class="count">${counts.WARNED}</span></button>
        <button data-filter="COMPLETED" onclick="filterCases('COMPLETED', this)">Passed <span class="count">${counts.COMPLETED}</span></button>
        ${flakyCases ? `<button data-filter="FLAKY" onclick="filterCases('FLAKY', this)">Flaky <span class="count">${flakyCases}</span></button>` : ''}
      </div>
      <input type="search" placeholder="Search test cases" oninput="searchCases(this.value)">
      <button class="ghost" onclick="setAll(true)">Expand all</button>
      <button class="ghost" onclick="setAll(false)">Collapse all</button>
    </div>
    <div class="cases" id="case-list">
      ${tree.map((n, i) => renderNode(n, i)).join('')}
    </div>
  </section>

  ${checkpointScreenshots.length ? `
  <section class="tab-panel" data-panel="shots">
    <div class="gallery">
      ${checkpointScreenshots.map((s, i) => `
        <figure onclick="openLightbox(this.dataset.src)" data-src="${esc(s.screenshot.dataUri)}" class="${/^Failure/.test(s.screenshot.caption) ? 'is-fail' : ''}">
          <img src="${s.screenshot.dataUri}" alt="${esc(s.screenshot.caption)}" loading="lazy">
          <figcaption><span class="shot-n">${i + 1}</span>${esc(s.screenshot.caption.replace(/^Failure — /, ''))}${/^Failure/.test(s.screenshot.caption) ? '<span class="shot-tag">failure</span>' : ''}</figcaption>
        </figure>
      `).join('')}
    </div>
  </section>` : ''}

  ${attachmentCount ? `
  <section class="tab-panel" data-panel="files">
    ${renderAttachmentsTab(tree)}
  </section>` : ''}

  ${history ? `
  <section class="tab-panel" data-panel="trends">
    <div class="card">
      <div class="card-head"><h2>Run history</h2><span class="card-hint">last ${runs.length} run${runs.length === 1 ? '' : 's'} of this spec</span></div>
      ${renderHistory(runs)}
    </div>
    <div class="card">
      <div class="card-head"><h2>Common issues</h2><span class="card-hint">causes seen across all recorded runs</span></div>
      ${renderCommonIssues(runs)}
    </div>
  </section>` : ''}
</div>

<div id="tooltip" role="tooltip"></div>

<div class="lightbox" id="lightbox" onclick="this.classList.remove('open')">
  <img id="lightbox-img" src="" alt="">
</div>

<script>
  function openLightbox(src) {
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox').classList.add('open');
  }
  // One floating tooltip for every element carrying data-tip.
  (function () {
    const tip = document.getElementById('tooltip');
    document.addEventListener('mousemove', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) { tip.classList.remove('show'); return; }
      tip.textContent = el.getAttribute('data-tip');
      const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = e.clientY + 16 + tip.offsetHeight > window.innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
      tip.classList.add('show');
    });
  })();
  let caseFilter = 'ALL', caseQuery = '';
  function applyCaseFilters() {
    document.querySelectorAll('#case-list > [data-status]').forEach((el) => {
      const okStatus = caseFilter === 'ALL' || (caseFilter === 'FLAKY' ? el.dataset.flaky === 'true' : el.dataset.status === caseFilter);
      const okText = !caseQuery || (el.dataset.text || '').includes(caseQuery) || el.textContent.toLowerCase().includes(caseQuery);
      el.classList.toggle('hidden', !(okStatus && okText));
    });
  }
  function filterCases(status, btn) {
    caseFilter = status;
    document.querySelectorAll('.toolbar [data-filter]').forEach((b) => b.classList.toggle('active', b === btn));
    applyCaseFilters();
  }
  function searchCases(q) { caseQuery = q.trim().toLowerCase(); applyCaseFilters(); }
  function setAll(open) { document.querySelectorAll('#case-list details').forEach((d) => { d.open = open; }); }
  function showTab(name) {
    const panels = document.querySelectorAll('.tab-panel');
    if (![...panels].some((p) => p.dataset.panel === name)) name = 'overview';
    panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
      b.setAttribute('aria-selected', b.dataset.tab === name);
    });
    try { history.replaceState(null, '', '#' + name); } catch (e) {}
  }
  showTab((location.hash || '#overview').slice(1).split('-')[0] === 'case' ? 'cases' : (location.hash || '#overview').slice(1));
  function openCase(i) {
    showTab('cases');
    filterCases('ALL', document.querySelector('.toolbar [data-filter="ALL"]'));
    const el = document.getElementById('case-' + i);
    if (!el) return;
    if (el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  }
  function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute('data-theme');
    root.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
  }
</script>
`;
}

function writeReport(outPath, opts) {
  const html = render(opts);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  return outPath;
}

module.exports = { render, writeReport, fmtDuration, esc, LOGO_SVG };
