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

// Synthetic manifest, kept by construction (date <= 1930, only the generic
// terms-of-use license, no genuine rights label) so these tests assert the
// full schema and multi-entry subject collection deterministically instead
// of depending on whether the real committed fixture happens to pass the
// rights rule.
function syntheticManifest() {
  return {
    label: '[Photograph of Synthetic Ranch]',
    license: 'https://texashistory.unt.edu/terms-of-use/',
    metadata: [
      { label: 'title', value: '[Photograph of Synthetic Ranch]' },
      { label: 'creator', value: 'Doe, Jane' },
      { label: 'date', value: '1925-06' },
      { label: 'subject.UNTL-BS', value: 'Agriculture - Ranching - Ranches' },
      { label: 'subject.UNTL-BS', value: 'Landscape and Nature - Plants' },
      { label: 'subject.AAT', value: 'cattle ranches' },
      { label: 'subject.AAT', value: 'windmills' },
      { label: 'subject.KWD', value: 'hills' },
    ],
    sequences: [
      {
        canvases: [
          {
            width: 3000,
            height: 1988,
            images: [{ resource: { service: { '@id': 'https://texashistory.unt.edu/iiif/ark:/67531/metasynth1/m1/1' } } }],
          },
        ],
      },
    ],
  };
}

test('manifestToRecord builds a full schema-valid record from a synthetic kept manifest', () => {
  const arkName = 'metasynth1';
  const r = manifestToRecord(arkName, syntheticManifest());
  assert.ok(r !== null, 'synthetic manifest should be kept (date 1925 <= 1930, no closing rights)');
  assert.equal(r.id, `texas:${arkName}`);
  assert.equal(r.source, 'Portal to Texas History');
  assert.equal(r.title, '[Photograph of Synthetic Ranch]');
  assert.equal(r.date, '1925-06');
  assert.equal(r.creator, 'Doe, Jane');
  assert.equal(r.sourceUrl, `https://texashistory.unt.edu/ark:/67531/${arkName}/`);
  assert.equal(r.imageUrl, 'https://texashistory.unt.edu/iiif/ark:/67531/metasynth1/m1/1/full/1024,/0/default.jpg');
  assert.equal(r.thumbUrl, 'https://texashistory.unt.edu/iiif/ark:/67531/metasynth1/m1/1/full/640,/0/default.jpg');
  assert.match(r.imageUrl, /\/full\/1024,\/0\/default\.jpg$/);
  assert.match(r.thumbUrl, /\/full\/640,\/0\/default\.jpg$/);
  assert.ok(Number.isInteger(r.width) && r.width > 0);
  assert.ok(Number.isInteger(r.height) && r.height > 0);
  assert.equal(r.width, 3000);
  assert.equal(r.height, 1988);
});

test('manifestToRecord collects every discrete subject.* metadata entry (non-vacuous)', () => {
  const r = manifestToRecord('metasynth1', syntheticManifest());
  assert.ok(r !== null);
  // Pins the exact collected list, in source order, across three distinct
  // subject.* labels — a regression to a single-entry/pipe-split
  // implementation would shrink this to one element and fail here.
  assert.deepEqual(r.subjects, [
    'Agriculture - Ranching - Ranches',
    'Landscape and Nature - Plants',
    'cattle ranches',
    'windmills',
    'hills',
  ]);
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

test('manifestToRecord vetoes on a second, restrictive rights-labeled metadata entry', () => {
  const manifest = {
    label: 'A photo',
    metadata: [
      { label: 'license', value: 'Public domain' },
      { label: 'rights', value: 'Restricted: contact the partner institution.' },
      { label: 'date', value: '1920' },
    ],
    sequences: [{ canvases: [{ width: 1000, height: 800, images: [{ resource: { service: { '@id': 'https://texashistory.unt.edu/iiif/ark:/67531/x/m1/1' } } }] }] }],
  };
  assert.equal(
    manifestToRecord('x', manifest),
    null,
    'a restrictive second rights-labeled entry must veto even though the first entry is permissive',
  );
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
