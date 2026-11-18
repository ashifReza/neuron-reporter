'use strict';
// Attachments: anything beyond a screenshot that belongs to a step — logs,
// text, JSON, videos, Playwright traces, HAR files, links.
//
// An attachment is a plain object:
//   { name, contentType, body?, dataUri?, path? }
//   body     text content (text/*, application/json), rendered in a <pre>
//   dataUri  embedded binary (video, image, zip), so the report stays one file
//   path     a link — a URL, or a file path relative to the report
//
// Producers (the CLI JSON, JUnit, the Playwright reporter) can supply the same
// shape on any node as `attachments: [...]`.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_EMBED = 8 * 1024 * 1024; // 8 MB

const EXT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.txt': 'text/plain', '.log': 'text/x-log', '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.csv': 'text/csv',
  '.zip': 'application/zip', '.har': 'application/json',
};

function contentTypeFor(file) {
  return EXT_TYPES[path.extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

const isText = (type) => /^text\/|json|xml|javascript/.test(type || '');

/** Classify an attachment for rendering: video | image | text | link | file. */
function kindOf(a) {
  const type = a.contentType || '';
  if (type === 'text/uri-list') return 'link';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (a.body !== undefined && a.body !== null) return 'text';
  return 'file';
}

/** Build an attachment from in-memory content. */
function fromContent(name, content, { contentType } = {}) {
  if (content === undefined || content === null) return null;
  if (Buffer.isBuffer(content)) {
    const type = contentType || 'application/octet-stream';
    return isText(type)
      ? { name: String(name), contentType: type, body: content.toString('utf8') }
      : { name: String(name), contentType: type, dataUri: `data:${type};base64,${content.toString('base64')}` };
  }
  if (typeof content === 'object') {
    return { name: String(name), contentType: contentType || 'application/json', body: JSON.stringify(content, null, 2) };
  }
  return { name: String(name), contentType: contentType || 'text/plain', body: String(content) };
}

/**
 * Build an attachment from a file on disk: embedded when small enough (or
 * forced with embed: true), otherwise a link resolved against the report.
 * A missing file yields a note rather than an exception.
 */
function fromFile(name, filePath, { embed = 'auto', maxEmbedBytes = DEFAULT_MAX_EMBED, contentType } = {}) {
  const type = contentType || contentTypeFor(filePath);
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch (error) {
    return { name: String(name), contentType: 'text/plain', body: `(attachment not found: ${filePath})` };
  }
  const shouldEmbed = embed === true || (embed === 'auto' && size <= maxEmbedBytes);
  if (!shouldEmbed) return { name: String(name), contentType: type, path: path.resolve(filePath), size };
  const data = fs.readFileSync(filePath);
  if (isText(type)) return { name: String(name), contentType: type, body: data.toString('utf8'), size };
  return { name: String(name), contentType: type, dataUri: `data:${type};base64,${data.toString('base64')}`, size };
}

/** Rewrite absolute file links so they are relative to the report file (works when both are moved together). */
function resolveLinks(tree, outPath) {
  const base = path.dirname(path.resolve(outPath));
  const walk = (nodes) => {
    for (const n of nodes || []) {
      for (const a of n.attachments || []) {
        if (a.path && path.isAbsolute(a.path) && !/^[a-z]+:\/\//i.test(a.path)) {
          a.path = path.relative(base, a.path).split(path.sep).join('/');
        }
      }
      walk(n.children);
    }
  };
  walk(tree);
}

/** All attachments in a tree, with the step they belong to. */
function collect(tree) {
  const out = [];
  const walk = (nodes, testCase) => {
    for (const n of nodes || []) {
      const tc = testCase || n.description;
      for (const a of n.attachments || []) out.push({ ...a, step: n.description, testCase: tc, status: n.status });
      walk(n.children, tc);
    }
  };
  walk(tree, null);
  return out;
}

module.exports = { fromContent, fromFile, resolveLinks, collect, kindOf, contentTypeFor, DEFAULT_MAX_EMBED };
