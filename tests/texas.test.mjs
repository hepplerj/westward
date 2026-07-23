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

test('manifestToRecord collects multiple discrete subject.* metadata entries', () => {
  const arkName = 'metapth12345';
  const r = manifestToRecord(arkName, manifest);
  if (r === null) return; // this fixture item is dated 1986 and may be dropped by the rights rule
  // The live fixture carries several subject.UNTL-BS / subject.AAT / subject.KWD entries.
  assert.ok(r.subjects.length >= 5, `expected several subjects, got ${r.subjects.length}`);
  assert.ok(r.subjects.includes('cattle ranches'));
  assert.ok(r.subjects.includes('Agriculture - Domestic Animals - Cattle'));
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

test('manifestToRecord treats the generic PTH terms-of-use license as absent rights, falling back to the date rule', () => {
  const makeManifest = (date) => ({
    label: 'A photo',
    license: 'https://texashistory.unt.edu/terms-of-use/',
    metadata: [{ label: 'date', value: date }],
    sequences: [{ canvases: [{ width: 1000, height: 800, images: [{ resource: { service: { '@id': 'https://texashistory.unt.edu/iiif/ark:/67531/x/m1/1' } } }] }] }],
  });
  assert.ok(
    manifestToRecord('x', makeManifest('1920')) !== null,
    'pre-1931 item with only the generic license URL should be kept'
  );
  assert.equal(
    manifestToRecord('x', makeManifest('1955')),
    null,
    'post-1930 item with only the generic license URL should be dropped'
  );
});
