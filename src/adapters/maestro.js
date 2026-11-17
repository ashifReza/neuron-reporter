'use strict';
// Maestro adapter: turns a run's commands.json (+ its screenshots) into a
// step tree. `runFlow` blocks become collapsible test cases — give them a
// `label:` in the flow file so each reads as a named case.
//
//   const maestro = require('neuron-reporter/adapters/maestro');
//   const { tree, envVars } = maestro.buildTree('/path/to/run/flow-dir');
//
// or from the CLI:  npx neuron-reporter maestro <flow-dir-or-flow-name> -o report.html

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Resolve a flow directory (containing commands.json), or the newest run of a flow name under ~/.maestro/tests. */
function findRunDir(arg) {
  if (fs.existsSync(path.join(arg, 'commands.json'))) return arg;
  const testsRoot = path.join(os.homedir(), '.maestro', 'tests');
  if (!fs.existsSync(testsRoot)) throw new Error(`No commands.json at ${arg}, and no ~/.maestro/tests to search`);
  const candidates = fs.readdirSync(testsRoot)
    .map((runDir) => ({ runDir, flowDir: path.join(testsRoot, runDir, arg) }))
    .filter((c) => fs.existsSync(path.join(c.flowDir, 'commands.json')))
    .sort((a, b) => (a.runDir < b.runDir ? 1 : -1)); // run dirs are timestamps
  if (!candidates.length) throw new Error(`No runs found for flow "${arg}" under ${testsRoot}`);
  return candidates[0].flowDir;
}

const shortId = (id) => (id ? id.slice(id.lastIndexOf('/') + 1) : '');

function selector(sel) {
  if (!sel) return 'element';
  const parts = [];
  if (sel.idRegex) parts.push(`id="${shortId(sel.idRegex)}"`);
  if (sel.textRegex) parts.push(`text="${sel.textRegex}"`);
  if (sel.index !== undefined) parts.push(`[index ${sel.index}]`);
  return parts.length ? parts.join(' ') : 'element';
}

function describe(type, cmd) {
  if (cmd.label) return cmd.label;
  switch (type) {
    case 'runFlowCommand': return 'Run flow';
    case 'launchAppCommand': return `Launch app "${cmd.appId}"${cmd.clearState ? ' (clear state)' : ''}`;
    case 'tapOnElement': return `Tap on ${selector(cmd.selector)}`;
    case 'assertConditionCommand': {
      const c = cmd.condition || {};
      if (c.visible) return `Assert visible: ${selector(c.visible)}`;
      if (c.notVisible) return `Assert NOT visible: ${selector(c.notVisible)}`;
      if (c.scriptCondition) return `Assert true: ${c.scriptCondition}`;
      return 'Assert condition';
    }
    case 'inputTextCommand': return `Input text "${cmd.text}"`;
    case 'swipeCommand': return `Swipe ${cmd.startRelative || ''} → ${cmd.endRelative || ''}`.trim();
    case 'evalScriptCommand': return `Run script: ${(cmd.scriptString || '').trim()}`;
    case 'takeScreenshotCommand': return `Take screenshot: ${cmd.path}`;
    case 'pressKeyCommand': return `Press key: ${cmd.code}`;
    case 'scrollUntilVisible': return `Scroll ${cmd.direction} until ${selector(cmd.selector)} is visible`;
    default: return type.replace(/Command$/, '');
  }
}

const humanize = (name) => name.replace(/^\d+_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

// Framework setup commands with no test signal.
const NOISE = new Set(['defineVariablesCommand', 'applyConfigurationCommand']);

/**
 * @param {string} runArg - flow directory, or a flow name to look up under ~/.maestro/tests
 * @returns {{ tree: Array, envVars: Object, flowName: string, runId: string }}
 */
function buildTree(runArg) {
  const flowDir = findRunDir(runArg);
  const commands = JSON.parse(fs.readFileSync(path.join(flowDir, 'commands.json'), 'utf8'));
  const shotDir = path.join(flowDir, 'takeScreenshot');
  const failDir = path.join(flowDir, 'screenshots');

  const root = [];
  const stack = [{ depth: 0, children: root }];
  let envVars = {};

  for (const entry of commands) {
    const type = Object.keys(entry.command)[0];
    if (type === 'defineVariablesCommand') envVars = entry.command[type].env || {};
    if (NOISE.has(type)) continue;

    const meta = entry.metadata;
    // The evaluated command has ${VAR} placeholders resolved; prefer it.
    const cmd = (meta.evaluatedCommand && meta.evaluatedCommand[type]) || entry.command[type];
    while (stack.length > 1 && stack[stack.length - 1].depth > meta.depth) stack.pop();

    let screenshot = null;
    if (type === 'takeScreenshotCommand') {
      const p = path.join(shotDir, `${cmd.path}.png`);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) screenshot = { dataUri: dataUri(p), caption: humanize(cmd.path) };
    }
    if (!screenshot && meta.status === 'FAILED' && fs.existsSync(failDir)) {
      const seq = String(meta.sequenceNumber + 1).padStart(3, '0');
      const match = fs.readdirSync(failDir).find((f) => f.startsWith(`step-${seq}-`));
      if (match) screenshot = { dataUri: dataUri(path.join(failDir, match)), caption: 'Captured at failure' };
    }

    const isGroup = type === 'runFlowCommand';
    const node = {
      status: meta.status,
      duration: meta.duration || 0,
      description: describe(type, cmd),
      error: meta.error && meta.error.message,
      screenshot,
      isGroup,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    if (isGroup) stack.push({ depth: meta.depth + 1, children: node.children });
  }

  return { tree: root, envVars, flowName: path.basename(flowDir), runId: path.basename(path.dirname(flowDir)) };
}

module.exports = { buildTree, findRunDir };
