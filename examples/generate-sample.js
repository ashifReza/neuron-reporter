'use strict';
// Builds examples/sample-report.html from a fake "Demo Store" run, so the
// report can be seen without any app or device. Screenshots are drawn SVG
// mock-ups; a few earlier runs are seeded into the history so the Trends tab
// has something to show.
//
//   npm run example   (or: node examples/generate-sample.js)

const fs = require('fs');
const path = require('path');
const { StepReporter, history, runInfo } = require('../src');

const OUT = path.join(__dirname, 'sample-report.html');
const HISTORY_DIR = path.join(__dirname, 'history');
const NAME = 'demo-store-checkout';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A phone-shaped SVG standing in for a device screenshot.
function mockScreen(title, lines, accent = '#2a78d6') {
  const rows = lines.map((l, i) => `<rect x="24" y="${150 + i * 64}" width="312" height="48" rx="10" fill="#f1f3f5"/><text x="40" y="${180 + i * 64}" font-size="16" fill="#333">${l}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="760" viewBox="0 0 360 760">
    <rect width="360" height="760" fill="#ffffff"/>
    <rect width="360" height="100" fill="${accent}"/>
    <text x="24" y="66" font-family="sans-serif" font-size="24" font-weight="700" fill="#fff">${title}</text>
    <g font-family="sans-serif">${rows}</g>
    <rect x="24" y="660" width="312" height="56" rx="28" fill="${accent}"/>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

let currentScreen = mockScreen('Demo Store', ['Welcome']);
const show = (title, lines, accent) => { currentScreen = mockScreen(title, lines, accent); };

// Seed earlier runs so the Trends tab has a history to plot.
function seedHistory() {
  const file = history.historyFile(HISTORY_DIR, NAME);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const past = [
    { h: 30, cases: [7, 0, 1], dur: 61000, failures: [] },
    { h: 26, cases: [6, 1, 1], dur: 74000, failures: [{ testCase: 'Checkout', step: 'Payment page loads', category: 'network', message: 'GET /api/payments failed (network): fetch failed' }] },
    { h: 22, cases: [7, 0, 1], dur: 58000, failures: [], flaky: [{ testCase: 'Checkout', step: 'Payment page loads', attempts: 2 }] },
    { h: 18, cases: [5, 2, 1], dur: 92000, failures: [
      { testCase: 'Search for a product', step: 'Results list is shown', category: 'element', message: 'element ("~results-list") still not displayed after 15000ms' },
      { testCase: 'Add to cart', step: 'Cart total matches the price', category: 'mismatch', message: 'Expected "$24.00" but screen shows "$24"' },
    ] },
    // Recorded with per-step outcomes: the payment step did not run this time.
    { h: 6, cases: [6, 1, 1], dur: 66000, failures: [{ testCase: 'Add to cart', step: 'Cart total matches the price', category: 'mismatch', message: 'Expected "$24.00" but screen shows "$24"' }], outcomes: { 'Add to cart › Cart total matches the price': 'F', 'Search for a product › Results list is shown': 'P' } },
  ];
  const runs = past.map((r) => ({
    startedAt: new Date(Date.now() - r.h * 3600e3).toISOString(),
    duration: r.dur,
    status: r.cases[1] ? 'FAILED' : 'WARNED',
    cases: { COMPLETED: r.cases[0], FAILED: r.cases[1], WARNED: r.cases[2] },
    failures: r.failures,
    flaky: r.flaky || [],
    ...(r.outcomes ? { outcomes: r.outcomes } : {}),
  }));
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(runs, null, 1));
}

async function main() {
  seedHistory();

  const report = new StepReporter(NAME, {
    screenshot: async () => currentScreen,
    history: { dir: HISTORY_DIR },
    labels: { environment: 'staging', suite: 'smoke' },
    highlights: ['Pixel 8 · Android 15', 'App 3.4.1'],
    runInfo: () => ({ Environment: 'Staging', Device: 'Pixel 8', Android: '15', App: 'com.example.store', 'App version': '3.4.1', ...runInfo.git(path.join(__dirname, '..')) }),
  });

  await report.group('Launch the app', async () => {
    await report.step('Open Demo Store', () => sleep(420));
    show('Demo Store', ['Sign in', 'Continue as guest']);
    await report.optionalStep('Dismiss the "What\'s new" sheet (if shown)', async () => { await sleep(60); return false; });
    await report.attachScreenshot('Home screen');
  });

  await report.group('Sign in', async () => {
    await report.step('Enter email', () => sleep(180));
    await report.step('Enter password', () => sleep(150));
    await report.step('Tap Sign in', () => sleep(520));
    show('Hi, Alex', ['Recommended', 'Deals', 'Orders']);
    await report.softStep('Greeting shows the account name', async () => { await sleep(40); report.attachDetail('Expected: "Hi, Alex"\nActual: "Hi, Alex"'); });
    await report.attachScreenshot('Signed in');
  });

  await report.group('Search for a product', async () => {
    await report.step('Type "headphones"', () => sleep(230));
    show('Search', ['Wireless Headphones $24.00', 'Studio Headphones $59.00', 'Kids Headphones $14.00']);
    await report.softStep('Results list is shown', () => sleep(310));
    await report.attachScreenshot('Search results');
  });

  await report.group('Add to cart', async () => {
    await report.step('Open "Wireless Headphones"', () => sleep(280));
    await report.step('Tap Add to cart', () => sleep(190));
    show('Cart (1)', ['Wireless Headphones', 'Subtotal  $24'], '#d03b3b');
    await report.softStep('Cart badge shows 1', async () => { await sleep(30); report.attachDetail('Expected: "1"\nActual: "1"'); });
    await report.softStep('Cart total matches the price', async () => {
      await sleep(50);
      throw new Error('Expected "$24.00" but screen shows "$24"');
    });
  });

  await report.group('Checkout', async () => {
    show('Checkout', ['Ship to: 221B Example St', 'Card •••• 4242', 'Total  $24.00']);
    await report.step('Open checkout', () => sleep(360));
    await report.softStep('Shipping address is pre-filled', () => sleep(70));
    // Fails once with a 503, passes on the retry: recorded as flaky.
    await report.softStep('Payment page loads', async ({ attempt }) => {
      await sleep(attempt === 0 ? 300 : 640);
      if (attempt === 0) throw new Error('GET /api/payments → 503 Service Unavailable');
    }, { retries: 2 });
    report.attachLog('network.log', [
      '12:04:10.112  GET /api/payments            503  301ms',
      '12:04:10.420  retry 1/2',
      '12:04:11.064  GET /api/payments            200  640ms',
    ]);
    report.attach('payments response', { methods: ['card', 'paypal'], default: 'card', currency: 'USD' });
    await report.attachScreenshot('Checkout');
  });

  await report.group('Place the order', async () => {
    await report.step('Tap Place order', () => sleep(410));
    show('Order placed', ['Order #A1042', 'Arriving Thursday'], '#0ca30c');
    await report.softStep('Confirmation shows an order number', () => sleep(45));
    await report.attachScreenshot('Order confirmation');
  });

  await report.group('Sign out', async () => {
    await report.step('Open the account menu', () => sleep(140));
    await report.step('Tap Sign out', () => sleep(220));
  });

  await report.group('Clean up', async () => {
    await report.optionalStep('Cancel the test order (if still open)', async () => { await sleep(80); return true; });
  });

  report.writeReport(OUT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
