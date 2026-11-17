'use strict';
// Helpers that collect common "Run details" facts. Each returns a plain
// { label: value } object and never throws — a missing tool just yields
// fewer fields. Combine them freely:
//
//   runInfo: () => ({ Environment: 'Staging', ...runInfo.git(), ...runInfo.ci() })

const os = require('os');
const { execFileSync } = require('child_process');

function quiet(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString().trim();
  } catch (error) {
    return '';
  }
}

/** Branch @ short commit, marked when the working tree has uncommitted changes. */
function git(cwd = process.cwd()) {
  const branch = quiet('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch) return {};
  const sha = quiet('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD']);
  const dirty = quiet('git', ['-C', cwd, 'status', '--porcelain']) ? ' + local changes' : '';
  return { Build: `${branch} @ ${sha}${dirty}` };
}

/** The CI system and run, when running under one (GitHub Actions, GitLab CI, Jenkins, CircleCI, Azure). */
function ci(env = process.env) {
  if (env.GITHUB_ACTIONS) return { CI: `GitHub Actions #${env.GITHUB_RUN_NUMBER || ''}`.trim() };
  if (env.GITLAB_CI) return { CI: `GitLab pipeline ${env.CI_PIPELINE_ID || ''}`.trim() };
  if (env.JENKINS_URL) return { CI: `Jenkins ${env.JOB_NAME || ''} #${env.BUILD_NUMBER || ''}`.trim() };
  if (env.CIRCLECI) return { CI: `CircleCI #${env.CIRCLE_BUILD_NUM || ''}`.trim() };
  if (env.TF_BUILD) return { CI: `Azure Pipelines ${env.BUILD_BUILDNUMBER || ''}`.trim() };
  return {};
}

/** Host machine and Node version. */
function host() {
  return { Host: `${os.type()} ${os.release()}`, Node: process.version };
}

/**
 * An Android device and an installed app's version, read over adb.
 * @param {Object} opts
 * @param {string} [opts.udid] - device serial (omit when only one device is attached)
 * @param {string} [opts.appPackage] - e.g. com.example.app
 */
function android({ udid, appPackage } = {}) {
  const adb = (...args) => quiet('adb', [...(udid ? ['-s', udid] : []), ...args]);
  const model = adb('shell', 'getprop', 'ro.product.model');
  if (!model) return {};
  const out = { Device: model, Android: adb('shell', 'getprop', 'ro.build.version.release') };
  if (appPackage) {
    out.App = appPackage;
    const version = (adb('shell', 'dumpsys', 'package', appPackage).match(/versionName=(\S+)/) || [])[1];
    if (version) out['App version'] = version;
  }
  return out;
}

module.exports = { git, ci, host, android };
