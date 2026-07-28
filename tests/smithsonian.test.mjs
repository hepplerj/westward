import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sourceOf,
  parseSearchRows,
  sourceUrlOf,
  dateOf,
  creatorOf,
  subjectsOf,
  selectedMedia,
  mediaPassesCC0,
  highResDims,
  recordPassesRights,
  buildRecord,
  harvestSmithsonian,
  createThrottledRawFetch,
} from '../scripts/sources/smithsonian.mjs';

const search = JSON.parse(readFileSync(new URL('./fixtures/smithsonian-search.json', import.meta.url), 'utf8'));

// --- sourceOf: unitCode -> human name -------------------------------------

test('sourceOf maps known unit codes to human names', () => {
  assert.equal(sourceOf('SAAM'), 'Smithsonian American Art Museum');
  assert.equal(sourceOf('NPG'), 'National Portrait Gallery');
  assert.equal(sourceOf('NMAH'), 'National Museum of American History');
  assert.equal(sourceOf('CHNDM'), 'Cooper Hewitt, Smithsonian Design Museum');
  assert.equal(sourceOf('SIA'), 'Smithsonian Institution Archives');
});

test('sourceOf falls back to "Smithsonian Institution" for unmapped unit codes', () => {
  // NMAAHC is seen live in western-themed CC0 results but is not in the
  // brief's small named map; it must fall back cleanly rather than error.
  assert.equal(sourceOf('NMAAHC'), 'Smithsonian Institution');
  assert.equal(sourceOf('WHATEVER'), 'Smithsonian Institution');
  assert.equal(sourceOf(undefined), 'Smithsonian Institution');
});

// --- parseSearchRows -------------------------------------------------------

test('parseSearchRows returns the rows array from a live search response', () => {
  const rows = parseSearchRows(search);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => typeof r.id === 'string'));
});

test('parseSearchRows tolerates a missing rows array', () => {
  assert.deepEqual(parseSearchRows({}), []);
  assert.deepEqual(parseSearchRows(null), []);
  assert.deepEqual(parseSearchRows({ response: {} }), []);
});

// --- sourceUrlOf: record_link preferred, guid fallback ---------------------

test('sourceUrlOf prefers record_link when present', () => {
  const dnr = { record_link: 'https://americanart.si.edu/x', guid: 'https://n2t.net/ark:/1' };
  assert.equal(sourceUrlOf(dnr), 'https://americanart.si.edu/x');
});

test('sourceUrlOf falls back to guid when record_link is absent', () => {
  // DEVIATION: live guids are not always https (some are bare http://,
  // e.g. several CHNDM rows in the fixture) even though the brief expected
  // https. Accept either scheme, matching harvest.mjs's own /^https?:\/\//
  // validation, rather than rejecting valid live records.
  const dnr = { guid: 'http://n2t.net/ark:/65665/kq4bbbcd9c6-53ba-4e70-b196-d8a1cb069de0' };
  assert.equal(sourceUrlOf(dnr), 'http://n2t.net/ark:/65665/kq4bbbcd9c6-53ba-4e70-b196-d8a1cb069de0');
});

test('sourceUrlOf returns null when neither field is a valid http(s) URL', () => {
  assert.equal(sourceUrlOf({}), null);
  assert.equal(sourceUrlOf({ record_link: 'not-a-url', guid: '' }), null);
});

test('the live fixture contains at least one record_link-only and one guid-only row', () => {
  const rows = parseSearchRows(search);
  assert.ok(rows.some((r) => r.content?.descriptiveNonRepeating?.record_link), 'expected a record_link row');
  assert.ok(rows.some((r) => !r.content?.descriptiveNonRepeating?.record_link && r.content?.descriptiveNonRepeating?.guid), 'expected a guid-only row');
});

// --- dateOf / creatorOf / subjectsOf ---------------------------------------

test('dateOf reads the first freetext date label content', () => {
  assert.equal(dateOf({ content: { freetext: { date: [{ label: 'date made', content: 'ca.1940' }] } } }), 'ca.1940');
});

test('dateOf falls back to the first indexedStructured decade bucket', () => {
  assert.equal(dateOf({ content: { indexedStructured: { date: ['1910s', '1890s'] } } }), '1910s');
});

test('dateOf returns null when neither is present', () => {
  assert.equal(dateOf({ content: {} }), null);
  assert.equal(dateOf({}), null);
});

test('creatorOf reads the first freetext name entry regardless of its label', () => {
  assert.equal(creatorOf({ content: { freetext: { name: [{ label: 'Founder', content: 'Gorham Manufacturing Company' }] } } }), 'Gorham Manufacturing Company');
});

test('creatorOf returns null when freetext.name is absent', () => {
  assert.equal(creatorOf({ content: {} }), null);
});

test('subjectsOf reads indexedStructured.topic, capped at 12', () => {
  const topics = Array.from({ length: 20 }, (_, i) => `Topic ${i}`);
  const subjects = subjectsOf({ content: { indexedStructured: { topic: topics } } });
  assert.equal(subjects.length, 12);
  assert.deepEqual(subjects, topics.slice(0, 12));
});

test('subjectsOf returns [] when indexedStructured.topic is absent', () => {
  assert.deepEqual(subjectsOf({ content: {} }), []);
});

// --- selectedMedia / mediaPassesCC0 / highResDims ---------------------------

test('selectedMedia returns the first media entry, or null when online_media is absent/null', () => {
  const withMedia = { content: { descriptiveNonRepeating: { online_media: { media: [{ idsId: 'x' }] } } } };
  assert.equal(selectedMedia(withMedia).idsId, 'x');
  assert.equal(selectedMedia({ content: { descriptiveNonRepeating: { online_media: null } } }), null);
  assert.equal(selectedMedia({ content: { descriptiveNonRepeating: {} } }), null);
  assert.equal(selectedMedia({ content: {} }), null);
});

test('mediaPassesCC0 checks usage.access === "CC0" defensively', () => {
  assert.equal(mediaPassesCC0({ usage: { access: 'CC0' } }), true);
  assert.equal(mediaPassesCC0({ usage: { access: 'CC0-but-not-quite' } }), false);
  assert.equal(mediaPassesCC0({ usage: {} }), false);
  assert.equal(mediaPassesCC0(null), false);
});

test('highResDims reads width/height off the "High-resolution JPEG" resource, scaled to the 1024 derivative', () => {
  const media = { resources: [{ label: 'High-resolution TIFF', width: 5121, height: 4097 }, { label: 'High-resolution JPEG', width: 5121, height: 4097 }] };
  const dims = highResDims(media);
  assert.equal(dims.width, 1024);
  assert.equal(dims.height, Math.round(4097 * (1024 / 5121)));
});

test('highResDims returns null when no "High-resolution JPEG" resource is present', () => {
  const media = { resources: [{ label: 'Screen Image', url: 'x' }, { label: 'Thumbnail Image', url: 'y' }] };
  assert.equal(highResDims(media), null);
  assert.equal(highResDims(null), null);
  assert.equal(highResDims({}), null);
});

test('highResDims does not upscale a source narrower than 1024', () => {
  const media = { resources: [{ label: 'High-resolution JPEG', width: 800, height: 600 }] };
  const dims = highResDims(media);
  assert.equal(dims.width, 800);
  assert.equal(dims.height, 600);
});

// --- recordPassesRights (query-level CC0 already applied; this is the
// per-media defense-in-depth check) -----------------------------------------

test('recordPassesRights is true for a live fixture row (query already filtered to media_usage:"CC0")', () => {
  const rows = parseSearchRows(search);
  assert.ok(rows.every((r) => recordPassesRights(r)), 'every fixture row should pass the CC0 media check');
});

test('recordPassesRights is false when online_media is null (defensive per brief)', () => {
  assert.equal(recordPassesRights({ content: { descriptiveNonRepeating: { online_media: null } } }), false);
});

test('recordPassesRights is false when the selected media object lacks CC0 access', () => {
  const row = { content: { descriptiveNonRepeating: { online_media: { media: [{ usage: { access: 'Restricted' } }] } } } };
  assert.equal(recordPassesRights(row), false);
});

// --- buildRecord -------------------------------------------------------

test('buildRecord builds a schema-valid record from a live row with resources[]-provided dims', () => {
  const rows = parseSearchRows(search);
  const row = rows.find((r) => {
    const media = selectedMedia(r);
    return media && highResDims(media) && sourceUrlOf(r.content.descriptiveNonRepeating);
  });
  assert.ok(row, 'fixture must contain a row with High-resolution JPEG dims');
  const media = selectedMedia(row);
  const dims = highResDims(media);
  const r = buildRecord(row, dims);
  assert.ok(r);
  assert.equal(r.id, `si:${row.id}`);
  assert.equal(r.title, row.title);
  assert.equal(r.imageUrl, `https://ids.si.edu/ids/deliveryService?id=${media.idsId}&max=1024`);
  assert.equal(r.thumbUrl, `https://ids.si.edu/ids/deliveryService?id=${media.idsId}&max=640`);
  assert.equal(r.width, dims.width);
  assert.equal(r.height, dims.height);
  assert.ok(r.source.length > 0);
  assert.ok(Array.isArray(r.subjects));
});

test('buildRecord drops when dims are null (probe failed / dead link)', () => {
  const rows = parseSearchRows(search);
  const row = rows[0];
  assert.equal(buildRecord(row, null), null);
});

test('buildRecord drops when the longest side is under 300px', () => {
  const rows = parseSearchRows(search);
  const row = rows[0];
  assert.equal(buildRecord(row, { width: 200, height: 150 }), null);
  assert.ok(buildRecord(row, { width: 299, height: 299 }) === null);
  assert.ok(buildRecord(row, { width: 200, height: 300 }) !== null); // longest side exactly 300 is kept
});

test('buildRecord drops a record whose selected media lacks CC0 access even with valid dims', () => {
  const row = {
    id: 'x1',
    title: 'A restricted item',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/1',
        online_media: { media: [{ idsId: 'abc', usage: { access: 'Restricted' } }] },
      },
    },
  };
  assert.equal(buildRecord(row, { width: 800, height: 600 }), null);
});

test('buildRecord drops a record missing a title', () => {
  const row = {
    id: 'x2',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/2',
        online_media: { media: [{ idsId: 'abc', usage: { access: 'CC0' } }] },
      },
    },
  };
  assert.equal(buildRecord(row, { width: 800, height: 600 }), null);
});

test('buildRecord drops a record with no usable sourceUrl (no record_link, no valid guid)', () => {
  const row = {
    id: 'x3',
    title: 'No source URL',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        online_media: { media: [{ idsId: 'abc', usage: { access: 'CC0' } }] },
      },
    },
  };
  assert.equal(buildRecord(row, { width: 800, height: 600 }), null);
});

test('buildRecord fills in date, creator, subjects, and source from a synthetic row', () => {
  const row = {
    id: 'x4',
    title: 'A Cowboy Portrait',
    unitCode: 'NPG',
    content: {
      freetext: {
        date: [{ label: 'Date', content: '1902' }],
        name: [{ label: 'Photographer', content: 'C.M. Bell' }],
      },
      indexedStructured: { topic: ['Cowboys', 'Portraits'] },
      descriptiveNonRepeating: {
        record_link: 'https://npg.si.edu/x4',
        online_media: { media: [{ idsId: 'npg-x4', usage: { access: 'CC0' } }] },
      },
    },
  };
  const r = buildRecord(row, { width: 800, height: 600 });
  assert.ok(r);
  assert.equal(r.date, '1902');
  assert.equal(r.creator, 'C.M. Bell');
  assert.deepEqual(r.subjects, ['Cowboys', 'Portraits']);
  assert.equal(r.source, 'National Portrait Gallery');
});

// --- harvestSmithsonian orchestration (mocked fetcher + probe) --------------

function fakeFetcher(pages) {
  let call = 0;
  return {
    fetchJson: async (url) => {
      const page = pages[call] ?? { response: { rows: [] } };
      call += 1;
      return typeof page === 'function' ? page(url) : page;
    },
  };
}

test('harvestSmithsonian throws a clear error when no API key is configured', async () => {
  await assert.rejects(
    () => harvestSmithsonian(fakeFetcher([]), { apiKey: '', probeFetchImpl: async () => ({ ok: false }) }),
    /SMITHSONIAN_API_KEY/,
  );
});

test('harvestSmithsonian builds kept records and skips restrictive/no-media rows without probing them', async () => {
  const openRowWithDims = {
    id: 'aaa',
    title: 'Open Item With Resources',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/aaa',
        online_media: {
          media: [{
            idsId: 'aaa-ids',
            usage: { access: 'CC0' },
            resources: [{ label: 'High-resolution JPEG', width: 2000, height: 1000 }],
          }],
        },
      },
    },
  };
  const closedRow = {
    id: 'bbb',
    title: 'Closed Item',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/bbb',
        online_media: { media: [{ idsId: 'bbb-ids', usage: { access: 'Restricted' } }] },
      },
    },
  };
  const nullMediaRow = {
    id: 'ccc',
    title: 'No Media Item',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/ccc',
        online_media: null,
      },
    },
  };

  const probedUrls = [];
  const probeFetchImpl = async (url) => { probedUrls.push(url); return { ok: false }; };

  let page = 0;
  const fetcher = {
    fetchJson: async () => {
      page += 1;
      return page === 1
        ? { response: { rowCount: 3, rows: [openRowWithDims, closedRow, nullMediaRow] } }
        : { response: { rowCount: 3, rows: [] } };
    },
  };

  const records = await harvestSmithsonian(fetcher, {
    target: 300,
    apiKey: 'fake-key-not-real',
    log: () => {},
    probeFetchImpl,
  });

  assert.equal(records.length, 1); // only the open row (which has resources[] dims, no probe needed) is kept
  assert.equal(records[0].id, 'si:aaa');
  assert.equal(probedUrls.length, 0); // resources[] supplied dims, so no probe was needed for the kept row; the other two never reach the probe step
});

test('harvestSmithsonian probes when resources[] dims are absent', async () => {
  const rowNeedingProbe = {
    id: 'ddd',
    title: 'Needs Probe',
    unitCode: 'SAAM',
    content: {
      descriptiveNonRepeating: {
        record_link: 'https://example.org/item/ddd',
        online_media: { media: [{ idsId: 'ddd-ids', usage: { access: 'CC0' } }] }, // no resources[] at all
      },
    },
  };
  const probedUrls = [];
  const probeFetchImpl = async (url) => {
    probedUrls.push(url);
    return { ok: true, body: 'has-body' }; // shape unused directly; imageSizeFromBuffer/probeImageSize handles real parsing
  };

  let page = 0;
  const fetcher = {
    fetchJson: async () => {
      page += 1;
      return page === 1 ? { response: { rowCount: 1, rows: [rowNeedingProbe] } } : { response: { rowCount: 1, rows: [] } };
    },
  };

  const records = await harvestSmithsonian(fetcher, {
    target: 300,
    apiKey: 'fake-key-not-real',
    log: () => {},
    probeFetchImpl,
  });

  assert.equal(records.length, 0); // probe stub has no real .body reader, so probeImageSize returns null and the record is dropped
  assert.equal(probedUrls.length, 1);
  assert.equal(probedUrls[0], 'https://ids.si.edu/ids/deliveryService?id=ddd-ids&max=1024');
});

test('harvestSmithsonian never logs the api_key when a search request fails', async () => {
  const logs = [];
  const fetcher = {
    fetchJson: async (url) => {
      throw new Error(`HTTP 500 for ${url}`);
    },
  };
  await harvestSmithsonian(fetcher, {
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
