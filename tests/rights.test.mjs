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
