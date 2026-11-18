// ESM users import named exports from a CommonJS package; Node can only see
// them when index.js assigns them in a form its export scanner understands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nr from '../src/index.js';
import Reporter from '../src/playwright-reporter.js';

test('every public export is importable by name from ESM', () => {
  const names = ['StepReporter', 'render', 'writeReport', 'history', 'runInfo', 'attachments', 'createRedactor', 'mergeRuns', 'createClassifier', 'readableTime'];
  assert.deepEqual(names.filter((n) => nr[n] === undefined), []);
  assert.equal(typeof Reporter, 'function');
});
