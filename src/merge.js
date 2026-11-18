'use strict';
// Merge the JSON runs of parallel jobs or shards into one run, so a sharded
// suite gets one report and one history record instead of N partial ones.
//
//   CLI:  neuron-reporter merge shards/ -o report.html
//   API:  const run = require('neuron-reporter/merge').mergeRuns(['a.json', 'b.json']);
//
// Inputs are files written by StepReporter#writeJSON(), the Playwright
// reporter in shard mode, or anything following schema/run.schema.json.
// Test cases are concatenated in file-name order; the merged run starts at the
// earliest shard start and lasts until the latest shard end (wall-clock time).

const fs = require('fs');
const path = require('path');

/** Files and directories (recursively, *.json) → sorted file list. */
function expandJsonInputs(inputs) {
  const out = [];
  const visit = (p, explicit) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p).sort()) {
        if (entry === 'history') continue; // never treat a history folder as a shard
        visit(path.join(p, entry), false);
      }
    } else if (explicit || /\.json$/i.test(p)) {
      out.push(p);
    }
  };
  for (const input of [].concat(inputs)) visit(input, true);
  return out;
}

/** Attachment paths in a run file are relative to that file; make them absolute. */
function absolutizeAttachments(tree, baseDir) {
  for (const n of tree || []) {
    for (const a of n.attachments || []) {
      if (a.path && a.contentType !== 'text/uri-list' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a.path) && !path.isAbsolute(a.path)) {
        a.path = path.resolve(baseDir, a.path);
      }
    }
    absolutizeAttachments(n.children, baseDir);
  }
}

/** Read one run file: { name, startedAt, duration, tree, labels, runInfo } (or a bare array of nodes). */
function readRun(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = Array.isArray(data) ? { tree: data } : data;
  if (!Array.isArray(run.tree)) throw new Error(`${file}: expected an array of nodes or { tree: [...] }`);
  // Catch the easy mistakes (a history file, some other JSON) instead of rendering nonsense.
  const bad = run.tree.find((n) => !n || typeof n !== 'object' || typeof n.description !== 'string' || typeof n.status !== 'string');
  if (bad) {
    const looksLikeHistory = bad && typeof bad === 'object' && 'startedAt' in bad && ('cases' in bad || 'failures' in bad);
    throw new Error(`${file}: ${looksLikeHistory ? 'this is a run-history file, not a test run' : 'not a neuron-reporter run (every node needs "description" and "status")'}`);
  }
  absolutizeAttachments(run.tree, path.dirname(path.resolve(file)));
  const startTime = run.startedAt ? new Date(run.startedAt).getTime() : fs.statSync(file).mtimeMs;
  const duration = run.duration || run.tree.reduce((s, n) => s + (n.duration || 0), 0);
  return { ...run, file, startTime, duration };
}

/**
 * @param {string|string[]} inputs - JSON files and/or directories
 * @returns {{ name: string, startTime: number, duration: number, tree: Array, labels: Object, runInfo: Object, shards: number, files: string[] }}
 */
function mergeRuns(inputs) {
  const files = expandJsonInputs(inputs);
  if (!files.length) throw new Error(`No run JSON files found in ${[].concat(inputs).join(', ')}`);
  const runs = files.map(readRun);
  const startTime = Math.min(...runs.map((r) => r.startTime));
  const end = Math.max(...runs.map((r) => r.startTime + r.duration));
  const names = [...new Set(runs.map((r) => r.name).filter(Boolean))];
  const labels = Object.assign({}, ...runs.map((r) => r.labels || {}));
  const runInfo = Object.assign({}, ...runs.map((r) => r.runInfo || {}));
  delete runInfo.Started;
  delete runInfo.Finished;
  delete runInfo.Shard; // one shard's own "2 of 4" means nothing in the merged report
  if (runs.length > 1) runInfo.Shards = `${runs.length} merged`;
  return {
    name: names[0] || path.basename(files[0], '.json').replace(/[-_.]?shard.*$/i, '') || 'merged',
    startTime,
    duration: Math.max(0, end - startTime),
    tree: runs.flatMap((r) => r.tree),
    labels,
    runInfo,
    shards: runs.length,
    files,
  };
}

module.exports = { mergeRuns, readRun, expandJsonInputs, absolutizeAttachments };
