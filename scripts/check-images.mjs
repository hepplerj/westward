// Samples harvested records and verifies their imageUrls actually serve
// images. Usage: node scripts/check-images.mjs [sampleSize]

import { readFile } from 'node:fs/promises';

const SAMPLE = Number(process.argv[2]) || 30;

// Derive the chunk file list from index.json's chunkCount rather than
// globbing data/ for manifest-* files, so a leftover chunk from a previous,
// larger harvest (see harvest.mjs's stale-chunk cleanup) can't be sampled.
const index = JSON.parse(await readFile('data/index.json', 'utf8'));
const chunkFiles = Array.from(
  { length: index.chunkCount },
  (_, i) => `manifest-${String(i).padStart(3, '0')}.json`,
);
const records = [];
for (const f of chunkFiles) records.push(...JSON.parse(await readFile(`data/${f}`, 'utf8')));

const sample = [...records].sort(() => Math.random() - 0.5).slice(0, SAMPLE);
let ok = 0;
for (const r of sample) {
  try {
    const res = await fetch(r.imageUrl, {
      headers: { 'user-agent': 'western-explorer-harvest/0.1 (jason.heppler@gmail.com)' },
    });
    const type = res.headers.get('content-type') ?? '';
    if (res.ok && type.startsWith('image/')) ok++;
    else console.error(`BAD ${res.status} ${type} ${r.id} ${r.imageUrl}`);
    await res.body?.cancel();
  } catch (err) {
    console.error(`FAIL ${r.id} ${err.message}`);
  }
  await new Promise((res) => setTimeout(res, 400));
}
console.log(`${ok}/${sample.length} sampled images OK`);
process.exit(ok >= sample.length * 0.9 ? 0 : 1);
