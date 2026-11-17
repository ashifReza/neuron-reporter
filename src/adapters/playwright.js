'use strict';
// Playwright adapter.
//
//   const { StepReporter } = require('neuron-reporter');
//   const pw = require('neuron-reporter/adapters/playwright');
//   test('checkout', async ({ page, browserName }) => {
//     const report = new StepReporter('checkout', {
//       screenshot: pw.screenshot(page),
//       runInfo: { Browser: browserName },
//     });
//     ...
//     report.writeReport('reports/checkout.html');
//   });

/** @param {import('playwright').Page} page */
function screenshot(page, { fullPage = false } = {}) {
  return async () => {
    if (!page || page.isClosed()) return null;
    return page.screenshot({ fullPage }); // Buffer
  };
}

module.exports = { screenshot };
