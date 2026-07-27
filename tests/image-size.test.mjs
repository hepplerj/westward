import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { imageSizeFromBuffer, probeImageSize } from '../scripts/lib/image-size.mjs';

const realJpeg = readFileSync(new URL('./fixtures/dpla-thumb.jpg', import.meta.url));

// Build a minimal synthetic PNG: signature + IHDR chunk (only the fields
// imageSizeFromBuffer reads; CRC/rest of the file are irrelevant to parsing).
function buildPng(width, height) {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  buf.writeUInt32BE(13, 8); // IHDR chunk length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// Minimal synthetic GIF: "GIF89a" header + logical screen descriptor
// (width/height as little-endian uint16).
function buildGif(width, height) {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

// Minimal synthetic JPEG: SOI + an APP0 filler segment + SOF0 carrying
// height/width + EOI.
function buildJpeg(width, height) {
  const parts = [];
  parts.push(Buffer.from([0xff, 0xd8])); // SOI
  const app0 = Buffer.alloc(2 + 2 + 5);
  app0.set([0xff, 0xe0], 0);
  app0.writeUInt16BE(2 + 5, 2);
  app0.write('JFIF\0', 4, 'ascii');
  parts.push(app0);
  const sof0 = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sof0.set([0xff, 0xc0], 0);
  sof0.writeUInt16BE(2 + 1 + 2 + 2 + 1, 2); // segment length
  sof0.writeUInt8(8, 4); // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(1, 9); // components (irrelevant here)
  parts.push(sof0);
  parts.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(parts);
}

test('imageSizeFromBuffer parses a synthetic PNG IHDR chunk', () => {
  assert.deepEqual(imageSizeFromBuffer(buildPng(64, 32)), { width: 64, height: 32 });
});

test('imageSizeFromBuffer parses a synthetic GIF logical screen descriptor', () => {
  assert.deepEqual(imageSizeFromBuffer(buildGif(120, 90)), { width: 120, height: 90 });
});

test('imageSizeFromBuffer parses a synthetic JPEG SOF0 segment', () => {
  assert.deepEqual(imageSizeFromBuffer(buildJpeg(640, 480)), { width: 640, height: 480 });
});

test('imageSizeFromBuffer parses a real JPEG thumbnail captured from a live DPLA object URL', () => {
  // Pinned against `sips -g pixelWidth -g pixelHeight` on the captured file.
  assert.deepEqual(imageSizeFromBuffer(realJpeg), { width: 270, height: 399 });
});

test('imageSizeFromBuffer returns null for unrecognized bytes', () => {
  assert.equal(imageSizeFromBuffer(Buffer.from('not an image, just text')), null);
});

test('imageSizeFromBuffer returns null for a buffer too short to contain a header', () => {
  assert.equal(imageSizeFromBuffer(Buffer.from([0xff, 0xd8])), null);
  assert.equal(imageSizeFromBuffer(Buffer.alloc(0)), null);
  assert.equal(imageSizeFromBuffer(null), null);
});

test('imageSizeFromBuffer returns null for a JPEG truncated before its SOF segment', () => {
  const full = buildJpeg(640, 480);
  assert.equal(imageSizeFromBuffer(full.subarray(0, 6)), null);
});

function streamOf(buf) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

test('probeImageSize reads a streamed response and parses its dimensions', async () => {
  const fetchImpl = async () => ({ ok: true, body: streamOf(realJpeg) });
  assert.deepEqual(await probeImageSize('https://example.test/img.jpg', { fetchImpl }), { width: 270, height: 399 });
});

test('probeImageSize returns null when the fetch throws (dead link)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  assert.equal(await probeImageSize('https://example.test/dead.jpg', { fetchImpl }), null);
});

test('probeImageSize returns null on a non-OK response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, body: null });
  assert.equal(await probeImageSize('https://example.test/missing.jpg', { fetchImpl }), null);
});

test('probeImageSize caps its read at maxBytes instead of consuming an unbounded stream', async () => {
  let cancelled = false;
  const bigJpeg = buildJpeg(640, 480);
  // A stream that would keep producing chunks forever unless the reader stops pulling.
  let pushed = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pushed === 0) {
        controller.enqueue(new Uint8Array(bigJpeg));
        pushed += bigJpeg.length;
      } else {
        controller.enqueue(new Uint8Array(1024)); // more filler than maxBytes allows
        pushed += 1024;
      }
    },
    cancel() { cancelled = true; },
  });
  const fetchImpl = async () => ({ ok: true, body });
  const result = await probeImageSize('https://example.test/big.jpg', { fetchImpl, maxBytes: bigJpeg.length + 10 });
  assert.deepEqual(result, { width: 640, height: 480 });
  assert.ok(cancelled, 'reader should be cancelled once the byte cap is reached');
});
