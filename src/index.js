'use strict';
// Written as `exports.name = ...` on purpose: Node finds a CommonJS module's
// named exports for ESM `import { x } from 'neuron-reporter'` by scanning the
// source, and it cannot see entries like `{ render: renderer.render }`.
const { StepReporter, readable } = require('./reporter');
const renderer = require('./renderer');
const history = require('./history');
const runInfo = require('./runinfo');
const attachments = require('./attachments');
const redact = require('./redact');
const merge = require('./merge');

exports.StepReporter = StepReporter;
exports.render = renderer.render;
exports.writeReport = renderer.writeReport;
exports.history = history;
exports.runInfo = runInfo;
exports.attachments = attachments;
exports.createRedactor = redact.createRedactor;
exports.mergeRuns = merge.mergeRuns;
exports.createClassifier = history.createClassifier;
exports.readableTime = readable;
