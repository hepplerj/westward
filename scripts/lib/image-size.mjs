// DPLA docs carry no pixel dimensions in their metadata, so we probe the
// thumbnail image itself: fetch a bounded prefix of the bytes (streaming,
// capped, aborted early) and parse the format's own header for width/height.
// This doubles as the dead-link check for DPLA records (see dpla.mjs) — a
// fetch failure or unparseable header both mean "drop the record".
//
// Supports the three raster formats DPLA thumbnails are actually served as:
// JPEG (SOF0/SOF2 marker segments), PNG (IHDR chunk), GIF (logical screen
// descriptor). No animated/multi-frame handling — we only need the nominal
// canvas size.

const USER_AGENT = 'western-explorer-harvest/0.1 (jason.heppler@gmail.com)';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(buf) {
  if (buf.length < 24) return false; // signature(8) + length(4) + "IHDR"(4) + width(4) + height(4)
  return PNG_SIGNATURE.every((byte, i) => buf[i] === byte);
}

function pngSize(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

function isGif(buf) {
  return buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a');
}

function gifSize(buf) {
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  return width && height ? { width, height } : null;
}

// SOF (Start Of Frame) markers carry the image dimensions. 0xC4 (DHT),
// 0xC8 (JPG extension, reserved), and 0xCC (DAC) are not SOF markers despite
// falling in the 0xC0-0xCF range.
function isSofMarker(marker) {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(buf) {
  let offset = 2; // past the SOI marker (0xFFD8)
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; } // resync on stray byte
    const marker = buf[offset + 1];
    if (marker === 0xff) { offset += 1; continue; } // fill byte before the real marker
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; } // no-payload markers
    if (marker === 0xd9) return null; // EOI reached without finding a SOF
    if (offset + 4 > buf.length) return null; // truncated before the segment length
    const segLen = buf.readUInt16BE(offset + 2);
    if (isSofMarker(marker)) {
      if (offset + 9 > buf.length) return null; // truncated before height/width
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return width && height ? { width, height } : null;
    }
    offset += 2 + segLen;
  }
  return null; // ran out of buffer (e.g. truncated at the read cap) without a SOF
}

export function imageSizeFromBuffer(buf) {
  if (!buf || buf.length < 8) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpegSize(buf);
    if (isPng(buf)) return pngSize(buf);
    if (isGif(buf)) return gifSize(buf);
  } catch {
    return null;
  }
  return null;
}

// Fetch a bounded prefix of `url`'s bytes (default cap 64KB) and parse its
// dimensions. Aborts the underlying request once the cap is reached rather
// than downloading the whole image — headers live in the first few KB for
// every format we support. Returns null on any failure: network error,
// non-OK status, or bytes that don't parse as a supported image.
export async function probeImageSize(url, { fetchImpl = globalThis.fetch, maxBytes = 65536 } = {}) {
  const controller = new AbortController();
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { 'user-agent': USER_AGENT } });
  } catch {
    return null;
  }
  if (!res || !res.ok || !res.body) return null;

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } catch {
    return null;
  } finally {
    controller.abort();
    reader.cancel().catch(() => {});
  }

  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return imageSizeFromBuffer(buf);
}
