// Unit tests for the pure URL/slug/priority helpers exported by
// docs-mirror-scraper. The HTTP/cheerio/turndown integration is tested
// implicitly via running the script against a fixture site (see CI).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  normalizeUrl,
  isSameHost,
  isAsset,
  slugFromUrl,
  classifyPriority,
  loadPriorityConfig,
} = require('../index.js');

// ---------- normalizeUrl ----------

test('normalizeUrl: strips hash', () => {
  assert.equal(normalizeUrl('https://x.com/a#frag', 'https://x.com/'), 'https://x.com/a');
});

test('normalizeUrl: strips tracking params', () => {
  const out = normalizeUrl('https://x.com/page?utm_source=email&utm_medium=ads&keep=this', 'https://x.com/');
  assert.match(out, /keep=this/);
  assert.doesNotMatch(out, /utm_source/);
  assert.doesNotMatch(out, /utm_medium/);
});

test('normalizeUrl: resolves relative against base', () => {
  assert.equal(normalizeUrl('/b', 'https://x.com/a'), 'https://x.com/b');
});

test('normalizeUrl: collapses /index.html to /', () => {
  assert.equal(normalizeUrl('https://x.com/docs/index.html', 'https://x.com/'), 'https://x.com/docs/');
});

test('normalizeUrl: returns null on garbage input', () => {
  assert.equal(normalizeUrl('not a url', null), null);
});

// ---------- isSameHost ----------

test('isSameHost: same host returns true', () => {
  assert.equal(isSameHost('https://docs.example.com/a', 'docs.example.com'), true);
});

test('isSameHost: different host returns false', () => {
  assert.equal(isSameHost('https://other.example.com/a', 'docs.example.com'), false);
});

test('isSameHost: bad URL returns false', () => {
  assert.equal(isSameHost('not-a-url', 'docs.example.com'), false);
});

// ---------- isAsset ----------

test('isAsset: PNG / JPG / CSS / JS are assets', () => {
  assert.equal(isAsset('https://x.com/a.png'), true);
  assert.equal(isAsset('https://x.com/a.jpg'), true);
  assert.equal(isAsset('https://x.com/a.css'), true);
  assert.equal(isAsset('https://x.com/a.js'), true);
});

test('isAsset: HTML/MD/no extension are NOT assets', () => {
  assert.equal(isAsset('https://x.com/page'), false);
  assert.equal(isAsset('https://x.com/page.html'), false);
  assert.equal(isAsset('https://x.com/page.md'), false);
});

// ---------- slugFromUrl ----------

test('slugFromUrl: root path returns _root.md', () => {
  assert.equal(slugFromUrl('https://x.com/'), '_root.md');
});

test('slugFromUrl: nested path is sanitized', () => {
  assert.equal(slugFromUrl('https://x.com/docs/api/users'), 'docs_api_users.md');
});

test('slugFromUrl: query string gets appended', () => {
  const slug = slugFromUrl('https://x.com/page?id=42&kind=foo');
  assert.match(slug, /^page__/);
  assert.match(slug, /\.md$/);
});

test('slugFromUrl: long path is truncated', () => {
  const long = 'https://x.com/' + 'a'.repeat(300);
  const slug = slugFromUrl(long);
  assert.ok(slug.length <= 183, `slug too long: ${slug.length}`);
});

// ---------- classifyPriority ----------

test('classifyPriority: no priority config returns MEDIUM', () => {
  assert.equal(classifyPriority(null, 'https://x.com/oauth', 'OAuth Setup'), 'MEDIUM');
});

test('classifyPriority: URL match returns HIGH', () => {
  const cfg = { high: [/oauth/i], label: 'L', rationale: '' };
  assert.equal(classifyPriority(cfg, 'https://x.com/oauth-setup', 'Some Page'), 'HIGH');
});

test('classifyPriority: title match returns HIGH', () => {
  const cfg = { high: [/getting started/i], label: 'L', rationale: '' };
  assert.equal(classifyPriority(cfg, 'https://x.com/start', 'Getting Started Guide'), 'HIGH');
});

test('classifyPriority: no match returns MEDIUM', () => {
  const cfg = { high: [/oauth/i], label: 'L', rationale: '' };
  assert.equal(classifyPriority(cfg, 'https://x.com/billing', 'Billing FAQ'), 'MEDIUM');
});

// ---------- loadPriorityConfig ----------

test('loadPriorityConfig: null cfgPath returns null', () => {
  assert.equal(loadPriorityConfig(null), null);
  assert.equal(loadPriorityConfig(undefined), null);
});

test('loadPriorityConfig: missing file throws', () => {
  assert.throws(() => loadPriorityConfig('/no/such/file.json'), /file not found/);
});

test('loadPriorityConfig: malformed JSON throws', () => {
  const tmp = path.join(os.tmpdir(), `dms-bad-${Date.now()}.json`);
  fs.writeFileSync(tmp, 'not json');
  assert.throws(() => loadPriorityConfig(tmp), /not valid JSON/);
  fs.unlinkSync(tmp);
});

test('loadPriorityConfig: array instead of object throws', () => {
  const tmp = path.join(os.tmpdir(), `dms-arr-${Date.now()}.json`);
  fs.writeFileSync(tmp, '[]');
  assert.throws(() => loadPriorityConfig(tmp), /must be a JSON object/);
  fs.unlinkSync(tmp);
});

test('loadPriorityConfig: invalid regex throws with pattern name', () => {
  const tmp = path.join(os.tmpdir(), `dms-rx-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ high: ['bad((regex'] }));
  assert.throws(() => loadPriorityConfig(tmp), /Invalid regex.*bad\(\(regex/);
  fs.unlinkSync(tmp);
});

test('loadPriorityConfig: valid config parses correctly', () => {
  const tmp = path.join(os.tmpdir(), `dms-ok-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    label: 'Test',
    rationale: 'why',
    high: ['oauth', 'auth'],
  }));
  const cfg = loadPriorityConfig(tmp);
  assert.equal(cfg.label, 'Test');
  assert.equal(cfg.rationale, 'why');
  assert.equal(cfg.high.length, 2);
  assert.ok(cfg.high[0].test('OAUTH-PAGE'));
  fs.unlinkSync(tmp);
});

test('loadPriorityConfig: missing label defaults to Highlights', () => {
  const tmp = path.join(os.tmpdir(), `dms-deflt-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ high: ['foo'] }));
  const cfg = loadPriorityConfig(tmp);
  assert.equal(cfg.label, 'Highlights');
  fs.unlinkSync(tmp);
});
