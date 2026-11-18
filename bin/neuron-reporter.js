#!/usr/bin/env node
'use strict';
// neuron-reporter CLI
//
//   neuron-reporter render  <run.json> [options]
//   neuron-reporter merge   <run.json | dir>... [options]      one report from parallel jobs / shards
//   neuron-reporter junit   <file.xml | dir>... [--group none|suite|class] [options]
//   neuron-reporter maestro <flow-dir | flow-name> [options]
//
// <run.json> is either an array of nodes or { name, startedAt, duration, tree }
// (what StepReporter#toJSON()/writeJSON() produce). See schema/run.schema.json.
//
// Exit codes: 0 all passed, 1 a test case failed (or --fail-on-flaky and one
// was flaky), 2 the CLI itself failed.

const fs = require('fs');
const path = require('path');
const { render, history, readableTime } = require('../src');
const attachments = require('../src/attachments');
const { createRedactor } = require('../src/redact');
const { mergeRuns } = require('../src/merge');

const USAGE = `Usage:
  neuron-reporter render  <run.json> [options]
  neuron-reporter merge   <run.json | dir>... [options]
  neuron-reporter junit   <file.xml | dir>... [--group none|suite|class] [options]
  neuron-reporter maestro <flow-dir | flow-name> [options]

Options:
  -o, --out FILE      where to write the report (default: <name>.html)
  --title NAME        report and history name
  --history DIR       run-history folder (default: <report dir>/history)
  --no-history        do not read or write run history
  --fail-on-flaky     exit 1 when a step passed only on a retry
  --no-embed          link attachment files instead of embedding them
  --redact REGEX      also hide text matching REGEX (repeatable)
  --no-redact         turn secret redaction off`;

function parseArgs(argv) {
  const args = { _: [], redact: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--history') args.history = argv[++i];
    else if (a === '--no-history') args.history = false;
    else if (a === '--group') args.group = argv[++i];
    else if (a === '--fail-on-flaky') args.failOnFlaky = true;
    else if (a === '--no-embed') args.embed = false;
    else if (a === '--redact') args.redact.push(argv[++i]);
    else if (a === '--no-redact') args.noRedact = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a === '-v' || a === '--version') args.version = true;
    else args._.push(a);
  }
  return args;
}

function writeWithHistory({ name, startTime, duration, tree, labels, out, historyDir, runInfo = {}, failOnFlaky, redact, shards }) {
  let runs = null;
  if (historyDir !== false) {
    const file = history.historyFile(historyDir || path.join(path.dirname(out), 'history'), name);
    runs = history.record(file, { startTime, duration, tree, labels, redact, shards });
  }
  attachments.resolveLinks(tree, out);
  const html = render({
    title: name,
    subtitle: `Run on ${readableTime(startTime)}`,
    labels,
    tree,
    history: runs,
    redact,
    runInfo: { Suite: name, ...runInfo, Started: readableTime(startTime, true) },
  });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  const counts = { COMPLETED: 0, FAILED: 0, WARNED: 0, SKIPPED: 0 };
  for (const n of tree) counts[n.status] = (counts[n.status] || 0) + 1;
  const flaky = history.collectFlaky(tree).length;
  console.log(`📊 ${counts.COMPLETED}/${tree.length} test cases passed, ${counts.FAILED} failed, ${counts.WARNED} warned${counts.SKIPPED ? `, ${counts.SKIPPED} skipped` : ''}${flaky ? `, ${flaky} flaky` : ''}${shards > 1 ? ` (${shards} shards)` : ''} → ${out}`);
  return counts.FAILED || (failOnFlaky && flaky) ? 1 : 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    console.log(require('../package.json').version);
    return 0;
  }
  const [command, ...inputs] = args._;
  const input = inputs[0];
  if (args.help || !command || !input) {
    console.log(USAGE);
    return args.help || !command ? 0 : 1;
  }
  const redact = args.noRedact ? createRedactor(false) : createRedactor({ patterns: args.redact.map((p) => new RegExp(p, 'g')) });
  const common = { historyDir: args.history, failOnFlaky: args.failOnFlaky, redact };

  if (command === 'render' || command === 'merge') {
    const run = mergeRuns(command === 'render' ? [input] : inputs);
    const name = args.title || run.name;
    return writeWithHistory({ ...common, name, startTime: run.startTime, duration: run.duration, tree: run.tree, labels: run.labels, runInfo: run.runInfo, shards: run.shards > 1 ? run.shards : undefined, out: args.out || `${name}.html` });
  }

  if (command === 'junit') {
    const junit = require('../src/adapters/junit');
    const result = junit.buildTree(inputs, { groupBy: args.group || 'none', embed: args.embed === false ? false : 'auto' });
    const name = args.title || result.name;
    const startTime = result.startedAt ? new Date(result.startedAt).getTime() : Date.now() - result.duration;
    return writeWithHistory({ ...common, name, startTime, duration: result.duration, tree: result.tree, labels: {}, runInfo: { Source: `${result.files.length} JUnit file${result.files.length === 1 ? '' : 's'}` }, out: args.out || `${name}.html` });
  }

  if (command === 'maestro') {
    const maestro = require('../src/adapters/maestro');
    const { tree, envVars, flowName } = maestro.buildTree(input);
    const name = args.title || flowName;
    const duration = tree.reduce((s, n) => s + (n.duration || 0), 0);
    const labels = Object.fromEntries(Object.entries(envVars).filter(([k]) => !/PASS|TOKEN|SECRET|OTP|KEY/i.test(k)));
    return writeWithHistory({ ...common, name, startTime: Date.now() - duration, duration, tree, labels, out: args.out || `${name}.html` });
  }

  console.error(`Unknown command "${command}"\n${USAGE}`);
  return 2;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`neuron-reporter: ${error.message}`);
  process.exitCode = 2;
}
