'use strict';
// Regenerates the README screenshots in docs/ from examples/sample-report.html
// (and, optionally, a report written by the Playwright reporter).
//
//   npm run example
//   node scripts/readme-screenshots.js [path/to/playwright-report.html]
//
// Needs Playwright with Chromium installed (it is not a dependency of this
// package): npm i -D playwright && npx playwright install chromium

const path = require('path');
const { pathToFileURL } = require('url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('This script needs Playwright: npm i -D playwright && npx playwright install chromium');
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SAMPLE = pathToFileURL(path.join(ROOT, 'examples', 'sample-report.html')).href;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const open = async (url, tab) => {
    await page.goto(`${url}#${tab}`);
    await page.evaluate((t) => window.showTab(t), tab);
    await page.mouse.move(0, 0); // no hover tooltips in the shots
  };
  const shot = (name, opts = {}) => page.screenshot({ path: path.join(DOCS, name), fullPage: true, ...opts });
  // The Checkout case of the sample run: a flaky step with a log and a JSON attachment.
  const checkoutIndex = () => page.evaluate(() => [...document.querySelectorAll('#case-list > [data-status]')].findIndex((el) => /checkout/i.test(el.dataset.text)));

  await open(SAMPLE, 'overview');
  await shot('overview.png');

  await open(SAMPLE, 'cases');
  const i = await checkoutIndex();
  await page.evaluate((idx) => {
    const el = document.getElementById(`case-${idx}`);
    el.open = true;
    el.querySelectorAll('details.att').forEach((d) => { d.open = true; });
  }, i);
  await page.locator(`#case-${i}`).screenshot({ path: path.join(DOCS, 'flaky-step.png') });

  await open(SAMPLE, 'overview');
  await page.locator('.card', { hasText: 'Flaky this run' }).screenshot({ path: path.join(DOCS, 'flaky-card.png') });

  await open(SAMPLE, 'shots');
  await shot('screenshots.png');

  await open(SAMPLE, 'trends');
  await shot('trends.png');
  await page.locator('[data-panel="trends"] .table-panel').screenshot({ path: path.join(DOCS, 'flaky-verdicts.png') });

  // Optional: a report from a real Playwright run, opened on its flaky test.
  const pwReport = process.argv[2];
  if (pwReport) {
    const url = pathToFileURL(path.resolve(pwReport)).href;
    await open(url, 'cases');
    const idx = await page.evaluate(() => [...document.querySelectorAll('#case-list > [data-status]')].findIndex((el) => el.dataset.flaky === 'true'));
    await page.evaluate((n) => {
      const el = document.getElementById(`case-${n}`);
      el.open = true;
      const stdout = [...el.querySelectorAll('details.att')].find((d) => /stdout/.test(d.textContent));
      if (stdout) stdout.open = true;
    }, idx);
    await page.locator(`#case-${idx}`).screenshot({ path: path.join(DOCS, 'playwright-flaky-test.png') });
  }

  await browser.close();
  console.log(`Screenshots written to ${path.relative(process.cwd(), DOCS)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
