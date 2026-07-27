import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  dplaRightsOpen,
  docPassesRights,
  buildRecord,
  parseSearchDocs,
  harvestDpla,
  createThrottledRawFetch,
} from '../scripts/sources/dpla.mjs';

const search = JSON.parse(readFileSync(new URL('./fixtures/dpla-search.json', import.meta.url), 'utf8'));

// --- rights classifier: pinned cases from the task brief -------------------

test('dplaRightsOpen: CC0/PDM URI is kept', () => {
  assert.equal(dplaRightsOpen(['http://creativecommons.org/publicdomain/zero/1.0/'], '2005'), true);
  assert.equal(dplaRightsOpen(['https://creativecommons.org/publicdomain/mark/1.0/'], null), true);
});

test('dplaRightsOpen: NoC-US URI is kept', () => {
  assert.equal(dplaRightsOpen(['http://rightsstatements.org/vocab/NoC-US/1.0/'], null), true);
});

test('dplaRightsOpen: InC URI is dropped', () => {
  assert.equal(dplaRightsOpen(['http://rightsstatements.org/vocab/InC/1.0/'], '1880'), false);
});

test('dplaRightsOpen: NoC-NC URI is dropped', () => {
  assert.equal(dplaRightsOpen(['http://rightsstatements.org/vocab/NoC-NC/1.0/'], null), false);
});

test('dplaRightsOpen: no rights values at all + pre-1931 date is kept (date fallback)', () => {
  assert.equal(dplaRightsOpen([], '1890'), true);
  assert.equal(dplaRightsOpen([null, ''], '1890'), true);
});

test('dplaRightsOpen: no rights values at all + post-1930 date is dropped', () => {
  assert.equal(dplaRightsOpen([], '1950'), false);
});

test('dplaRightsOpen: open free text alongside a restrictive URI is dropped (veto wins)', () => {
  assert.equal(dplaRightsOpen(['Public domain.', 'http://rightsstatements.org/vocab/InC/1.0/'], '2000'), false);
});

test('dplaRightsOpen: live-observed CNE and UND rightsstatements.org values are dropped (ambiguous, not one of the two open forms)', () => {
  assert.equal(dplaRightsOpen(['http://rightsstatements.org/vocab/CNE/1.0/'], null), false);
  assert.equal(dplaRightsOpen(['http://rightsstatements.org/vocab/UND/1.0/'], '1900'), false);
});

test('dplaRightsOpen: a non-public-domain Creative Commons license (e.g. BY-NC) is dropped', () => {
  assert.equal(dplaRightsOpen(['http://creativecommons.org/licenses/by-nc/4.0/'], null), false);
});

test('dplaRightsOpen: open free text alone (no URI) is kept', () => {
  assert.equal(dplaRightsOpen(['No known restrictions on use.'], '1999'), true);
});

test('dplaRightsOpen: restrictive free text alone is dropped', () => {
  assert.equal(dplaRightsOpen(['All rights reserved.'], '1880'), false);
});

test('dplaRightsOpen: values are gathered from both top-level and sourceResource.rights (array-shaped)', () => {
  assert.equal(dplaRightsOpen([['http://rightsstatements.org/vocab/NoC-US/1.0/'], ['No known restrictions.']], null), true);
  assert.equal(dplaRightsOpen([['http://rightsstatements.org/vocab/NoC-US/1.0/'], ['Restricted.']], null), false);
});

// --- parseSearchDocs ---------------------------------------------------------

test('parseSearchDocs returns the docs array from a live search response', () => {
  const docs = parseSearchDocs(search);
  assert.ok(docs.length > 0);
  assert.ok(docs.every((d) => typeof d.id === 'string'));
});

test('parseSearchDocs tolerates a missing docs array', () => {
  assert.deepEqual(parseSearchDocs({}), []);
  assert.deepEqual(parseSearchDocs(null), []);
});

// --- docPassesRights / buildRecord against the live fixture ----------------

test('the live fixture contains both open (NoC-US) and restrictive (InC/CNE/UND) docs', () => {
  const docs = parseSearchDocs(search);
  assert.ok(docs.some((d) => docPassesRights(d)), 'expected at least one open doc in the fixture');
  assert.ok(docs.some((d) => !docPassesRights(d)), 'expected at least one restrictive doc in the fixture');
});

test('buildRecord builds a schema-valid record from a live open doc + synthetic dims', () => {
  const docs = parseSearchDocs(search);
  const openDoc = docs.find((d) => docPassesRights(d) && d.object && d.isShownAt);
  assert.ok(openDoc, 'fixture must contain at least one open, probeable doc');
  const r = buildRecord(openDoc, { width: 800, height: 600 });
  assert.ok(r);
  assert.equal(r.id, `dpla:${openDoc.id}`);
  assert.equal(r.imageUrl, openDoc.object);
  assert.equal(r.thumbUrl, openDoc.object);
  assert.equal(r.sourceUrl, openDoc.isShownAt);
  assert.equal(r.width, 800);
  assert.equal(r.height, 600);
  assert.ok(r.title.length > 0);
  assert.ok(r.source.length > 0);
  assert.ok(Array.isArray(r.subjects));
});

test('buildRecord drops a restrictive-rights doc even with valid dims', () => {
  const docs = parseSearchDocs(search);
  const closedDoc = docs.find((d) => !docPassesRights(d) && d.object && d.isShownAt);
  assert.ok(closedDoc, 'fixture must contain a restrictive doc to exercise this path');
  assert.equal(buildRecord(closedDoc, { width: 800, height: 600 }), null);
});

test('buildRecord drops when dims are null (probe failed / dead link)', () => {
  const docs = parseSearchDocs(search);
  const openDoc = docs.find((d) => docPassesRights(d) && d.object);
  assert.equal(buildRecord(openDoc, null), null);
});

test('buildRecord drops when the longest side is under 300px', () => {
  const docs = parseSearchDocs(search);
  const openDoc = docs.find((d) => docPassesRights(d) && d.object && d.isShownAt);
  assert.equal(buildRecord(openDoc, { width: 200, height: 150 }), null);
  assert.ok(buildRecord(openDoc, { width: 299, height: 299 }) === null);
  assert.ok(buildRecord(openDoc, { width: 200, height: 300 }) !== null); // longest side exactly 300 is kept
});

test('buildRecord drops a doc missing dataProvider', () => {
  const r = buildRecord({
    id: 'x1',
    isShownAt: 'https://example.org/item/1',
    object: 'https://example.org/thumb/1.jpg',
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: { title: ['A title'] },
  }, { width: 500, height: 400 });
  assert.equal(r, null);
});

test('buildRecord handles dataProvider as a bare string (defensive, per brief)', () => {
  const r = buildRecord({
    id: 'x2',
    isShownAt: 'https://example.org/item/2',
    object: 'https://example.org/thumb/2.jpg',
    dataProvider: 'Some Library',
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: { title: ['A title'], creator: ['Somebody'], date: [{ displayDate: '1900' }], subject: [{ name: 'Ranching' }, 'Cattle'] },
  }, { width: 500, height: 400 });
  assert.ok(r);
  assert.equal(r.source, 'Some Library');
  assert.equal(r.creator, 'Somebody');
  assert.equal(r.date, '1900');
  assert.deepEqual(r.subjects, ['Ranching', 'Cattle']);
});

test('buildRecord falls back to a begin-end date range when displayDate is absent', () => {
  const r = buildRecord({
    id: 'x3',
    isShownAt: 'https://example.org/item/3',
    object: 'https://example.org/thumb/3.jpg',
    dataProvider: { name: 'Some Library' },
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: { title: ['A title'], date: [{ begin: '1880', end: '1900' }] },
  }, { width: 500, height: 400 });
  assert.equal(r.date, '1880-1900');
});

test('buildRecord returns null when title is missing', () => {
  const r = buildRecord({
    id: 'x4',
    isShownAt: 'https://example.org/item/4',
    object: 'https://example.org/thumb/4.jpg',
    dataProvider: { name: 'Some Library' },
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: {},
  }, { width: 500, height: 400 });
  assert.equal(r, null);
});

// --- harvestDpla orchestration (mocked fetcher + probe) ---------------------

function fakeFetcher(pages) {
  let call = 0;
  return {
    fetchJson: async (url) => {
      const page = pages[call] ?? { docs: [] };
      call += 1;
      return typeof page === 'function' ? page(url) : page;
    },
  };
}

test('harvestDpla throws a clear error when no API key is configured', async () => {
  await assert.rejects(
    () => harvestDpla(fakeFetcher([]), { apiKey: '', probeFetchImpl: async () => ({ ok: false }) }),
    /DPLA_API_KEY/,
  );
});

test('harvestDpla builds kept records and stops at target, skipping restrictive/no-object docs without probing them', async () => {
  const openDoc = {
    id: 'aaa',
    isShownAt: 'https://example.org/item/aaa',
    object: 'https://example.org/thumb/aaa.jpg',
    dataProvider: { name: 'Denver Public Library' },
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: { title: ['Open Item'] },
  };
  const closedDoc = {
    id: 'bbb',
    isShownAt: 'https://example.org/item/bbb',
    object: 'https://example.org/thumb/bbb.jpg',
    dataProvider: { name: 'Denver Public Library' },
    rights: 'http://rightsstatements.org/vocab/InC/1.0/',
    sourceResource: { title: ['Closed Item'] },
  };
  const noObjectDoc = {
    id: 'ccc',
    isShownAt: 'https://example.org/item/ccc',
    dataProvider: { name: 'Denver Public Library' },
    rights: 'http://rightsstatements.org/vocab/NoC-US/1.0/',
    sourceResource: { title: ['No Object Item'] },
  };

  const probedUrls = [];
  const probeFetchImpl = async (url) => { probedUrls.push(url); return { url }; };

  // Every page call returns the same three docs, then empty (loop termination).
  let page = 0;
  const fetcher = {
    fetchJson: async () => {
      page += 1;
      return page === 1 ? { docs: [openDoc, closedDoc, noObjectDoc] } : { docs: [] };
    },
  };

  // Stub probeImageSize's underlying network call indirectly by monkeypatching
  // is not available (ESM), so instead we rely on harvestDpla's real
  // probeImageSize + our probeFetchImpl stub, whose response has no `.body`,
  // making probeImageSize itself return null. This still lets us assert the
  // key behavior: only the open, has-object doc is ever probed at all.
  const records = await harvestDpla(fetcher, {
    target: 300,
    apiKey: 'fake-key-not-real',
    log: () => {},
    probeFetchImpl,
  });

  assert.equal(records.length, 0); // probe returns null (no body) for every doc, so nothing is kept
  assert.equal(probedUrls.length, 1); // only the open, has-object doc should ever be probed
  assert.equal(probedUrls[0], 'https://example.org/thumb/aaa.jpg');
});

test('harvestDpla never logs the api_key when a search request fails', async () => {
  const logs = [];
  const fetcher = {
    fetchJson: async (url) => {
      throw new Error(`HTTP 500 for ${url}`);
    },
  };
  await harvestDpla(fetcher, {
    target: 10,
    apiKey: 'TOTALLY-SECRET-VALUE',
    log: (msg) => logs.push(msg),
    probeFetchImpl: async () => ({ ok: false }),
  });
  const joined = logs.join('\n');
  assert.ok(!joined.includes('TOTALLY-SECRET-VALUE'), `log output leaked the api key: ${joined}`);
  assert.ok(joined.includes('REDACTED') || joined.includes('failed'), 'expected a redacted failure log');
});

test('createThrottledRawFetch enforces the minimum interval between calls', async () => {
  const calls = [];
  const raw = createThrottledRawFetch(50, async (url) => { calls.push(Date.now()); return { ok: true, url }; });
  await raw('a');
  await raw('b');
  assert.ok(calls[1] - calls[0] >= 45, `expected >=~50ms gap, got ${calls[1] - calls[0]}`);
});
