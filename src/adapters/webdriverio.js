'use strict';
// WebdriverIO / Appium adapter.
//
//   const { StepReporter } = require('neuron-reporter');
//   const wdio = require('neuron-reporter/adapters/webdriverio');
//   const report = new StepReporter('login', { screenshot: wdio.screenshot() });
//
// screenshot() uses the global `browser` (or `driver` for Appium) at the
// moment it is called, so it is safe to create before the session starts.

/** @param {Object} [session] - a WebdriverIO browser/driver object; defaults to the global one */
function screenshot(session) {
  return async () => {
    const s = session || globalThis.driver || globalThis.browser;
    if (!s || typeof s.takeScreenshot !== 'function') return null;
    return s.takeScreenshot(); // base64 PNG
  };
}

/** Facts from the running session's capabilities (device, platform, app). */
function sessionInfo(session) {
  const s = session || globalThis.driver || globalThis.browser;
  const caps = (s && s.capabilities) || {};
  const pick = (...keys) => keys.map((k) => caps[k] ?? caps[`appium:${k}`]).find((v) => v !== undefined && v !== '');
  const out = {
    Platform: [pick('platformName'), pick('platformVersion')].filter(Boolean).join(' '),
    Device: pick('deviceName', 'deviceModel'),
    Browser: [pick('browserName'), pick('browserVersion')].filter(Boolean).join(' '),
    App: pick('appPackage', 'bundleId'),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

module.exports = { screenshot, sessionInfo };
