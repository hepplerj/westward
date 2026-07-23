# Western Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static, full-screen, infinite-scroll masonry explorer of ~1,500 public-domain American West photographs, harvested at build time from the Library of Congress, the Portal to Texas History, and SMU's DeGolyer Library.

**Architecture:** Two independent halves. (1) A Node harvest pipeline: one module per source normalizes API results to a common record schema; an orchestrator dedupes, rights-filters, interleaves, and writes chunked JSON manifests to `data/`. (2) A zero-dependency vanilla site (`index.html`/`style.css`/`app.js`) that renders the manifests as a lazy-loading masonry grid with a lightbox.

**Tech Stack:** Node ≥ 18 (global `fetch`, `node:test`), vanilla HTML/CSS/JS. No runtime dependencies, no build framework.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-western-explorer-design.md`. Read it before starting any task.
- Node ≥ 18 required; ESM everywhere (`"type": "module"`); zero npm dependencies (dev or runtime).
- **Record schema** (every source module must emit exactly this shape):
  ```json
  {
    "id": "loc:2017762891",
    "title": "Daniel Freeman homestead, Beatrice, Nebraska",
    "date": "1887",
    "creator": "Solomon D. Butcher",
    "source": "Library of Congress",
    "sourceUrl": "https://www.loc.gov/item/2017762891/",
    "imageUrl": "https://…",
    "thumbUrl": "https://…",
    "width": 987,
    "height": 1024,
    "subjects": ["Homesteading--Nebraska"]
  }
  ```
  `date`, `creator` may be `null`. `subjects` may be `[]`. `width`/`height` must be positive integers (masonry depends on them). `id` is `"{sourcePrefix}:{nativeId}"`.
- **Rights rule:** keep a record only if its rights text matches `/no known restrictions|public domain|no copyright|not in copyright/i`, OR the rights text is absent/empty AND the record's date parses to a year ≤ 1930 (published pre-1931 ⇒ US public domain). Implemented once in `scripts/lib/rights.mjs`; every source uses it.
- **Politeness:** every harvest request sends header `User-Agent: western-explorer-harvest/0.1 (jason.heppler@gmail.com)`. LOC JSON API throttled to 1 request / 3.5 s (hard limit: 20/min, 1-hour block on breach). Portal to Texas History and SMU throttled to 1 request / 350 ms.
- Images are never downloaded or rehosted; only URLs + metadata are stored.
- Live-API fixtures are captured once into `tests/fixtures/` and committed; unit tests run offline against fixtures and hand-written samples. **If a captured fixture's shape differs from the parsing code in this plan, adapt the parser to the real fixture — the output record schema is the contract and never changes.**
- Generated `data/manifest-*.json` / `data/index.json` are committed (the site is deployed as pure static files).
- Site: dark canvas, no framework, no external fonts/CDNs. Attribution visible in the lightbox.

## File Structure

```
package.json                      Task 1
scripts/lib/fetch-util.mjs        Task 1   throttled fetch + retry/backoff
scripts/lib/rights.mjs            Task 1   shared rights rule
scripts/sources/loc.mjs           Task 2
scripts/sources/texas.mjs         Task 3
scripts/sources/smu.mjs           Task 4
scripts/harvest.mjs               Task 5   orchestrator + CLI
scripts/check-images.mjs          Task 6   post-harvest URL spot-check
tests/*.test.mjs                  Tasks 1–5
tests/fixtures/                   Tasks 2–4 (committed API samples)
data/manifest-*.json, index.json  Tasks 6, 9 (generated, committed)
index.html, style.css, app.js     Tasks 7–8
```

---

### Task 1: Scaffolding, fetch utility, rights rule

**Files:**
- Create: `package.json`, `scripts/lib/fetch-util.mjs`, `scripts/lib/rights.mjs`, `tests/fetch-util.test.mjs`, `tests/rights.test.mjs`

**Interfaces:**
- Produces: `createFetcher({minIntervalMs, retries, fetchImpl, sleep}) → {fetchJson(url), fetchText(url)}` — both return a Promise; retry on 429/5xx/network errors/non-parseable ("Cloudflare HTML") responses with exponential backoff; throw immediately on other 4xx. `fetchText` retries only on 429/5xx/network.
- Produces: `isRightsOpen(rightsText, dateText) → boolean` implementing the Global Constraints rights rule; `yearOf(dateText) → number|null` (first 4-digit year in the string, 1600–2030).

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "western-explorer",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test tests/",
    "harvest": "node scripts/harvest.mjs",
    "harvest:quick": "node scripts/harvest.mjs --quick",
    "check-images": "node scripts/check-images.mjs"
  }
}
```

- [ ] **Step 2: Write the failing tests**

`tests/fetch-util.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetcher } from '../scripts/lib/fetch-util.mjs';

const noSleep = async () => {};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

test('fetchJson returns parsed JSON on success', async () => {
  const f = createFetcher({ fetchImpl: async () => jsonResponse({ a: 1 }), sleep: noSleep });
  assert.deepEqual(await f.fetchJson('http://x/'), { a: 1 });
});

test('fetchJson retries on 429 then succeeds', async () => {
  const calls = [];
  const responses = [jsonResponse('', 429), jsonResponse('', 429), jsonResponse({ ok: true })];
  const f = createFetcher({
    fetchImpl: async (url) => { calls.push(url); return responses.shift(); },
    sleep: noSleep,
  });
  assert.deepEqual(await f.fetchJson('http://x/'), { ok: true });
  assert.equal(calls.length, 3);
});

test('fetchJson retries when a 200 response is not JSON (Cloudflare HTML)', async () => {
  const responses = [jsonResponse('<html>challenge</html>'), jsonResponse({ ok: true })];
  const f = createFetcher({ fetchImpl: async () => responses.shift(), sleep: noSleep });
  assert.deepEqual(await f.fetchJson('http://x/'), { ok: true });
});

test('fetchJson throws immediately on 404 without retrying', async () => {
  let calls = 0;
  const f = createFetcher({ fetchImpl: async () => { calls++; return jsonResponse('', 404); }, sleep: noSleep });
  await assert.rejects(() => f.fetchJson('http://x/'), /404/);
  assert.equal(calls, 1);
});

test('fetchJson gives up after retries are exhausted', async () => {
  let calls = 0;
  const f = createFetcher({ retries: 2, fetchImpl: async () => { calls++; return jsonResponse('', 500); }, sleep: noSleep });
  await assert.rejects(() => f.fetchJson('http://x/'), /500/);
  assert.equal(calls, 3); // initial + 2 retries
});

test('throttling sleeps between rapid consecutive requests', async () => {
  const sleeps = [];
  const f = createFetcher({
    minIntervalMs: 1000,
    fetchImpl: async () => jsonResponse({}),
    sleep: async (ms) => { sleeps.push(ms); },
  });
  await f.fetchJson('http://x/1');
  await f.fetchJson('http://x/2');
  assert.ok(sleeps.some((ms) => ms > 0 && ms <= 1000), `expected a throttle sleep, got ${JSON.stringify(sleeps)}`);
});

test('fetchText returns body text', async () => {
  const f = createFetcher({ fetchImpl: async () => jsonResponse('<feed/>'), sleep: noSleep });
  assert.equal(await f.fetchText('http://x/'), '<feed/>');
});
```

`tests/rights.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRightsOpen, yearOf } from '../scripts/lib/rights.mjs';

test('accepts explicit open statements', () => {
  assert.equal(isRightsOpen('No known restrictions on publication.', null), true);
  assert.equal(isRightsOpen('Public domain', null), true);
  assert.equal(isRightsOpen('This item is not in copyright', null), true);
});

test('rejects restrictive statements regardless of date', () => {
  assert.equal(isRightsOpen('Copyright held by the estate. Contact for permission.', '1880'), false);
  assert.equal(isRightsOpen('Rights reserved', '1880'), false);
});

test('missing rights: accepted only when date year <= 1930', () => {
  assert.equal(isRightsOpen('', '1887'), true);
  assert.equal(isRightsOpen(null, 'ca. 1905'), true);
  assert.equal(isRightsOpen(null, '1942'), false);
  assert.equal(isRightsOpen(null, null), false);
  assert.equal(isRightsOpen(null, 'undated'), false);
});

test('yearOf extracts a plausible 4-digit year', () => {
  assert.equal(yearOf('ca. 1905'), 1905);
  assert.equal(yearOf('1887-06-12'), 1887);
  assert.equal(yearOf('between 1870 and 1880'), 1870);
  assert.equal(yearOf('no date'), null);
  assert.equal(yearOf('item 12345'), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/lib/fetch-util.mjs` (and rights.mjs).

- [ ] **Step 4: Implement `scripts/lib/fetch-util.mjs`**

```js
// Throttled fetch with retry/backoff for cultural-heritage APIs.
// Retryable: 429, 5xx, network errors, and 200s whose body is not what we
// expected (LOC's Cloudflare serves HTML challenge pages with status 200).
// Other 4xx throw immediately.

const USER_AGENT = 'western-explorer-harvest/0.1 (jason.heppler@gmail.com)';

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export function createFetcher({
  minIntervalMs = 0,
  retries = 4,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  let lastRequestAt = 0;

  async function throttled(url) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
  }

  // parse(text) returns the value to resolve with, or throws to trigger a retry.
  async function fetchWithRetry(url, parse) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
      let res;
      try {
        res = await throttled(url);
      } catch (err) {
        lastError = err; // network error
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(res.status, url);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      const text = await res.text();
      try {
        return parse(text);
      } catch {
        lastError = new Error(`Unparseable response from ${url}`);
        continue;
      }
    }
    throw lastError;
  }

  return {
    fetchJson: (url) => fetchWithRetry(url, (text) => JSON.parse(text)),
    fetchText: (url) => fetchWithRetry(url, (text) => text),
  };
}
```

- [ ] **Step 5: Implement `scripts/lib/rights.mjs`**

```js
// Shared rights rule (see spec "Rights" notes): explicit open statement, or
// no statement at all on an item published before 1931 (US public domain).

const OPEN = /no known restrictions|public domain|no copyright|not in copyright/i;

export function yearOf(dateText) {
  const m = String(dateText ?? '').match(/\b(1[6-9]\d\d|20[0-2]\d|2030)\b/);
  return m ? Number(m[1]) : null;
}

export function isRightsOpen(rightsText, dateText) {
  const rights = String(rightsText ?? '').trim();
  if (rights) return OPEN.test(rights);
  const year = yearOf(dateText);
  return year !== null && year <= 1930;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all tests in both files).

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/lib/ tests/
git commit -m "feat: scaffolding, throttled fetcher, shared rights rule"
```

---

### Task 2: Library of Congress source module

**Files:**
- Create: `scripts/sources/loc.mjs`, `tests/loc.test.mjs`, `tests/fixtures/loc-search.json`

**Interfaces:**
- Consumes: `createFetcher` from `scripts/lib/fetch-util.mjs`; `isRightsOpen` from `scripts/lib/rights.mjs`.
- Produces: `parseImageUrl(raw) → {url, width, height}|null`; `parseSearchPage(json) → Record[]` (pure); `harvestLoc(fetcher, {target, log}) → Promise<Record[]>`. Record = Global Constraints schema, ids `loc:*`, `source: "Library of Congress"`.

- [ ] **Step 1: Capture a real fixture**

```bash
curl -s -A "western-explorer-harvest/0.1 (jason.heppler@gmail.com)" \
  "https://www.loc.gov/photos/?q=homesteading&fa=online-format:image&fo=json&c=50&at=results,pagination" \
  -o tests/fixtures/loc-search.json
head -c 300 tests/fixtures/loc-search.json
```

Expected: output starts with `{` and contains `"results"`. If you get HTML (Cloudflare), wait ~30 s and retry; do not hammer. Inspect the fixture (`jq '.results[0] | keys' tests/fixtures/loc-search.json`) and reconcile the parser below with reality per Global Constraints.

- [ ] **Step 2: Write the failing tests**

`tests/loc.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseImageUrl, parseSearchPage } from '../scripts/sources/loc.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/loc-search.json', import.meta.url), 'utf8'));

test('parseImageUrl extracts URL and dimensions from the #h=&w= fragment', () => {
  const r = parseImageUrl('//tile.loc.gov/storage-services/service/pnp/fsa/8d22000/8d22600/8d22658r.jpg#h=640&w=617');
  assert.deepEqual(r, {
    url: 'https://tile.loc.gov/storage-services/service/pnp/fsa/8d22000/8d22600/8d22658r.jpg',
    width: 617,
    height: 640,
  });
});

test('parseImageUrl rejects URLs without dimension fragments', () => {
  assert.equal(parseImageUrl('https://tile.loc.gov/x/y.jpg'), null);
  assert.equal(parseImageUrl('https://tile.loc.gov/x/y.gif#h=0&w=0'), null);
});

test('parseSearchPage yields schema-valid records from the live fixture', () => {
  const records = parseSearchPage(fixture);
  assert.ok(records.length > 0, 'fixture should yield at least one record');
  for (const r of records) {
    assert.match(r.id, /^loc:.+/);
    assert.equal(r.source, 'Library of Congress');
    assert.ok(r.title.length > 0);
    assert.match(r.sourceUrl, /^https?:\/\/www\.loc\.gov\//);
    assert.match(r.imageUrl, /^https:\/\//);
    assert.match(r.thumbUrl, /^https:\/\//);
    assert.ok(Number.isInteger(r.width) && r.width > 0);
    assert.ok(Number.isInteger(r.height) && r.height > 0);
    assert.ok(Array.isArray(r.subjects));
  }
});

test('parseSearchPage drops items without an open-rights statement', () => {
  const page = {
    results: [{
      id: 'https://www.loc.gov/item/123/',
      title: 'Restricted photo',
      image_url: ['//tile.loc.gov/x/yr.jpg#h=640&w=480'],
      item: { rights_advisory: ['Publication may be restricted.'] },
    }],
  };
  assert.deepEqual(parseSearchPage(page), []);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/sources/loc.mjs`.

- [ ] **Step 4: Implement `scripts/sources/loc.mjs`**

```js
// Library of Congress JSON API (https://www.loc.gov/apis/json-and-yaml/).
// Search results embed derivative image URLs with pixel dimensions as URL
// fragments ("...r.jpg#h=640&w=617"), so no per-item requests are needed.
// Hard limit: 20 JSON requests/minute — the caller passes a fetcher
// throttled to 3500 ms.

import { isRightsOpen } from '../lib/rights.mjs';

// (label, search URL without &c=&sp=, quota) — quotas sum to ~1000.
const QUERIES = [
  ['fsa-ranch', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=ranch&fa=access-restricted:false&fo=json', 150],
  ['fsa-homestead', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=homestead&fa=access-restricted:false&fo=json', 100],
  ['fsa-cattle', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=cattle&fa=access-restricted:false&fo=json', 100],
  ['fsa-farm-plains', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=farm&fa=location:south+dakota&fo=json', 50],
  ['detroit-colorado', 'https://www.loc.gov/collections/detroit-publishing-company/?q=colorado&fo=json', 75],
  ['detroit-wyoming', 'https://www.loc.gov/collections/detroit-publishing-company/?q=wyoming&fo=json', 50],
  ['detroit-montana', 'https://www.loc.gov/collections/detroit-publishing-company/?q=montana&fo=json', 50],
  ['panoramic-ranch', 'https://www.loc.gov/collections/panoramic-photographs/?q=ranch&fo=json', 50],
  ['panoramic-cattle', 'https://www.loc.gov/collections/panoramic-photographs/?q=cattle&fo=json', 25],
  ['curtis', 'https://www.loc.gov/collections/edward-s-curtis/?fo=json', 100],
  ['photos-homesteading', 'https://www.loc.gov/photos/?q=homesteading&fa=online-format:image&fo=json', 75],
  ['photos-sod-house', 'https://www.loc.gov/photos/?q=sod+house&fa=online-format:image&fo=json', 50],
  ['photos-cattle-drive', 'https://www.loc.gov/photos/?q=cattle+drive&fa=online-format:image&fo=json', 50],
  ['photos-chuck-wagon', 'https://www.loc.gov/photos/?q=chuck+wagon&fa=online-format:image&fo=json', 25],
  ['photos-prairie', 'https://www.loc.gov/photos/?q=prairie+settlers&fa=online-format:image&fo=json', 50],
];

export function parseImageUrl(raw) {
  const m = String(raw ?? '').match(/^(.*\.jpg)#h=(\d+)&w=(\d+)$/i);
  if (!m) return null;
  const height = Number(m[2]);
  const width = Number(m[3]);
  if (!width || !height) return null;
  let url = m[1];
  if (url.startsWith('//')) url = `https:${url}`;
  return { url, width, height };
}

function first(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return value ? String(value) : null;
}

function toRecord(result) {
  const item = result.item ?? {};
  const images = (result.image_url ?? []).map(parseImageUrl).filter(Boolean)
    .sort((a, b) => a.width - b.width);
  if (!images.length) return null;
  const image = images[images.length - 1];
  if (image.width < 300 && image.height < 300) return null; // thumbnail-only item
  const thumb = images.find((i) => i.width >= 400) ?? image;

  const rights = [item.rights_advisory, item.rights_information, result.rights_advisory]
    .flat().filter(Boolean).join(' ');
  const date = first(result.date) ?? first(item.date);
  if (!isRightsOpen(rights, date)) return null;

  const sourceUrl = String(result.id ?? result.url ?? '');
  if (!sourceUrl.startsWith('http')) return null;
  const nativeId = sourceUrl.replace(/\/+$/, '').split('/').pop();
  const title = String(result.title ?? '').trim();
  if (!nativeId || !title) return null;

  const subjects = [item.subject_headings ?? result.subject ?? []]
    .flat(2).filter(Boolean).map(String);

  return {
    id: `loc:${nativeId}`,
    title,
    date: date ?? null,
    creator: first(result.contributor) ?? null,
    source: 'Library of Congress',
    sourceUrl,
    imageUrl: image.url,
    thumbUrl: thumb.url,
    width: image.width,
    height: image.height,
    subjects,
  };
}

export function parseSearchPage(json) {
  return (json.results ?? []).map(toRecord).filter(Boolean);
}

export async function harvestLoc(fetcher, { target = 1000, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [label, baseUrl, quota] of QUERIES) {
    if (records.length >= target) break;
    let kept = 0;
    for (let page = 1; kept < quota && page <= 5; page++) {
      let json;
      try {
        json = await fetcher.fetchJson(`${baseUrl}&c=100&sp=${page}&at=results,pagination`);
      } catch (err) {
        log(`loc:${label} page ${page} failed: ${err.message}`);
        break;
      }
      const pageRecords = parseSearchPage(json);
      for (const r of pageRecords) {
        if (kept >= quota || records.length >= target) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
        kept++;
      }
      if (!json.pagination?.next) break;
    }
    log(`loc:${label} kept ${kept}`);
  }
  return records;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. If the fixture test fails, inspect the fixture and fix the parser (schema is the contract), not the test's structural assertions.

- [ ] **Step 6: Smoke-test one live page**

```bash
node -e "
import('./scripts/sources/loc.mjs').then(async ({ harvestLoc }) => {
  const { createFetcher } = await import('./scripts/lib/fetch-util.mjs');
  const recs = await harvestLoc(createFetcher({ minIntervalMs: 3500 }), { target: 30 });
  console.log(recs.length, 'records; first:', JSON.stringify(recs[0], null, 2));
});"
```

Expected: ≥ 20 records; first record shows real title/imageUrl/width/height.

- [ ] **Step 7: Commit**

```bash
git add scripts/sources/loc.mjs tests/loc.test.mjs tests/fixtures/loc-search.json
git commit -m "feat: Library of Congress harvest module"
```

---

### Task 3: Portal to Texas History source module

**Files:**
- Create: `scripts/sources/texas.mjs`, `tests/texas.test.mjs`, `tests/fixtures/texas-opensearch.xml`, `tests/fixtures/texas-manifest.json`

**Interfaces:**
- Consumes: fetcher (`fetchJson`, `fetchText`); `isRightsOpen` from `scripts/lib/rights.mjs`.
- Produces: `extractArks(atomXml) → string[]` (ARK names like `metapth123456`, deduped, order preserved); `manifestToRecord(arkName, manifest) → Record|null`; `harvestTexas(fetcher, {target, log}) → Promise<Record[]>`. Ids `texas:*`, `source: "Portal to Texas History"`.

- [ ] **Step 1: Capture real fixtures**

```bash
curl -s -A "western-explorer-harvest/0.1 (jason.heppler@gmail.com)" \
  "https://texashistory.unt.edu/search/opensearch/?q=cattle+ranch" \
  -o tests/fixtures/texas-opensearch.xml
grep -o 'ark:/67531/[a-z0-9]*' tests/fixtures/texas-opensearch.xml | sort -u | head
```

Expected: a list of ARK names. Take the first one and capture its manifest:

```bash
ARK=$(grep -o 'ark:/67531/[a-z0-9]*' tests/fixtures/texas-opensearch.xml | head -1 | cut -d/ -f3)
curl -s -A "western-explorer-harvest/0.1 (jason.heppler@gmail.com)" \
  "https://texashistory.unt.edu/ark:/67531/$ARK/manifest/" \
  -o tests/fixtures/texas-manifest.json
jq '{label, license, metadata: (.metadata // [] | map(.label)), canvas: .sequences[0].canvases[0] | {width, height}}' \
  tests/fixtures/texas-manifest.json
```

Expected: JSON with a label and canvas width/height. Check the OpenSearch description document (`curl -s https://texashistory.unt.edu/search/opensearch/ | head -50` shows the feed; look for the paging attributes — OpenSearch feeds declare `itemsPerPage`/`startIndex`) and note which query parameter pages the feed; reconcile `pageUrl()` below with what you find.

- [ ] **Step 2: Write the failing tests**

`tests/texas.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractArks, manifestToRecord } from '../scripts/sources/texas.mjs';

const atom = readFileSync(new URL('./fixtures/texas-opensearch.xml', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('./fixtures/texas-manifest.json', import.meta.url), 'utf8'));

test('extractArks finds deduped ARK names in the Atom feed', () => {
  const arks = extractArks(atom);
  assert.ok(arks.length > 0, 'feed should contain ARKs');
  assert.ok(arks.every((a) => /^[a-z0-9]+$/.test(a)));
  assert.equal(new Set(arks).size, arks.length, 'no duplicates');
});

test('manifestToRecord builds a schema-valid record from the live fixture', () => {
  const arkName = 'metapth12345'; // name is caller-supplied; any value works here
  const r = manifestToRecord(arkName, manifest);
  // The fixture item may legitimately fail the rights rule; only assert shape when kept.
  if (r === null) return;
  assert.equal(r.id, `texas:${arkName}`);
  assert.equal(r.source, 'Portal to Texas History');
  assert.ok(r.title.length > 0);
  assert.match(r.sourceUrl, /texashistory\.unt\.edu\/ark:/);
  assert.match(r.imageUrl, /\/full\/1024,\/0\/default\.jpg$/);
  assert.match(r.thumbUrl, /\/full\/640,\/0\/default\.jpg$/);
  assert.ok(Number.isInteger(r.width) && r.width > 0);
  assert.ok(Number.isInteger(r.height) && r.height > 0);
});

test('manifestToRecord drops manifests with restrictive rights', () => {
  const closed = {
    label: 'A photo',
    metadata: [{ label: 'Rights', value: 'All rights reserved. Contact the owner.' }],
    sequences: [{ canvases: [{ width: 1000, height: 800, images: [{ resource: { service: { '@id': 'https://texashistory.unt.edu/iiif/ark:/67531/x/m1/1' } } }] }] }],
  };
  assert.equal(manifestToRecord('x', closed), null);
});

test('manifestToRecord tolerates a missing canvas', () => {
  assert.equal(manifestToRecord('x', { label: 'Empty', sequences: [] }), null);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/sources/texas.mjs`.

- [ ] **Step 4: Implement `scripts/sources/texas.mjs`**

```js
// Portal to Texas History (UNT). Discovery via the OpenSearch Atom feed
// (regex ARK extraction — no XML parser dependency); per-item metadata,
// dimensions, and IIIF image service from the item's IIIF Presentation
// manifest at {ark-url}/manifest/.

import { isRightsOpen } from '../lib/rights.mjs';

const BASE = 'https://texashistory.unt.edu';
const SEARCHES = [
  ['cattle ranch', 120],
  ['homestead', 80],
  ['windmill farm', 60],
  ['cattle drive', 50],
  ['railroad depot', 40],
];

export function extractArks(atomXml) {
  const seen = new Set();
  for (const m of String(atomXml).matchAll(/ark:\/67531\/([a-z0-9]+)/g)) seen.add(m[1]);
  return [...seen];
}

function metaValue(manifest, labelRe) {
  for (const entry of manifest.metadata ?? []) {
    if (labelRe.test(String(entry.label ?? ''))) {
      return Array.isArray(entry.value) ? entry.value.join(' ') : String(entry.value ?? '');
    }
  }
  return null;
}

function plainLabel(label) {
  // IIIF labels may be strings, arrays, or {"@value": ...} / {"en": [...]}.
  if (typeof label === 'string') return label;
  if (Array.isArray(label)) return plainLabel(label[0]);
  if (label && typeof label === 'object') {
    return plainLabel(label['@value'] ?? Object.values(label)[0]);
  }
  return '';
}

export function manifestToRecord(arkName, manifest) {
  const canvas = manifest.sequences?.[0]?.canvases?.[0];
  const service = canvas?.images?.[0]?.resource?.service?.['@id'];
  const width = Number(canvas?.width);
  const height = Number(canvas?.height);
  if (!service || !width || !height) return null;

  const title = plainLabel(manifest.label).trim();
  if (!title) return null;

  const date = metaValue(manifest, /^date/i);
  const rights = [manifest.license, metaValue(manifest, /rights|license/i)].filter(Boolean).join(' ');
  if (!isRightsOpen(rights, date)) return null;

  return {
    id: `texas:${arkName}`,
    title,
    date: date ?? null,
    creator: metaValue(manifest, /^creator|^photographer/i),
    source: 'Portal to Texas History',
    sourceUrl: `${BASE}/ark:/67531/${arkName}/`,
    imageUrl: `${service}/full/1024,/0/default.jpg`,
    thumbUrl: `${service}/full/640,/0/default.jpg`,
    width,
    height,
    subjects: (metaValue(manifest, /^subject/i) ?? '').split('|').map((s) => s.trim()).filter(Boolean),
  };
}

// Reconcile the paging parameter with the OpenSearch description document
// captured in Task 3 Step 1 (OpenSearch feeds declare their paging contract).
function pageUrl(query, page) {
  return `${BASE}/search/opensearch/?q=${encodeURIComponent(query)}&page=${page}`;
}

export async function harvestTexas(fetcher, { target = 350, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [query, quota] of SEARCHES) {
    if (records.length >= target) break;
    let kept = 0;
    for (let page = 1; kept < quota && page <= 8; page++) {
      let arks;
      try {
        arks = extractArks(await fetcher.fetchText(pageUrl(query, page)));
      } catch (err) {
        log(`texas:"${query}" page ${page} failed: ${err.message}`);
        break;
      }
      if (!arks.length) break;
      for (const ark of arks) {
        if (kept >= quota || records.length >= target) break;
        if (seen.has(ark)) continue;
        seen.add(ark);
        let record = null;
        try {
          record = manifestToRecord(ark, await fetcher.fetchJson(`${BASE}/ark:/67531/${ark}/manifest/`));
        } catch (err) {
          log(`texas:${ark} manifest failed: ${err.message}`);
        }
        if (record) {
          records.push(record);
          kept++;
        }
      }
    }
    log(`texas:"${query}" kept ${kept}`);
  }
  return records;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test live**

```bash
node -e "
import('./scripts/sources/texas.mjs').then(async ({ harvestTexas }) => {
  const { createFetcher } = await import('./scripts/lib/fetch-util.mjs');
  const recs = await harvestTexas(createFetcher({ minIntervalMs: 350 }), { target: 15 });
  console.log(recs.length, 'records; first:', JSON.stringify(recs[0], null, 2));
});"
```

Expected: ≥ 5 records with texashistory.unt.edu IIIF imageUrls and positive dimensions. If zero, debug pagination/rights before proceeding (use superpowers:systematic-debugging).

- [ ] **Step 7: Commit**

```bash
git add scripts/sources/texas.mjs tests/texas.test.mjs tests/fixtures/texas-opensearch.xml tests/fixtures/texas-manifest.json
git commit -m "feat: Portal to Texas History harvest module"
```

---

### Task 4: SMU DeGolyer Library source module

**Files:**
- Create: `scripts/sources/smu.mjs`, `tests/smu.test.mjs`, `tests/fixtures/smu-search.json`, `tests/fixtures/smu-iteminfo.json`, `tests/fixtures/smu-info.json`

**Interfaces:**
- Consumes: fetcher (`fetchJson`); `isRightsOpen` from `scripts/lib/rights.mjs`.
- Produces: `parseSearchItems(json) → {alias, itemId}[]`; `buildRecord({alias, itemId, itemInfo, imageInfo}) → Record|null`; `harvestSmu(fetcher, {target, log}) → Promise<Record[]>`. Ids `smu:{alias}:{itemId}`, `source: "SMU DeGolyer Library"`.

- [ ] **Step 1: Capture real fixtures**

```bash
curl -s -A "western-explorer-harvest/0.1 (jason.heppler@gmail.com)" \
  "https://digitalcollections.smu.edu/digital/api/search/collection/wes/searchterm/cowboy/maxRecords/50" \
  -o tests/fixtures/smu-search.json
jq '{total: .totalResults, first: .items[0]}' tests/fixtures/smu-search.json
```

Expected: JSON with `items[]` carrying `itemId` (and collection alias fields). Then, using the first item's id:

```bash
ID=$(jq -r '.items[0].itemId' tests/fixtures/smu-search.json)
curl -s "https://digitalcollections.smu.edu/digital/bl/dmwebservices/index.php?q=dmGetItemInfo/wes/$ID/json" \
  -o tests/fixtures/smu-iteminfo.json
curl -s "https://digitalcollections.smu.edu/digital/iiif/wes/$ID/info.json" \
  -o tests/fixtures/smu-info.json
jq '{title, date, rights: (.rights // .copyri)}' tests/fixtures/smu-iteminfo.json
jq '{width, height}' tests/fixtures/smu-info.json
```

Expected: item metadata (note the actual field nicknames — CONTENTdm truncates, e.g. `subjec`, `creato`) and IIIF width/height. If the IIIF path 404s, try `/digital/iiif/2/wes:$ID/info.json` and adjust `imageInfoUrl()` below. Reconcile parser field names with the fixtures.

- [ ] **Step 2: Write the failing tests**

`tests/smu.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSearchItems, buildRecord } from '../scripts/sources/smu.mjs';

const search = JSON.parse(readFileSync(new URL('./fixtures/smu-search.json', import.meta.url), 'utf8'));
const itemInfo = JSON.parse(readFileSync(new URL('./fixtures/smu-iteminfo.json', import.meta.url), 'utf8'));
const imageInfo = JSON.parse(readFileSync(new URL('./fixtures/smu-info.json', import.meta.url), 'utf8'));

test('parseSearchItems yields alias + numeric itemId pairs', () => {
  const items = parseSearchItems(search);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.ok(it.alias.length > 0);
    assert.ok(Number.isInteger(it.itemId) && it.itemId >= 0);
  }
});

test('buildRecord builds a schema-valid record from live fixtures', () => {
  const { alias, itemId } = parseSearchItems(search)[0];
  const r = buildRecord({ alias, itemId, itemInfo, imageInfo });
  if (r === null) return; // fixture item may fail the rights rule
  assert.equal(r.id, `smu:${alias}:${itemId}`);
  assert.equal(r.source, 'SMU DeGolyer Library');
  assert.ok(r.title.length > 0);
  assert.match(r.sourceUrl, /digitalcollections\.smu\.edu\/digital\/collection\//);
  assert.match(r.imageUrl, /\/full\/1024,\/0\/default\.jpg$/);
  assert.ok(Number.isInteger(r.width) && r.width > 0);
  assert.ok(Number.isInteger(r.height) && r.height > 0);
});

test('buildRecord drops items with restrictive rights', () => {
  const closed = buildRecord({
    alias: 'wes',
    itemId: 1,
    itemInfo: { title: 'A photo', date: '1955', rights: 'Copyright SMU. Permission required.' },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.equal(closed, null);
});

test('buildRecord accepts rights-silent 19th-century items', () => {
  const open = buildRecord({
    alias: 'wes',
    itemId: 2,
    itemInfo: { title: 'Cattle trail, 1885', date: '1885', rights: '' },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.ok(open);
  assert.equal(open.width, 1024);
  assert.equal(open.height, 768); // scaled to the 1024px derivative we link
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/sources/smu.mjs`.

- [ ] **Step 4: Implement `scripts/sources/smu.mjs`**

```js
// SMU DeGolyer Library (CONTENTdm). Search via the /digital/api/search JSON
// endpoint; per-item metadata via dmwebservices dmGetItemInfo; dimensions via
// the IIIF Image API info.json. Collections: wes (U.S. West), rwy (Railroads).

import { isRightsOpen } from '../lib/rights.mjs';

const BASE = 'https://digitalcollections.smu.edu';
const SEARCHES = [
  ['wes', 'cowboy', 40],
  ['wes', 'ranch', 40],
  ['wes', 'cattle', 30],
  ['rwy', 'railroad', 40],
];

export function parseSearchItems(json) {
  return (json.items ?? [])
    .map((it) => ({
      alias: String(it.collectionAlias ?? it.alias ?? 'wes').replace(/^\//, ''),
      itemId: Number(it.itemId ?? it.id),
    }))
    .filter((it) => it.alias && Number.isInteger(it.itemId) && it.itemId >= 0);
}

// CONTENTdm field nicknames are truncated and collection-specific; read the
// common spellings defensively. Missing fields come back as {} in some
// responses, hence the object check.
function field(itemInfo, ...names) {
  for (const name of names) {
    const v = itemInfo?.[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export function buildRecord({ alias, itemId, itemInfo, imageInfo }) {
  const srcWidth = Number(imageInfo?.width);
  const srcHeight = Number(imageInfo?.height);
  if (!srcWidth || !srcHeight) return null;

  const title = field(itemInfo, 'title');
  if (!title) return null;

  const date = field(itemInfo, 'date', 'dated');
  const rights = field(itemInfo, 'rights', 'copyri', 'copyright', 'usage');
  if (!isRightsOpen(rights, date)) return null;

  // We link the 1024px-wide IIIF derivative, so store its dimensions.
  const width = Math.min(1024, srcWidth);
  const height = Math.round(srcHeight * (width / srcWidth));

  return {
    id: `smu:${alias}:${itemId}`,
    title,
    date,
    creator: field(itemInfo, 'creato', 'creator', 'photog'),
    source: 'SMU DeGolyer Library',
    sourceUrl: `${BASE}/digital/collection/${alias}/id/${itemId}`,
    imageUrl: `${BASE}/digital/iiif/${alias}/${itemId}/full/1024,/0/default.jpg`,
    thumbUrl: `${BASE}/digital/iiif/${alias}/${itemId}/full/640,/0/default.jpg`,
    width,
    height,
    subjects: (field(itemInfo, 'subjec', 'subject') ?? '').split(';').map((s) => s.trim()).filter(Boolean),
  };
}

function imageInfoUrl(alias, itemId) {
  return `${BASE}/digital/iiif/${alias}/${itemId}/info.json`;
}

export async function harvestSmu(fetcher, { target = 150, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [alias, query, quota] of SEARCHES) {
    if (records.length >= target) break;
    let kept = 0;
    let items;
    try {
      items = parseSearchItems(await fetcher.fetchJson(
        `${BASE}/digital/api/search/collection/${alias}/searchterm/${encodeURIComponent(query)}/maxRecords/100`,
      ));
    } catch (err) {
      log(`smu:${alias}/${query} search failed: ${err.message}`);
      continue;
    }
    for (const { alias: itemAlias, itemId } of items) {
      if (kept >= quota || records.length >= target) break;
      const key = `${itemAlias}:${itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let record = null;
      try {
        const itemInfo = await fetcher.fetchJson(
          `${BASE}/digital/bl/dmwebservices/index.php?q=dmGetItemInfo/${itemAlias}/${itemId}/json`,
        );
        const imageInfo = await fetcher.fetchJson(imageInfoUrl(itemAlias, itemId));
        record = buildRecord({ alias: itemAlias, itemId, itemInfo, imageInfo });
      } catch (err) {
        log(`smu:${key} failed: ${err.message}`);
      }
      if (record) {
        records.push(record);
        kept++;
      }
    }
    log(`smu:${alias}/${query} kept ${kept}`);
  }
  return records;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Smoke-test live**

```bash
node -e "
import('./scripts/sources/smu.mjs').then(async ({ harvestSmu }) => {
  const { createFetcher } = await import('./scripts/lib/fetch-util.mjs');
  const recs = await harvestSmu(createFetcher({ minIntervalMs: 350 }), { target: 10 });
  console.log(recs.length, 'records; first:', JSON.stringify(recs[0], null, 2));
});"
```

Expected: ≥ 3 records with SMU IIIF imageUrls. If zero, debug (rights rule vs. actual field names is the likely culprit).

- [ ] **Step 7: Commit**

```bash
git add scripts/sources/smu.mjs tests/smu.test.mjs tests/fixtures/smu-*.json
git commit -m "feat: SMU DeGolyer harvest module"
```

---

### Task 5: Harvest orchestrator

**Files:**
- Create: `scripts/harvest.mjs`, `tests/harvest.test.mjs`

**Interfaces:**
- Consumes: `harvestLoc` / `harvestTexas` / `harvestSmu` (each `(fetcher, {target, log}) → Promise<Record[]>`); `createFetcher`.
- Produces: pure exports `dedupeRecords(records)`, `validateRecord(record) → string|null`, `interleave(lists) → Record[]` (proportional round-robin across N lists), `chunk(records, size) → Record[][]`; CLI writing `data/index.json` (`{generated, total, chunkCount, chunkSize, sources: {name: count}}`) and `data/manifest-000.json`… (arrays of Records).

- [ ] **Step 1: Write the failing tests**

`tests/harvest.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRecords, validateRecord, interleave, chunk } from '../scripts/harvest.mjs';

const rec = (id, extra = {}) => ({
  id, title: 't', date: '1900', creator: null,
  source: 'Library of Congress', sourceUrl: 'https://www.loc.gov/item/1/',
  imageUrl: `https://img/${id}.jpg`, thumbUrl: `https://img/${id}-t.jpg`,
  width: 800, height: 600, subjects: [], ...extra,
});

test('dedupeRecords drops duplicate ids and duplicate imageUrls', () => {
  const a = rec('loc:1');
  const b = rec('loc:2', { imageUrl: a.imageUrl }); // same image, different id
  const c = rec('loc:1');                            // same id
  const d = rec('loc:3');
  assert.deepEqual(dedupeRecords([a, b, c, d]).map((r) => r.id), ['loc:1', 'loc:3']);
});

test('validateRecord accepts a good record and names the flaw in a bad one', () => {
  assert.equal(validateRecord(rec('loc:1')), null);
  assert.match(validateRecord(rec('loc:1', { width: 0 })), /width/);
  assert.match(validateRecord(rec('loc:1', { imageUrl: 'ftp://x' })), /imageUrl/);
  assert.match(validateRecord(rec('loc:1', { title: '' })), /title/);
  assert.match(validateRecord({ ...rec('loc:1'), subjects: 'oops' }), /subjects/);
});

test('interleave spreads sources proportionally and keeps every record', () => {
  const a = [rec('a:1'), rec('a:2'), rec('a:3'), rec('a:4')];
  const b = [rec('b:1'), rec('b:2')];
  const out = interleave([a, b]);
  assert.equal(out.length, 6);
  assert.deepEqual(new Set(out.map((r) => r.id)), new Set(['a:1','a:2','a:3','a:4','b:1','b:2']));
  // No source should be exhausted only at the very end: a "b" record must
  // appear in the first half.
  assert.ok(out.slice(0, 3).some((r) => r.id.startsWith('b:')));
});

test('chunk splits into fixed-size groups preserving order', () => {
  const records = Array.from({ length: 5 }, (_, i) => rec(`x:${i}`));
  const chunks = chunk(records, 2);
  assert.deepEqual(chunks.map((c) => c.length), [2, 2, 1]);
  assert.equal(chunks[2][0].id, 'x:4');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../scripts/harvest.mjs`.

- [ ] **Step 3: Implement `scripts/harvest.mjs`**

```js
// Harvest orchestrator. Runs all source modules, dedupes, validates,
// interleaves for visual variety, chunks, and writes data/.
// Usage: node scripts/harvest.mjs [--quick]

import { mkdir, writeFile } from 'node:fs/promises';
import { createFetcher } from './lib/fetch-util.mjs';
import { harvestLoc } from './sources/loc.mjs';
import { harvestTexas } from './sources/texas.mjs';
import { harvestSmu } from './sources/smu.mjs';

const CHUNK_SIZE = 100;

export function dedupeRecords(records) {
  const ids = new Set();
  const urls = new Set();
  const out = [];
  for (const r of records) {
    if (ids.has(r.id) || urls.has(r.imageUrl)) continue;
    ids.add(r.id);
    urls.add(r.imageUrl);
    out.push(r);
  }
  return out;
}

export function validateRecord(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r.id !== 'string' || !/^[a-z]+:.+/.test(r.id)) return 'bad id';
  if (typeof r.title !== 'string' || !r.title.trim()) return 'empty title';
  if (typeof r.source !== 'string' || !r.source) return 'missing source';
  for (const key of ['sourceUrl', 'imageUrl', 'thumbUrl']) {
    if (typeof r[key] !== 'string' || !/^https?:\/\//.test(r[key])) return `bad ${key}`;
  }
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(r[key]) || r[key] <= 0) return `bad ${key}`;
  }
  if (!Array.isArray(r.subjects)) return 'bad subjects';
  return null;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Proportional round-robin: at each step take from the list with the highest
// fraction of records still unplaced, so small sources spread across the
// whole stream instead of clustering.
export function interleave(lists) {
  const pools = lists.filter((l) => l.length).map((l) => ({ items: [...l], total: l.length }));
  const out = [];
  while (pools.some((p) => p.items.length)) {
    let best = null;
    for (const p of pools) {
      if (!p.items.length) continue;
      if (!best || p.items.length / p.total > best.items.length / best.total) best = p;
    }
    out.push(best.items.shift());
  }
  return out;
}

export function chunk(records, size) {
  const out = [];
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
  return out;
}

async function main() {
  const quick = process.argv.includes('--quick');
  const targets = quick ? { loc: 40, texas: 20, smu: 12 } : { loc: 1000, texas: 350, smu: 150 };
  const log = (msg) => console.error(msg);

  const locFetcher = createFetcher({ minIntervalMs: 3500 }); // LOC hard limit: 20/min
  const fastFetcher = createFetcher({ minIntervalMs: 350 });

  const [loc, texas, smu] = await Promise.all([
    harvestLoc(locFetcher, { target: targets.loc, log }),
    harvestTexas(fastFetcher, { target: targets.texas, log }),
    harvestSmu(createFetcher({ minIntervalMs: 350 }), { target: targets.smu, log }),
  ]);

  const all = dedupeRecords([...loc, ...texas, ...smu]);
  const invalid = all.map((r) => [r, validateRecord(r)]).filter(([, err]) => err);
  for (const [r, err] of invalid) log(`invalid record dropped (${err}): ${r.id}`);
  const valid = all.filter((r) => !validateRecord(r));

  const stream = interleave([shuffle(loc), shuffle(texas), shuffle(smu)].map(
    (list) => list.filter((r) => valid.includes(r)),
  ));

  const chunks = chunk(stream, CHUNK_SIZE);
  await mkdir('data', { recursive: true });
  await Promise.all(chunks.map((c, i) =>
    writeFile(`data/manifest-${String(i).padStart(3, '0')}.json`, JSON.stringify(c)),
  ));
  await writeFile('data/index.json', JSON.stringify({
    generated: new Date().toISOString(),
    total: stream.length,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    sources: {
      'Library of Congress': loc.length,
      'Portal to Texas History': texas.length,
      'SMU DeGolyer Library': smu.length,
    },
  }, null, 2));

  console.error(`\nharvest complete: ${stream.length} records in ${chunks.length} chunks`);
  console.error(`  LOC ${loc.length} / Texas ${texas.length} / SMU ${smu.length}; dropped ${invalid.length} invalid`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add scripts/harvest.mjs tests/harvest.test.mjs
git commit -m "feat: harvest orchestrator with dedupe, validation, interleave, chunking"
```

---

### Task 6: Quick real harvest + image spot-check

**Files:**
- Create: `scripts/check-images.mjs`
- Generate: `data/index.json`, `data/manifest-000.json` (quick harvest output)

**Interfaces:**
- Consumes: `data/index.json` + `data/manifest-*.json` written by Task 5's CLI.
- Produces: committed quick-harvest `data/` so Tasks 7–8 have real data; `npm run check-images` exits 0 when ≥ 90% of sampled imageUrls return HTTP 200 `image/*`.

- [ ] **Step 1: Implement `scripts/check-images.mjs`**

```js
// Samples harvested records and verifies their imageUrls actually serve
// images. Usage: node scripts/check-images.mjs [sampleSize]

import { readFile, readdir } from 'node:fs/promises';

const SAMPLE = Number(process.argv[2]) || 30;

const chunkFiles = (await readdir('data')).filter((f) => f.startsWith('manifest-')).sort();
const records = [];
for (const f of chunkFiles) records.push(...JSON.parse(await readFile(`data/${f}`, 'utf8')));

const sample = [...records].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
let ok = 0;
for (const r of sample) {
  try {
    const res = await fetch(r.imageUrl, {
      headers: { 'user-agent': 'western-explorer-harvest/0.1 (jason.heppler@gmail.com)' },
    });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.startsWith('image/')) ok++;
    else console.error(`BAD ${res.status} ${type} ${r.id} ${r.imageUrl}`);
    await res.body?.cancel();
  } catch (err) {
    console.error(`FAIL ${r.id} ${err.message}`);
  }
  await new Promise((res) => setTimeout(res, 400));
}
console.log(`${ok}/${sample.length} sampled images OK`);
process.exit(ok >= sample.length * 0.9 ? 0 : 1);
```

- [ ] **Step 2: Run the quick harvest**

Run: `npm run harvest:quick`
Expected: per-query `kept` lines on stderr; final summary reporting ~60–72 records across 1 chunk, LOC/Texas/SMU all nonzero. If any source reports 0, stop and debug that module (superpowers:systematic-debugging) before continuing.

- [ ] **Step 3: Spot-check the images**

Run: `npm run check-images`
Expected: `27/30 sampled images OK` or better (≥ 90%), exit 0.

- [ ] **Step 4: Sanity-check the data files**

Run: `jq '{total, chunkCount, sources}' data/index.json && jq 'length, .[0]' data/manifest-000.json`
Expected: totals match the harvest summary; first record is schema-shaped.

- [ ] **Step 5: Commit**

```bash
git add scripts/check-images.mjs data/
git commit -m "feat: image spot-check script + quick-harvest dataset"
```

---

### Task 7: Site — masonry grid with infinite scroll and fade-in

**Files:**
- Create: `index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes: `data/index.json` (`{total, chunkCount, chunkSize, sources}`) and `data/manifest-NNN.json` (arrays of Records) from Task 6.
- Produces: working grid page; `app.js` defines `openLightbox(displayIndex)` as a global hook that Task 8 replaces with a real implementation (Task 7 ships it as a no-op function so tile click handlers can already call it).

- [ ] **Step 1: Write `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Western Explorer</title>
<meta name="description" content="An endless scroll of public-domain photographs of the American West, drawn from the Library of Congress, the Portal to Texas History, and SMU's DeGolyer Library.">
<link rel="stylesheet" href="style.css">
</head>
<body>
<h1 class="site-title">Western&nbsp;Explorer</h1>
<main id="grid" aria-label="Photographs of the American West"></main>
<div id="sentinel" aria-hidden="true"></div>
<div id="lightbox" class="lightbox" hidden></div>
<script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `style.css`**

```css
:root {
  --bg: #16120d;
  --ink: #d8cbb8;
  --ink-dim: #8a7c68;
  --gutter: 10px;
}

* { box-sizing: border-box; }

html { background: var(--bg); }

body {
  margin: 0;
  font: 15px/1.5 Georgia, 'Times New Roman', serif;
  color: var(--ink);
  background: var(--bg);
}

.site-title {
  position: fixed;
  top: 14px;
  left: 18px;
  z-index: 10;
  margin: 0;
  font-size: 15px;
  font-weight: normal;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  padding: 6px 10px;
  border-radius: 3px;
  pointer-events: none;
}

#grid {
  position: relative;
  margin: 0 auto;
  padding-top: var(--gutter);
}

.tile {
  position: absolute;
  overflow: hidden;
  border-radius: 2px;
  background: #221c14; /* placeholder while the image loads */
  cursor: pointer;
  padding: 0;
  border: 0;
}

.tile img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.9s ease;
}

.tile img.loaded { opacity: 1; }

.tile:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

#sentinel { height: 2px; }

.lightbox { /* styled in Task 8 */ }
```

- [ ] **Step 3: Write `app.js`**

```js
// Western Explorer — masonry grid, infinite scroll, lazy fade-in.
// Data: data/index.json + data/manifest-NNN.json (see harvest pipeline).

'use strict';

const GUTTER = 10;
const TARGET_COL_WIDTH = 300; // px; actual width derived from viewport
const MAX_TILES = 9000;       // safety cap on DOM growth from looping

const grid = document.getElementById('grid');
const sentinel = document.getElementById('sentinel');

const state = {
  chunkCount: 0,
  nextChunk: 0,
  displayList: [],   // every record shown, in display order (repeats on loop)
  tiles: [],         // parallel array of tile elements
  columnHeights: [],
  columnCount: 0,
  columnWidth: 0,
  loading: false,
};

// Replaced with a real implementation by the lightbox (Task 8).
// eslint-disable-next-line no-unused-vars
let openLightbox = function (displayIndex) {};

function computeColumns() {
  const width = document.documentElement.clientWidth;
  const count = Math.max(2, Math.round(width / TARGET_COL_WIDTH));
  const columnWidth = (width - GUTTER * (count + 1)) / count;
  return { count, columnWidth };
}

function shortestColumn() {
  let min = 0;
  for (let i = 1; i < state.columnHeights.length; i++) {
    if (state.columnHeights[i] < state.columnHeights[min]) min = i;
  }
  return min;
}

function placeTile(tile, record) {
  const col = shortestColumn();
  const height = Math.round(record.height * (state.columnWidth / record.width));
  tile.style.width = `${Math.floor(state.columnWidth)}px`;
  tile.style.height = `${height}px`;
  tile.style.left = `${GUTTER + col * (state.columnWidth + GUTTER)}px`;
  tile.style.top = `${state.columnHeights[col]}px`;
  state.columnHeights[col] += height + GUTTER;
}

function updateGridHeight() {
  grid.style.height = `${Math.max(...state.columnHeights, 0)}px`;
}

function relayout() {
  const { count, columnWidth } = computeColumns();
  state.columnCount = count;
  state.columnWidth = columnWidth;
  state.columnHeights = new Array(count).fill(GUTTER);
  state.tiles.forEach((tile, i) => {
    if (tile) placeTile(tile, state.displayList[i]);
  });
  updateGridHeight();
}

function addTile(record) {
  const displayIndex = state.displayList.length;
  state.displayList.push(record);

  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.type = 'button';
  tile.setAttribute('aria-label', record.title);

  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = record.title;
  img.src = record.thumbUrl;
  img.addEventListener('load', () => img.classList.add('loaded'));
  img.addEventListener('error', () => {
    // Museums occasionally move derivatives; drop the tile and close the gap.
    state.tiles[displayIndex] = null;
    tile.remove();
    relayout();
  });

  tile.appendChild(img);
  tile.addEventListener('click', () => openLightbox(displayIndex));

  state.tiles.push(tile);
  placeTile(tile, record);
  grid.appendChild(tile);
}

async function loadNextChunk() {
  if (state.loading || !state.chunkCount) return;
  if (state.displayList.length >= MAX_TILES) return;
  state.loading = true;
  try {
    const chunkIndex = state.nextChunk % state.chunkCount; // loop when exhausted
    const res = await fetch(`data/manifest-${String(chunkIndex).padStart(3, '0')}.json`);
    if (!res.ok) throw new Error(`chunk ${chunkIndex}: HTTP ${res.status}`);
    const records = await res.json();
    state.nextChunk++;
    for (const record of records) addTile(record);
    updateGridHeight();
  } catch (err) {
    console.error('chunk load failed:', err);
    state.failedLoads = (state.failedLoads ?? 0) + 1;
    // One quiet retry; after that stop loading and leave the grid as-is.
    if (state.failedLoads > 1) observer.disconnect();
  } finally {
    state.loading = false;
  }
}

const observer = new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) loadNextChunk(); },
  { rootMargin: '1200px' },
);

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(relayout, 150);
});

async function init() {
  const { count, columnWidth } = computeColumns();
  state.columnCount = count;
  state.columnWidth = columnWidth;
  state.columnHeights = new Array(count).fill(GUTTER);

  const res = await fetch('data/index.json');
  const index = await res.json();
  state.chunkCount = index.chunkCount;

  await loadNextChunk();
  observer.observe(sentinel);
}

init();
```

- [ ] **Step 4: Verify in the browser**

Serve the directory (`python3 -m http.server 8080` or the harness's preview tooling) and open `http://localhost:8080`. Check every one of:

1. Dark full-screen masonry grid renders with the quick-harvest images; native aspect ratios; no horizontal scrollbar.
2. Images fade in as they load (throttle network in devtools to see it clearly).
3. Scrolling to the bottom loads more images without a visible hitch, and — since the quick dataset is one chunk — the stream loops seamlessly back through the same images (endless scroll).
4. No layout shift: tiles reserve space before their image arrives (placeholder blocks visible on slow network).
5. Resize the window: grid relayouts to a sensible column count at mobile (~375px), tablet, and desktop widths.
6. Console shows no errors (a dropped 404 tile, if any occurs, closes its gap without breaking layout).

- [ ] **Step 5: Commit**

```bash
git add index.html style.css app.js
git commit -m "feat: masonry grid with infinite scroll and lazy fade-in"
```

---

### Task 8: Site — lightbox

**Files:**
- Modify: `app.js` (replace the `openLightbox` no-op; append lightbox code at the end of the file)
- Modify: `style.css` (replace the empty `.lightbox` rule)
- Modify: `index.html` (fill the `#lightbox` container)

**Interfaces:**
- Consumes: `state.displayList` (records in display order), the `let openLightbox` hook, and the `#lightbox` container from Task 7.
- Produces: full-screen lightbox — click tile → large image + title/date/institution + source link; ←/→ and swipe navigate; Esc or backdrop click closes.

- [ ] **Step 1: Fill the `#lightbox` container in `index.html`**

Replace `<div id="lightbox" class="lightbox" hidden></div>` with:

```html
<div id="lightbox" class="lightbox" hidden role="dialog" aria-modal="true" aria-label="Photograph detail">
  <button class="lb-close" type="button" aria-label="Close">&times;</button>
  <button class="lb-prev" type="button" aria-label="Previous photograph">&#8249;</button>
  <figure class="lb-figure">
    <img class="lb-img" alt="">
    <figcaption class="lb-caption">
      <span class="lb-title"></span>
      <span class="lb-meta"></span>
      <a class="lb-source" target="_blank" rel="noopener">View at source</a>
    </figcaption>
  </figure>
  <button class="lb-next" type="button" aria-label="Next photograph">&#8250;</button>
</div>
```

- [ ] **Step 2: Replace the `.lightbox` placeholder rule in `style.css`**

```css
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 8, 5, 0.94);
}

.lightbox[hidden] { display: none; }

.lb-figure {
  margin: 0;
  max-width: min(92vw, 1400px);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.lb-img {
  max-width: 100%;
  max-height: calc(92vh - 70px);
  object-fit: contain;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
}

.lb-caption {
  text-align: center;
  max-width: 70ch;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.lb-title { font-style: italic; }

.lb-meta { color: var(--ink-dim); font-size: 13px; }

.lb-source {
  color: var(--ink-dim);
  font-size: 13px;
  text-decoration: underline;
}

.lb-source:hover { color: var(--ink); }

.lb-close, .lb-prev, .lb-next {
  position: fixed;
  z-index: 101;
  background: none;
  border: 0;
  color: var(--ink);
  font: 40px/1 Georgia, serif;
  cursor: pointer;
  padding: 12px 18px;
  opacity: 0.7;
}

.lb-close:hover, .lb-prev:hover, .lb-next:hover { opacity: 1; }

.lb-close { top: 8px; right: 12px; }
.lb-prev { left: 6px; top: 50%; transform: translateY(-50%); }
.lb-next { right: 6px; top: 50%; transform: translateY(-50%); }

body.lightbox-open { overflow: hidden; }
```

- [ ] **Step 3: Append lightbox logic to `app.js`**

Append at the end of the file (this reassigns the `let openLightbox` hook from Task 7):

```js
// ---------------------------------------------------------------- lightbox

const lightbox = document.getElementById('lightbox');
const lbImg = lightbox.querySelector('.lb-img');
const lbTitle = lightbox.querySelector('.lb-title');
const lbMeta = lightbox.querySelector('.lb-meta');
const lbSource = lightbox.querySelector('.lb-source');

let lbIndex = -1;

function renderLightbox() {
  const record = state.displayList[lbIndex];
  lbImg.src = record.imageUrl;
  lbImg.alt = record.title;
  lbTitle.textContent = record.title;
  lbMeta.textContent = [record.date, record.creator, record.source].filter(Boolean).join(' · ');
  lbSource.href = record.sourceUrl;
}

function stepLightbox(delta) {
  const n = state.displayList.length;
  lbIndex = (lbIndex + delta + n) % n;
  renderLightbox();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.classList.remove('lightbox-open');
  lbImg.src = '';
  lbIndex = -1;
}

openLightbox = function (displayIndex) {
  if (!state.displayList[displayIndex]) return;
  lbIndex = displayIndex;
  renderLightbox();
  lightbox.hidden = false;
  document.body.classList.add('lightbox-open');
  lightbox.querySelector('.lb-close').focus();
};

lightbox.querySelector('.lb-close').addEventListener('click', closeLightbox);
lightbox.querySelector('.lb-prev').addEventListener('click', () => stepLightbox(-1));
lightbox.querySelector('.lb-next').addEventListener('click', () => stepLightbox(1));
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox(); // backdrop only
});

document.addEventListener('keydown', (e) => {
  if (lightbox.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') stepLightbox(-1);
  else if (e.key === 'ArrowRight') stepLightbox(1);
});

let touchStartX = null;
lightbox.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
lightbox.addEventListener('touchend', (e) => {
  if (touchStartX === null) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) > 60) stepLightbox(dx > 0 ? -1 : 1);
  touchStartX = null;
}, { passive: true });
```

- [ ] **Step 4: Verify in the browser**

Reload `http://localhost:8080`. Check every one of:

1. Clicking any tile opens the lightbox with the larger derivative, title, date · creator · institution, and a working "View at source" link (opens the museum record in a new tab).
2. → and ← keys navigate; navigation wraps at both ends; Esc closes; clicking the dark backdrop closes; clicking the image itself does not close.
3. Page behind does not scroll while the lightbox is open; closing restores scroll position.
4. In devtools device emulation (touch), swiping left/right navigates.
5. No console errors.

- [ ] **Step 5: Commit**

```bash
git add index.html style.css app.js
git commit -m "feat: full-screen lightbox with attribution and keyboard/swipe navigation"
```

---

### Task 9: Full harvest and final verification

**Files:**
- Regenerate: `data/index.json`, `data/manifest-*.json` (full ~1,500-record harvest)
- Create: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the finished PoC dataset + a README documenting harvest/refresh/deploy.

- [ ] **Step 1: Run the full harvest**

Run: `npm run harvest`
Expected: completes in well under 30 minutes (LOC throttling dominates). Summary reports ≥ 1,200 total records with all three sources nonzero (targets: LOC ~1,000 / Texas ~350 / SMU ~150 — shortfalls of ~20% per source are acceptable; a source at 0 is a failure to debug).

- [ ] **Step 2: Validate the dataset**

Run: `npm run check-images -- 50` (or `node scripts/check-images.mjs 50`)
Expected: ≥ 45/50 OK, exit 0.

Run: `jq '{total, chunkCount, sources}' data/index.json`
Expected: totals match the harvest summary; chunkCount ≈ total/100.

- [ ] **Step 3: Full browser pass**

Serve and open the site. Check every one of:

1. Grid shows a varied interleave — Texas and SMU images visibly mixed among LOC, not clustered at the end.
2. Scroll through at least ~500 images: fade-ins keep working, no hitching, memory stays reasonable (devtools performance monitor).
3. Lightbox works on records from all three sources (spot-check one each via the caption's institution name; source links resolve).
4. Mobile width (~375px): grid, scroll, lightbox, and swipe all behave.
5. No console errors during the whole pass.

- [ ] **Step 4: Write `README.md`**

```markdown
# Western Explorer

An endless, full-screen scroll of public-domain photographs of the American
West — homesteading, ranching, frontier life — drawn from the Library of
Congress, the Portal to Texas History, and SMU's DeGolyer Library.

Static site: `index.html` + `style.css` + `app.js` + `data/`. No build step,
no dependencies. Deploy by serving the repository root (GitHub Pages,
Netlify, `python3 -m http.server`).

## Refreshing the data

    npm run harvest        # full harvest (~1,500 records, <30 min)
    npm run harvest:quick  # small harvest for development
    npm run check-images   # spot-check that harvested image URLs still serve

Images are hotlinked from the holding institutions and never rehosted.
Only public-domain / no-known-restrictions items are kept (see
`scripts/lib/rights.mjs`). The harvester throttles to each institution's
published limits — do not lower the LOC interval below 3.5 s.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-23-western-explorer-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-western-explorer.md`
```

- [ ] **Step 5: Run the whole test suite one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add data/ README.md
git commit -m "feat: full ~1,500-image harvest + README"
```
