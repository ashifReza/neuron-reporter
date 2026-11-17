#!/usr/bin/env node
'use strict';
// neuron-reporter CLI
//
//   neuron-reporter render <tree.json> [-o report.html] [--title T] [--history DIR | --no-history]
//   neuron-reporter maestro <flow-dir | flow-name> [-o report.html] [--history DIR | --no-history]
//
// <tree.json> is either an array of nodes or { name, startedAt, duration, tree }
// (what StepReporter#toJSON() produces).

const fs = require('fs');
const path = require('path');
const { render, history, readableTime } = require('../src');

const USAGE = `Usage:
  neuron-reporter render <tree.json> [-o out.html] [--title NAME] [--history DIR | --no-history]
  neuron-reporter maestro <flow-dir | flow-name> [-o out.html] [--history DIR | --no-history]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--history') args.history = argv[++i];
    else if (a === '--no-history') args.history = false;
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  return args;
}

function writeWithHistory({ name, startTime, duration, tree, labels, out, historyDir }) {
  let runs = null;
  if (historyDir !== false) {
    const file = history.historyFile(historyDir || path.join(path.dirname(out), 'history'), name);
    runs = history.record(file, { startTime, duration, tree, labels });
  }
  const html = render({
    title: name,
    subtitle: `Run on ${readableTime(startTime)}`,
    labels,
    tree,
    history: runs,
    runInfo: { Suite: name, Started: readableTime(startTime, true) },
  });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  const counts = { COMPLETED: 0, FAILED: 0, WARNED: 0 };
  for (const n of tree) counts[n.status] = (counts[n.status] || 0) + 1;
  console.log(`📊 ${counts.COMPLETED}/${tree.length} test cases passed, ${counts.FAILED} failed, ${counts.WARNED} warned → ${out}`);
  return counts.FAILED ? 1 : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, input] = args._;
  if (args.help || !command || !input) {
    console.log(USAGE);
    return command ? 1 : 0;
  }

  if (command === 'render') {
    const data = JSON.parse(fs.readFileSync(input, 'utf8'));
    const tree = Array.isArray(data) ? data : data.tree;
    const name = args.title || data.name || path.basename(input, '.json');
    const startTime = data.startedAt ? new Date(data.startedAt).getTime() : fs.statSync(input).mtimeMs;
    const duration = data.duration || tree.reduce((s, n) => s + (n.duration || 0), 0);
    return writeWithHistory({ name, startTime, duration, tree, labels: data.labels || {}, out: args.out || `${name}.html`, historyDir: args.history });
  }

  if (command === 'maestro') {
    const maestro = require('../src/adapters/maestro');
    const { tree, envVars, flowName } = maestro.buildTree(input);
    const name = args.title || flowName;
    const duration = tree.reduce((s, n) => s + (n.duration || 0), 0);
    const labels = Object.fromEntries(Object.entries(envVars).filter(([k]) => !/PASS|TOKEN|SECRET|OTP|KEY/i.test(k)));
    return writeWithHistory({ name, startTime: Date.now() - duration, duration, tree, labels, out: args.out || `${name}.html`, historyDir: args.history });
  }

  console.error(`Unknown command "${command}"\n${USAGE}`);
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`neuron-reporter: ${error.message}`);
  process.exitCode = 2;
}
