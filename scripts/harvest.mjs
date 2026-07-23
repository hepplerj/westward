// Harvest orchestrator. Runs all source modules, dedupes, validates,
// interleaves for visual variety, chunks, and writes data/.
// Usage: node scripts/harvest.mjs [--quick]

import { mkdir, writeFile } from 'node:fs/promises';
import { createFetcher } from './lib/fetch-util.mjs';
import { harvestLoc } from './sources/loc.mjs';
import { harvestTexas } from './sources/texas.mjs';
import { harvestSmu } from './sources/smu.mjs';

const CHUNK_SIZE = 100;

export function dedupeRecords(records) {
  const ids = new Set();
  const urls = new Set();
  const out = [];
  for (const r of records) {
    if (ids.has(r.id) || urls.has(r.imageUrl)) continue;
    ids.add(r.id);
    urls.add(r.imageUrl);
    out.push(r);
  }
  return out;
}

export function validateRecord(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (typeof r.id !== 'string' || !/^[a-z]+:.+/.test(r.id)) return 'bad id';
  if (typeof r.title !== 'string' || !r.title.trim()) return 'empty title';
  if (typeof r.source !== 'string' || !r.source) return 'missing source';
  for (const key of ['sourceUrl', 'imageUrl', 'thumbUrl']) {
    if (typeof r[key] !== 'string' || !/^https?:\/\//.test(r[key])) return `bad ${key}`;
  }
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(r[key]) || r[key] <= 0) return `bad ${key}`;
  }
  if (!Array.isArray(r.subjects)) return 'bad subjects';
  return null;
}

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Proportional round-robin: at each step take from the list with the highest
// fraction of records still unplaced, so small sources spread across the
// whole stream instead of clustering.
export function interleave(lists) {
  const pools = lists.filter((l) => l.length).map((l) => ({ items: [...l], total: l.length }));
  const out = [];
  while (pools.some((p) => p.items.length)) {
    let best = null;
    for (const p of pools) {
      if (!p.items.length) continue;
      if (!best || p.items.length / p.total > best.items.length / best.total) best = p;
    }
    out.push(best.items.shift());
  }
  return out;
}

export function chunk(records, size) {
  const out = [];
  for (let i = 0; i < records.length; i += size) out.push(records.slice(i, i + size));
  return out;
}

async function main() {
  const quick = process.argv.includes('--quick');
  const targets = quick ? { loc: 40, texas: 20, smu: 12 } : { loc: 1000, texas: 350, smu: 150 };
  const log = (msg) => console.error(msg);

  const locFetcher = createFetcher({ minIntervalMs: 3500 }); // LOC hard limit: 20/min
  const fastFetcher = createFetcher({ minIntervalMs: 350 });

  const [loc, texas, smu] = await Promise.all([
    harvestLoc(locFetcher, { target: targets.loc, log }),
    harvestTexas(fastFetcher, { target: targets.texas, log }),
    harvestSmu(createFetcher({ minIntervalMs: 350 }), { target: targets.smu, log }),
  ]);

  const all = dedupeRecords([...loc, ...texas, ...smu]);
  const invalid = all.map((r) => [r, validateRecord(r)]).filter(([, err]) => err);
  for (const [r, err] of invalid) log(`invalid record dropped (${err}): ${r.id}`);
  const valid = all.filter((r) => !validateRecord(r));

  const stream = interleave([shuffle(loc), shuffle(texas), shuffle(smu)].map(
    (list) => list.filter((r) => valid.includes(r)),
  ));

  const chunks = chunk(stream, CHUNK_SIZE);
  await mkdir('data', { recursive: true });
  await Promise.all(chunks.map((c, i) =>
    writeFile(`data/manifest-${String(i).padStart(3, '0')}.json`, JSON.stringify(c)),
  ));
  await writeFile('data/index.json', JSON.stringify({
    generated: new Date().toISOString(),
    total: stream.length,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    sources: {
      'Library of Congress': loc.length,
      'Portal to Texas History': texas.length,
      'SMU DeGolyer Library': smu.length,
    },
  }, null, 2));

  console.error(`\nharvest complete: ${stream.length} records in ${chunks.length} chunks`);
  console.error(`  LOC ${loc.length} / Texas ${texas.length} / SMU ${smu.length}; dropped ${invalid.length} invalid`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
