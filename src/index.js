'use strict';
const { StepReporter, readable } = require('./reporter');
const renderer = require('./renderer');
const history = require('./history');
const runInfo = require('./runinfo');
const attachments = require('./attachments');
const redact = require('./redact');
const merge = require('./merge');

module.exports = {
  StepReporter,
  render: renderer.render,
  writeReport: renderer.writeReport,
  history,
  runInfo,
  attachments,
  createRedactor: redact.createRedactor,
  mergeRuns: merge.mergeRuns,
  createClassifier: history.createClassifier,
  readableTime: readable,
};
