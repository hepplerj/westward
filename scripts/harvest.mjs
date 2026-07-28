// Harvest orchestrator. Runs all source modules, dedupes, validates,
// interleaves for visual variety, chunks, and writes data/.
// Usage: node scripts/harvest.mjs [--quick]

import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { loadEnv } from './lib/env.mjs';
import { createFetcher } from './lib/fetch-util.mjs';
import { harvestLoc } from './sources/loc.mjs';
import { harvestTexas } from './sources/texas.mjs';
import { harvestSmu } from './sources/smu.mjs';
import { harvestDpla } from './sources/dpla.mjs';

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

export function countBySource(records) {
  const counts = {};
  for (const r of records) counts[r.source] = (counts[r.source] ?? 0) + 1;
  return counts;
}

const CHUNK_NAME_RE = /^manifest-(\d{3})\.json$/;

// Chunk filenames from a previous, larger harvest that this run no longer
// writes (e.g. harvest:quick after a full harvest) — anything matching
// manifest-NNN.json whose index is >= the number of chunks we just wrote.
export function staleChunkFiles(existingNames, keepCount) {
  return existingNames.filter((name) => {
    const m = CHUNK_NAME_RE.exec(name);
    return m && Number(m[1]) >= keepCount;
  });
}

async function main() {
  loadEnv(); // populates process.env.DPLA_API_KEY from .env, if present; never overrides an already-set var

  const quick = process.argv.includes('--quick');
  const targets = quick
    ? { loc: 40, texas: 20, smu: 12, dpla: 15 }
    : { loc: 1600, texas: 550, smu: 200, dpla: 300 };
  const log = (msg) => console.error(msg);

  const locFetcher = createFetcher({ minIntervalMs: 3500 }); // LOC hard limit: 20/min
  const fastFetcher = createFetcher({ minIntervalMs: 350 });

  // Explicit pre-check for DPLA_API_KEY: skip only if unset, so genuine
  // harvestDpla rejections propagate loudly instead of silently returning [].
  const dplaPromise = process.env.DPLA_API_KEY
    ? harvestDpla(createFetcher({ minIntervalMs: 350 }), { target: targets.dpla, log })
    : (log('dpla: skipped (no DPLA_API_KEY)'), Promise.resolve([]));

  const [loc, texas, smu, dpla] = await Promise.all([
    harvestLoc(locFetcher, { target: targets.loc, log }),
    harvestTexas(fastFetcher, { target: targets.texas, log }),
    harvestSmu(createFetcher({ minIntervalMs: 350 }), { target: targets.smu, log }),
    dplaPromise,
  ]);

  const all = dedupeRecords([...loc, ...texas, ...smu, ...dpla]);
  const invalid = all.map((r) => [r, validateRecord(r)]).filter(([, err]) => err);
  for (const [r, err] of invalid) log(`invalid record dropped (${err}): ${r.id}`);
  const valid = all.filter((r) => !validateRecord(r));

  const stream = interleave([shuffle(loc), shuffle(texas), shuffle(smu), shuffle(dpla)].map(
    (list) => list.filter((r) => valid.includes(r)),
  ));

  const chunks = chunk(stream, CHUNK_SIZE);
  await mkdir('data', { recursive: true });
  await Promise.all(chunks.map((c, i) =>
    writeFile(`data/manifest-${String(i).padStart(3, '0')}.json`, JSON.stringify(c)),
  ));

  // Remove chunk files left over from a previous, larger harvest (e.g.
  // harvest:quick run after a full harvest) so stale data can't be sampled
  // by check-images or shipped in a deploy.
  const stale = staleChunkFiles(await readdir('data'), chunks.length);
  await Promise.all(stale.map((name) => unlink(`data/${name}`)));
  if (stale.length) log(`removed ${stale.length} stale manifest chunk(s): ${stale.join(', ')}`);

  await writeFile('data/index.json', JSON.stringify({
    generated: new Date().toISOString(),
    total: stream.length,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    sources: countBySource(stream),
  }, null, 2));

  console.error(`\nharvest complete: ${stream.length} records in ${chunks.length} chunks`);
  console.error(`  LOC ${loc.length} / Texas ${texas.length} / SMU ${smu.length} / DPLA ${dpla.length}; dropped ${invalid.length} invalid`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
