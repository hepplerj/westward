import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRecords, validateRecord, interleave, chunk, countBySource, staleChunkFiles } from '../scripts/harvest.mjs';

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

test('countBySource counts records by source field', () => {
  const a = rec('loc:1', { source: 'Library of Congress' });
  const b = rec('loc:2', { source: 'Library of Congress' });
  const c = rec('tx:1', { source: 'Portal to Texas History' });
  const d = rec('smu:1', { source: 'SMU DeGolyer Library' });
  const counts = countBySource([a, b, c, d]);
  assert.deepEqual(counts, {
    'Library of Congress': 2,
    'Portal to Texas History': 1,
    'SMU DeGolyer Library': 1,
  });
});

test('countBySource returns empty object for empty array', () => {
  assert.deepEqual(countBySource([]), {});
});

test('staleChunkFiles finds manifest chunks at or beyond keepCount, ignoring non-chunk files', () => {
  const names = ['manifest-000.json', 'manifest-001.json', 'index.json', 'notes.txt'];
  assert.deepEqual(staleChunkFiles(names, 1), ['manifest-001.json']);
  assert.deepEqual(staleChunkFiles(names, 2), []);
});

test('staleChunkFiles matches only the strict manifest-NNN.json pattern', () => {
  const names = ['manifest-000.json', 'manifest-010.json', 'manifest-abc.json', 'manifest-01.json', 'manifest-0001.json'];
  assert.deepEqual(staleChunkFiles(names, 0), ['manifest-000.json', 'manifest-010.json']);
});
