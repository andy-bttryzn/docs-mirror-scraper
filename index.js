#!/usr/bin/env node
// BFS crawl a docs site to a local Markdown mirror.
// Node 18+ (built-in fetch). Install deps once with `npm install`.
//
// Usage:
//   node index.js --start https://docs.example.com/
//   node index.js --start https://docs.example.com/ --max 100 --delay 1500
//   node index.js --start https://docs.example.com/ --out ./my-mirror
//   node index.js --start https://docs.example.com/ --priority-config ./priority.json
//
// Output (in --out, default ./docs_mirror/):
//   <slug>.md                       one file per page, source URL in header comment
//   INDEX.md                        table of contents grouped by first path segment
//   _highlights.md                  HIGH-priority pages (if priority config provided)
//   _scrape.log                     full crawl log
//
// Priority config (optional JSON):
//   {
//     "high": ["regex1", "regex2"],
//     "label": "Reading-list",            // shown in _highlights.md header
//     "rationale": "What HIGH means here" // shown in _highlights.md header
//   }
// Patterns are case-insensitive and matched against `url + ' ' + title`.

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');
const TurndownService = require('turndown');

// ---------- config ----------
const DEFAULTS = {
  start: null,
  host: null,
  maxPages: 300,
  delayMs: 1000,
  outDir: path.resolve(process.cwd(), 'docs_mirror'),
  userAgent: 'docs-mirror-scraper/1.0 (+https://github.com/your/repo)',
  priorityConfig: null,
};

function parseArgs() {
  const cfg = { ...DEFAULTS };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') cfg.maxPages = parseInt(argv[++i], 10);
    else if (a === '--delay') cfg.delayMs = parseInt(argv[++i], 10);
    else if (a === '--start') cfg.start = argv[++i];
    else if (a === '--out') cfg.outDir = path.resolve(argv[++i]);
    else if (a === '--user-agent') cfg.userAgent = argv[++i];
    else if (a === '--priority-config') cfg.priorityConfig = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node index.js --start URL [--max N] [--delay MS] [--out DIR] [--user-agent UA] [--priority-config FILE]');
      process.exit(0);
    }
  }
  if (!cfg.start) {
    console.error('Error: --start URL is required. Run with --help for usage.');
    process.exit(1);
  }
  try {
    cfg.host = new URL(cfg.start).host;
  } catch (e) {
    console.error(`Error: --start ${cfg.start} is not a valid URL: ${e.message}`);
    process.exit(1);
  }
  return cfg;
}

// ---------- priority classification (optional) ----------
function loadPriorityConfig(cfgPath) {
  if (!cfgPath) return null;
  if (!fs.existsSync(cfgPath)) {
    console.error(`Priority config file not found: ${cfgPath}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const high = (raw.high || []).map(p => new RegExp(p, 'i'));
  return {
    high,
    label: raw.label || 'Highlights',
    rationale: raw.rationale || '',
  };
}

function classifyPriority(priorityCfg, urlStr, title) {
  if (!priorityCfg) return 'MEDIUM';
  const hay = (urlStr + ' ' + (title || '')).toLowerCase();
  for (const pat of priorityCfg.high) {
    if (pat.test(hay)) return 'HIGH';
  }
  return 'MEDIUM';
}

// ---------- URL helpers ----------
function normalizeUrl(urlStr, base) {
  try {
    const u = new URL(urlStr, base);
    u.hash = '';
    const drop = ['print', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    for (const k of drop) u.searchParams.delete(k);
    if (u.pathname.endsWith('/index.html')) u.pathname = u.pathname.slice(0, -10);
    return u.toString();
  } catch {
    return null;
  }
}

function isSameHost(urlStr, host) {
  try {
    return new URL(urlStr).host === host;
  } catch {
    return false;
  }
}

const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.css', '.js', '.mjs', '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.mp3', '.webm', '.zip', '.tar', '.gz', '.pdf']);

function isAsset(urlStr) {
  try {
    const u = new URL(urlStr);
    const ext = path.extname(u.pathname).toLowerCase();
    return SKIP_EXT.has(ext);
  } catch {
    return false;
  }
}

function slugFromUrl(urlStr) {
  const u = new URL(urlStr);
  let p = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!p) p = '_root';
  p = p.replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (u.search) {
    const qs = u.search.slice(1).replace(/[^a-zA-Z0-9._-]+/g, '_');
    p = p + '__' + qs;
  }
  if (p.length > 180) p = p.slice(0, 180);
  return p + '.md';
}

// ---------- fetch with retry + timeout ----------
async function fetchWithTimeout(url, { userAgent }, timeoutMs = 30000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---------- content extraction ----------
function extractTitleAndBody($) {
  let title = ($('meta[property="og:title"]').attr('content') || '').trim();
  if (!title) title = ($('title').first().text() || '').trim();
  if (!title) title = ($('h1').first().text() || '').trim();

  const candidates = [
    'main', 'article',
    '.main-content', '#main-content',
    '.content', '#content',
    '.docs-content', '.docs',
    '.kb-article', '.article-body',
    '.post-content', 'body',
  ];
  let $body = null;
  for (const sel of candidates) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 100) {
      $body = el;
      break;
    }
  }
  if (!$body) $body = $('body');

  $body.find('script, style, noscript, nav, header, footer, iframe, form').remove();

  return { title, bodyHtml: $body.html() || '' };
}

function extractLinks($, baseUrl) {
  const out = new Set();
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const abs = normalizeUrl(href, baseUrl);
    if (abs) out.add(abs);
  });
  return [...out];
}

// ---------- main ----------
async function main() {
  const cfg = parseArgs();
  const priorityCfg = loadPriorityConfig(cfg.priorityConfig);
  if (!fs.existsSync(cfg.outDir)) fs.mkdirSync(cfg.outDir, { recursive: true });

  const logPath = path.join(cfg.outDir, '_scrape.log');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    logStream.write(line + '\n');
  };

  log(`docs-mirror-scraper starting`);
  log(`  start=${cfg.start}`);
  log(`  host=${cfg.host}`);
  log(`  maxPages=${cfg.maxPages}`);
  log(`  delayMs=${cfg.delayMs}`);
  log(`  outDir=${cfg.outDir}`);
  log(`  priorityConfig=${cfg.priorityConfig || '(none)'}`);

  // robots.txt check
  const robotsUrl = new URL('/robots.txt', cfg.start).toString();
  log(`Fetching robots.txt: ${robotsUrl}`);
  let robots = null;
  try {
    const res = await fetchWithTimeout(robotsUrl, cfg);
    if (res.ok) {
      const body = await res.text();
      robots = robotsParser(robotsUrl, body);
      log(`robots.txt loaded (${body.length} chars)`);
    } else if (res.status === 404) {
      log(`robots.txt 404 - assuming everything allowed`);
      robots = robotsParser(robotsUrl, '');
    } else {
      log(`robots.txt HTTP ${res.status} - assuming everything allowed`);
      robots = robotsParser(robotsUrl, '');
    }
  } catch (e) {
    log(`robots.txt fetch failed (${e.message}) - assuming everything allowed`);
    robots = robotsParser(robotsUrl, '');
  }

  if (!robots.isAllowed(cfg.start, cfg.userAgent)) {
    log(`ABORT: robots.txt disallows ${cfg.start} for UA ${cfg.userAgent}`);
    console.error('robots.txt disallows the starting URL. Stopping.');
    process.exit(2);
  }

  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  const queue = [cfg.start];
  const seen = new Set([cfg.start]);
  const pages = [];
  let fetched = 0;
  let failed = 0;

  while (queue.length && fetched < cfg.maxPages) {
    const url = queue.shift();
    if (isAsset(url)) continue;
    if (!isSameHost(url, cfg.host)) continue;
    if (!robots.isAllowed(url, cfg.userAgent)) {
      log(`  skip (robots): ${url}`);
      continue;
    }

    fetched++;
    const n = fetched;
    log(`[${n}/${cfg.maxPages}] GET ${url}`);

    let res;
    try {
      res = await fetchWithTimeout(url, cfg);
    } catch (e) {
      log(`  ERROR fetch: ${e.message}`);
      failed++;
      pages.push({ url, title: '(fetch error)', slug: null, priority: 'SKIP', status: `fetch error: ${e.message}` });
      await sleep(cfg.delayMs);
      continue;
    }

    if (!res.ok) {
      log(`  HTTP ${res.status}`);
      failed++;
      pages.push({ url, title: `(HTTP ${res.status})`, slug: null, priority: 'SKIP', status: `HTTP ${res.status}` });
      await sleep(cfg.delayMs);
      continue;
    }

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('html') && !ct.includes('xml')) {
      log(`  skip non-HTML (${ct})`);
      await sleep(cfg.delayMs);
      continue;
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const { title, bodyHtml } = extractTitleAndBody($);
    const markdown = turndown.turndown(bodyHtml || '');
    const priority = classifyPriority(priorityCfg, url, title);
    const slug = slugFromUrl(url);
    const outPath = path.join(cfg.outDir, slug);
    const header = `<!-- source: ${url} -->\n<!-- title: ${title.replace(/\n/g, ' ')} -->\n<!-- priority: ${priority} -->\n<!-- scraped_at: ${new Date().toISOString()} -->\n\n# ${title || '(untitled)'}\n\n`;
    fs.writeFileSync(outPath, header + markdown);
    log(`  saved ${slug} (${markdown.length} chars, priority=${priority}, title="${title.slice(0, 80)}")`);
    pages.push({ url, title, slug, priority, status: 'ok' });

    const links = extractLinks($, url);
    for (const link of links) {
      const norm = normalizeUrl(link, url);
      if (!norm) continue;
      if (seen.has(norm)) continue;
      if (!isSameHost(norm, cfg.host)) continue;
      if (isAsset(norm)) continue;
      seen.add(norm);
      queue.push(norm);
    }

    await sleep(cfg.delayMs);
  }

  log(`Crawl done. fetched=${fetched} failed=${failed} queued_remaining=${queue.length} seen_total=${seen.size}`);

  writeIndex(cfg.outDir, pages, priorityCfg);
  if (priorityCfg) writeHighlights(cfg.outDir, pages, priorityCfg);

  log(`Wrote INDEX.md${priorityCfg ? ' and _highlights.md' : ''}`);
  log(`Done.`);
  logStream.end();
}

function writeIndex(outDir, pages, priorityCfg) {
  const groups = new Map();
  for (const p of pages) {
    if (!p.slug) continue;
    let section = '_root';
    try {
      const u = new URL(p.url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length) section = parts[0];
    } catch {}
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(p);
  }

  const lines = [];
  lines.push('# Docs Mirror - Index');
  lines.push('');
  lines.push(`Scraped ${pages.filter(p => p.slug).length} pages (${pages.filter(p => !p.slug).length} failed).`);
  lines.push('');
  if (priorityCfg) lines.push(`See \`_highlights.md\` for the prioritized view (${priorityCfg.label}).`);
  lines.push('');

  const sortedSections = [...groups.keys()].sort();
  for (const section of sortedSections) {
    lines.push(`## ${section}`);
    lines.push('');
    const items = groups.get(section).sort((a, b) => a.url.localeCompare(b.url));
    for (const p of items) {
      const mark = p.priority === 'HIGH' ? ' **[HIGH]**' : '';
      lines.push(`- [${p.title || p.slug}](${p.slug})${mark}`);
      lines.push(`    - ${p.url}`);
    }
    lines.push('');
  }

  const failed = pages.filter(p => !p.slug);
  if (failed.length) {
    lines.push('## _failed');
    lines.push('');
    for (const p of failed) {
      lines.push(`- ${p.url} - ${p.status}`);
    }
    lines.push('');
  }

  fs.writeFileSync(path.join(outDir, 'INDEX.md'), lines.join('\n'));
}

function writeHighlights(outDir, pages, priorityCfg) {
  const high = pages.filter(p => p.priority === 'HIGH' && p.slug);
  const med = pages.filter(p => p.priority === 'MEDIUM' && p.slug);
  const lines = [];
  lines.push(`# Docs Mirror - ${priorityCfg.label}`);
  lines.push('');
  if (priorityCfg.rationale) {
    lines.push(priorityCfg.rationale);
    lines.push('');
  }
  lines.push('## HIGH priority');
  lines.push('');
  if (!high.length) {
    lines.push('_No pages matched the HIGH priority patterns. Either the site uses different section names than your patterns expect, or the patterns are too narrow. Check INDEX.md to see actual section names._');
  } else {
    for (const p of high) {
      lines.push(`- [${p.title || p.slug}](${p.slug})`);
      lines.push(`    - ${p.url}`);
    }
  }
  lines.push('');
  lines.push(`## MEDIUM priority (${med.length} pages)`);
  lines.push('');
  lines.push('Listed in INDEX.md by section.');
  lines.push('');
  fs.writeFileSync(path.join(outDir, '_highlights.md'), lines.join('\n'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
