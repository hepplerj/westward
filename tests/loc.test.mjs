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
