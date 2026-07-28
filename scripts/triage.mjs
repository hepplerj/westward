// Retroactive geographic triage: applies geo-triage to the already-harvested
// data/ manifests without re-querying any API. Rewrites chunks + index.json.
// Usage: node scripts/triage.mjs [--dry-run]

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { geoTriage, triageSummary } from './lib/geo-triage.mjs';
import { chunk, countBySource, staleChunkFiles } from './harvest.mjs';

const dryRun = process.argv.includes('--dry-run');

const index = JSON.parse(await readFile('data/index.json', 'utf8'));
const records = [];
for (let i = 0; i < index.chunkCount; i++) {
  records.push(...JSON.parse(await readFile(`data/manifest-${String(i).padStart(3, '0')}.json`, 'utf8')));
}

const { kept, dropped } = geoTriage(records);
console.error(triageSummary(dropped));
for (const { record, place } of dropped) {
  console.error(`  - [${place}] ${record.id}: ${record.title.slice(0, 80)}`);
}

if (dryRun) {
  console.error(`dry run: would keep ${kept.length} of ${records.length}; data/ untouched`);
  process.exit(0);
}

const chunks = chunk(kept, index.chunkSize);
await Promise.all(chunks.map((c, i) =>
  writeFile(`data/manifest-${String(i).padStart(3, '0')}.json`, JSON.stringify(c)),
));
const stale = staleChunkFiles(await readdir('data'), chunks.length);
await Promise.all(stale.map((name) => unlink(`data/${name}`)));

await writeFile('data/index.json', JSON.stringify({
  ...index,
  generated: new Date().toISOString(),
  total: kept.length,
  chunkCount: chunks.length,
  sources: countBySource(kept),
}, null, 2));

console.error(`triage complete: kept ${kept.length} of ${records.length} in ${chunks.length} chunks`);
