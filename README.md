# docs-mirror-scraper

![tests](https://github.com/USER/docs-mirror-scraper/actions/workflows/test.yml/badge.svg)

BFS-crawl any documentation site into a local Markdown mirror, so the docs are searchable / greppable / pasteable into your LLM context without webfetch round-trips.

Built originally for a single vendor's docs portal, generalized here for any site whose docs you'd rather read on disk than in your browser.

## What you get

- One `.md` file per page (slugged from the URL path)
- `INDEX.md` grouped by first path segment
- `_scrape.log` showing exactly what was fetched, skipped, and why
- `_highlights.md` (optional): pages matching your priority regex

## Install

```bash
npm install
```

## Usage

```bash
node index.js --start https://docs.example.com/
```

Optional flags:

```
--max N                 cap at N pages (default 300)
--delay MS              ms between requests (default 1000)
--out DIR               output dir (default ./docs_mirror)
--user-agent UA         custom UA string
--priority-config FILE  path to JSON file with HIGH priority regexes
```

## Priority config

When you only care about a slice of the site, point `--priority-config` at a JSON file:

```json
{
  "label": "Auth + Onboarding",
  "rationale": "What I'm reading first while implementing OAuth.",
  "high": [
    "\\boauth\\b",
    "\\bauthentic",
    "\\bonboarding\\b",
    "\\bgetting[-_ ]?started\\b"
  ]
}
```

Patterns are matched case-insensitively against `URL + ' ' + page title`. Anything that matches gets `[HIGH]` in `INDEX.md` and a dedicated entry in `_highlights.md`.

Two ready-to-use priority configs ship in `examples/`:

- `examples/priority-auth.json`: surfaces OAuth / auth / onboarding / quickstart / install pages
- `examples/priority-api-reference.json`: surfaces API reference / methods / endpoints / schema pages

Both work against any docs site without modification. Copy and edit to fit your reading priorities.

## Respect

The crawler honors `robots.txt` for the start URL's User-Agent. If `robots.txt` disallows your start URL, the crawl aborts. If `robots.txt` is unreachable, everything is allowed (matches the conservative-default expectation of most static doc hosts).

Default delay is 1 second between requests. Crank it down with `--delay 200` if the docs site is yours; leave it alone otherwise.

## Tests

```bash
npm test
# or
node --test tests/
```

25 unit tests on the pure URL / slug / priority / config helpers (`normalizeUrl`, `isSameHost`, `isAsset`, `slugFromUrl`, `classifyPriority`, `loadPriorityConfig`). HTTP-touching parts of the crawler aren't unit-tested here; they're verified via the example commands in CI.

`cheerio`, `robots-parser`, and `turndown` are lazy-loaded so tests run without `npm install`.

## Not in scope

- JavaScript-rendered sites (use Puppeteer or Playwright for those)
- Auth-walled docs (sign-in handling is left to the caller)
- Resumable crawls (re-runs overwrite output dir)

## License

MIT. See `LICENSE`.
