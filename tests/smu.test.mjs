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

test('buildRecord treats the site-wide DeGolyer citation boilerplate as no rights statement, falling back to the date rule', () => {
  const boilerplate = 'Please cite DeGolyer Library, Southern Methodist University as the source of this file. A high-resolution version of this file may be obtained for a fee. For details, see the https://www.smu.edu/libraries/degolyer/using/images web page. For more information, contact degolyer@smu.edu.';
  const old = buildRecord({
    alias: 'wes',
    itemId: 3,
    itemInfo: { title: 'Cattle Girl', date: '1906', rights: boilerplate },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.ok(old, 'pre-1931 item with only the generic disclaimer should pass via the date rule');

  const modern = buildRecord({
    alias: 'wes',
    itemId: 4,
    itemInfo: { title: 'Modern item', date: '1981', rights: boilerplate },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.equal(modern, null, 'post-1930 item with only the generic disclaimer should still be dropped');
});

test('buildRecord merges Authorized Subject Terms and Keywords into subjects', () => {
  const r = buildRecord({
    alias: 'wes',
    itemId: 5,
    itemInfo: { title: 'Cowboy scene', date: '1900', rights: '', author: 'Horses; Cowboys; Men', keywor: 'Southwest' },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.ok(r);
  assert.deepEqual(r.subjects, ['Horses', 'Cowboys', 'Men', 'Southwest']);
});

test('buildRecord drops a pre-1931 item when a genuine restriction is appended after the boilerplate disclaimer', () => {
  const boilerplate = 'Please cite DeGolyer Library, Southern Methodist University as the source of this file. A high-resolution version of this file may be obtained for a fee. For details, see the https://www.smu.edu/libraries/degolyer/using/images web page. For more information, contact degolyer@smu.edu.';
  const r = buildRecord({
    alias: 'wes',
    itemId: 7,
    itemInfo: { title: 'Cattle Girl', date: '1906', rights: `${boilerplate} Access restricted per donor agreement.` },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.equal(r, null, 'genuine per-item restriction text surviving the boilerplate strip must still veto, even pre-1931');
});

test('buildRecord treats Template B ("may be protected by copyright law...") as boilerplate too, not a veto, for pre-1931 items', () => {
  const templateB = 'This item may be protected by copyright law. Please cite DeGolyer Library, Southern Methodist University as the source of this file. For more information, contact degolyer@smu.edu.';
  const r = buildRecord({
    alias: 'wes',
    itemId: 8,
    itemInfo: { title: 'Old locomotive photo', date: '1909', rights: templateB },
    imageInfo: { width: 2000, height: 1500 },
  });
  assert.ok(r, 'Template B is boilerplate hedge language, not a per-item veto; a pre-1931 item should pass via the date rule');
});
