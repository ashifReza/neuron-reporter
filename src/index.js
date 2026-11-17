'use strict';
const { StepReporter, readable } = require('./reporter');
const renderer = require('./renderer');
const history = require('./history');
const runInfo = require('./runinfo');

module.exports = {
  StepReporter,
  render: renderer.render,
  writeReport: renderer.writeReport,
  history,
  runInfo,
  createClassifier: history.createClassifier,
  readableTime: readable,
};
