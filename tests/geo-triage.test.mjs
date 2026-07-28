import test from 'node:test';
import assert from 'node:assert/strict';
import { nonWesternMatch, geoTriage, triageSummary } from '../scripts/lib/geo-triage.mjs';

const rec = (title, subjects = []) => ({
  id: 'loc:x', title, date: '1900', creator: null,
  source: 'Library of Congress', sourceUrl: 'https://www.loc.gov/item/x/',
  imageUrl: 'https://img/x.jpg', thumbUrl: 'https://img/x-t.jpg',
  width: 800, height: 600, subjects,
});

test('drops the Homestead, Pennsylvania steel town', () => {
  assert.equal(nonWesternMatch(rec('Homestead, Pennsylvania. Steel workers leaving the mill')), 'Pennsylvania');
});

test('matches non-western states in LCSH-style subjects', () => {
  assert.equal(nonWesternMatch(rec('Farm scene', ['Homesteading--New York--1900'])), 'New York');
});

test('West Virginia matches as West Virginia, not Virginia', () => {
  assert.equal(nonWesternMatch(rec('Coal camp, West Virginia')), 'West Virginia');
});

test('bare Washington is western; the capital forms are not', () => {
  assert.equal(nonWesternMatch(rec('Wheat harvest near Spokane, Washington')), null);
  assert.equal(nonWesternMatch(rec('Cattle show, Washington, D.C.')), 'Washington, D.C.');
  assert.equal(nonWesternMatch(rec('Parade, Washington DC')), 'Washington, D.C.');
});

test('western and location-less records pass', () => {
  assert.equal(nonWesternMatch(rec('Sod house, Custer County, Nebraska')), null);
  assert.equal(nonWesternMatch(rec('Cattle ranch', ['Ranching', 'Cattle'])), null);
});

test('substrings of state names do not false-match', () => {
  assert.equal(nonWesternMatch(rec('Indiana Jones Ranch')), 'Indiana'); // word boundary: legit match
  assert.equal(nonWesternMatch(rec('Indian camp on the plains')), null); // "Indian" is not "Indiana"
  assert.equal(nonWesternMatch(rec('New Mexico homestead')), null);      // not "Mexico, ME"… stays
});

test('gray-zone states are kept', () => {
  assert.equal(nonWesternMatch(rec('Corn field, Iowa')), null);
  assert.equal(nonWesternMatch(rec('Ozark farm, Missouri')), null);
});

test('geoTriage splits and triageSummary counts by place', () => {
  const records = [
    rec('Sod house, Nebraska'),
    rec('Homestead, Pennsylvania'),
    rec('Mill town', ['Textile mills--Massachusetts']),
    rec('Another mill', ['Homesteading--Pennsylvania']),
  ];
  const { kept, dropped } = geoTriage(records);
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 3);
  assert.equal(triageSummary(dropped), 'geo-triage: dropped 3 (Pennsylvania 2, Massachusetts 1)');
});

test('empty input yields empty output and a quiet summary', () => {
  const { kept, dropped } = geoTriage([]);
  assert.deepEqual(kept, []);
  assert.equal(triageSummary(dropped), 'geo-triage: dropped 0');
});
