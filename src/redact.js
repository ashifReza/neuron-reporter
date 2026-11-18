'use strict';
// Secret redaction. A report is a file people share, so every piece of text
// that goes into it (step names, errors, details, logs, JSON attachments,
// attempt errors, run details, labels, and the history file) is passed through
// a redactor first. On by default.
//
//   redact: false                                   turn it off
//   redact: { values: [process.env.MY_PIN] }        also hide these exact strings
//   redact: { patterns: [/order-\d+/g] }            also hide these matches
//   redact: { env: false }                          don't auto-hide secret-looking env vars
//   redact: { replacement: '[hidden]' }             default '••••••'
//
// Built in:
//   - Authorization: Bearer/Basic credentials, JWTs, credentials in URLs
//   - password=…, token: "…", api_key=…, client_secret … (key/value forms, JSON too)
//   - AWS access keys, GitHub/GitLab/Slack/Stripe/OpenAI-style tokens, private key blocks
//   - the values of environment variables whose names look secret
//     (PASSWORD, TOKEN, SECRET, API_KEY, OTP, PIN, CREDENTIAL…), 6+ characters
//
// Images and videos cannot be redacted — keep secrets off screen in tests.

const DEFAULT_REPLACEMENT = '••••••';

const SECRET_ENV_NAME = /(PASS(WORD|WD)?|PWD|TOKEN|SECRET|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|OTP|\bPIN\b|_PIN$|SESSION|COOKIE|AUTH)/i;

// [pattern, replacer] — replacers keep the label and hide only the secret.
function builtinRules(R) {
  return [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => `-----PRIVATE KEY ${R}-----`],
    [/\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+\/=-]{8,}/gi, (m, a, s) => `${a}${s}${R}`],
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, () => R],
    [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:\/@]+:)([^\s@\/]+)(@)/gi, (m, a, b, c) => `${a}${R}${c}`],
    [/\b((?:x-)?(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|password|passwd|pwd|passcode|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|session[_-]?id|otp|pin|authorization|cookie|set-cookie))(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\s)([^\s"'&,;]{3,})/gi, (m, k, sep) => `${k}${sep}${R}`],
    [/\bAKIA[0-9A-Z]{16}\b/g, () => R],
    [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, () => R],
  ];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {boolean|Object} [opts] - false disables; see the file header for the object form
 * @returns {(text: string) => string} identity when disabled
 */
function createRedactor(opts = {}) {
  if (opts === false) return Object.assign((s) => s, { enabled: false });
  const o = opts === true ? {} : opts || {};
  const R = o.replacement || DEFAULT_REPLACEMENT;
  const rules = builtinRules(R);
  for (const p of o.patterns || []) {
    const re = p instanceof RegExp ? new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`) : new RegExp(escapeRe(String(p)), 'g');
    rules.push([re, () => R]);
  }
  const values = new Set((o.values || []).filter((v) => v !== undefined && v !== null && String(v).length >= 3).map(String));
  if (o.env !== false) {
    const env = o.envSource || process.env;
    for (const [name, value] of Object.entries(env)) {
      if (value && value.length >= 6 && SECRET_ENV_NAME.test(name) && !/^(true|false|null|undefined)$/i.test(value)) values.add(value);
    }
  }
  // Longest first, so a value that contains another is hidden whole.
  const valueRe = values.size ? new RegExp([...values].sort((a, b) => b.length - a.length).map(escapeRe).join('|'), 'g') : null;

  const redact = (text) => {
    if (text === undefined || text === null) return text;
    let s = String(text);
    if (valueRe) s = s.replace(valueRe, R);
    for (const [re, fn] of rules) s = s.replace(re, fn);
    return s;
  };
  redact.enabled = true;
  return redact;
}

/** A redacted deep copy of a tree. Binary data (screenshots, embedded files) is left as is. */
function redactTree(tree, redact) {
  if (!redact || redact.enabled === false) return tree;
  const one = (n) => {
    const out = { ...n };
    for (const k of ['description', 'error', 'detail']) if (typeof out[k] === 'string') out[k] = redact(out[k]);
    if (out.screenshot && out.screenshot.caption) out.screenshot = { ...out.screenshot, caption: redact(out.screenshot.caption) };
    if (Array.isArray(out.attempts)) out.attempts = out.attempts.map((a) => (a.error ? { ...a, error: redact(a.error) } : a));
    if (Array.isArray(out.attachments)) {
      out.attachments = out.attachments.map((a) => ({
        ...a,
        name: redact(a.name),
        ...(typeof a.body === 'string' ? { body: redact(a.body) } : {}),
        ...(a.contentType === 'text/uri-list' && a.path ? { path: redact(a.path) } : {}),
      }));
    }
    if (Array.isArray(out.children)) out.children = out.children.map(one);
    return out;
  };
  return (tree || []).map(one);
}

/** Redact the values of a flat { label: value } object. */
function redactObject(obj, redact) {
  if (!obj || !redact || redact.enabled === false) return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]));
}

module.exports = { createRedactor, redactTree, redactObject, DEFAULT_REPLACEMENT, SECRET_ENV_NAME };
