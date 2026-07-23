// Portal to Texas History (UNT). Discovery via the OpenSearch Atom feed
// (regex ARK extraction — no XML parser dependency); per-item metadata,
// dimensions, and IIIF image service from the item's IIIF Presentation
// manifest at {ark-url}/manifest/.
//
// Paging: the description document / feed's own rel="next"/"last" links
// (captured in tests/fixtures/texas-opensearch.xml) page with `pw=<n>`, not
// `page=<n>`; `q`/`pw` combine with an explicit `format=atom`.
//
// Rights: every PTH IIIF manifest carries a manifest-level `license` that is
// just the site's generic terms-of-use URL (not a per-item rights
// statement), so it is excluded before being handed to areRightsOpen —
// otherwise it would veto every record (it never matches the "open" rights
// regex). A genuine per-item rights/license metadata label (if present) is
// still used.

import { areRightsOpen } from '../lib/rights.mjs';

const BASE = 'https://texashistory.unt.edu';
const SEARCHES = [
  ['cattle ranch', 120],
  ['homestead', 80],
  ['windmill farm', 60],
  ['cattle drive', 50],
  ['railroad depot', 40],
];

const GENERIC_LICENSE_RE = /texashistory\.unt\.edu\/terms-of-use/i;

export function extractArks(atomXml) {
  const seen = new Set();
  for (const m of String(atomXml).matchAll(/ark:\/67531\/([a-z0-9]+)/g)) seen.add(m[1]);
  return [...seen];
}

// First metadata value whose label matches labelRe (singular fields: date, creator, rights).
function metaValue(manifest, labelRe) {
  for (const entry of manifest.metadata ?? []) {
    if (labelRe.test(String(entry.label ?? ''))) {
      return Array.isArray(entry.value) ? entry.value.join(' ') : String(entry.value ?? '');
    }
  }
  return null;
}

// All metadata values whose label matches labelRe, flattened. PTH manifests
// repeat labels like subject.UNTL-BS / subject.AAT / subject.KWD as separate
// metadata entries rather than one pipe-delimited value, so every matching
// entry is collected (each entry's own value is also split on "|" in case a
// single entry does carry a delimited list).
function metaValues(manifest, labelRe) {
  const out = [];
  for (const entry of manifest.metadata ?? []) {
    if (!labelRe.test(String(entry.label ?? ''))) continue;
    const raw = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const v of raw) {
      if (v === null || v === undefined || v === '') continue;
      out.push(...String(v).split('|'));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function plainLabel(label) {
  // IIIF labels may be strings, arrays, or {"@value": ...} / {"en": [...]}.
  if (typeof label === 'string') return label;
  if (Array.isArray(label)) return plainLabel(label[0]);
  if (label && typeof label === 'object') {
    return plainLabel(label['@value'] ?? Object.values(label)[0]);
  }
  return '';
}

// Rights fields for areRightsOpen: the manifest's top-level `license`, minus
// the generic PTH terms-of-use boilerplate (treated as absent), plus any
// metadata label that actually looks like a rights/license statement.
function rightsFields(manifest) {
  const license = typeof manifest.license === 'string' ? manifest.license : '';
  const genuineLicense = GENERIC_LICENSE_RE.test(license) ? null : license;
  return [genuineLicense, metaValue(manifest, /rights|license/i)];
}

export function manifestToRecord(arkName, manifest) {
  const canvas = manifest.sequences?.[0]?.canvases?.[0];
  const service = canvas?.images?.[0]?.resource?.service?.['@id'];
  const width = Number(canvas?.width);
  const height = Number(canvas?.height);
  if (!service || !width || !height) return null;

  const title = plainLabel(manifest.label).trim();
  if (!title) return null;

  const date = metaValue(manifest, /^date/i);
  // Each rights field must individually pass (areRightsOpen veto semantics).
  if (!areRightsOpen(rightsFields(manifest), date)) return null;

  return {
    id: `texas:${arkName}`,
    title,
    date: date ?? null,
    creator: metaValue(manifest, /^creator|^photographer/i),
    source: 'Portal to Texas History',
    sourceUrl: `${BASE}/ark:/67531/${arkName}/`,
    imageUrl: `${service}/full/1024,/0/default.jpg`,
    thumbUrl: `${service}/full/640,/0/default.jpg`,
    width,
    height,
    subjects: metaValues(manifest, /^subject/i),
  };
}

// Paging parameter reconciled against tests/fixtures/texas-opensearch.xml's
// own rel="next"/rel="last" links, which page with `pw=<n>` (not `page=<n>`)
// and carry an explicit format=atom.
function pageUrl(query, page) {
  return `${BASE}/search/opensearch/?q=${encodeURIComponent(query)}&pw=${page}&format=atom`;
}

export async function harvestTexas(fetcher, { target = 350, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [query, quota] of SEARCHES) {
    if (records.length >= target) break;
    let kept = 0;
    for (let page = 1; kept < quota && page <= 8; page++) {
      let arks;
      try {
        arks = extractArks(await fetcher.fetchText(pageUrl(query, page)));
      } catch (err) {
        log(`texas:"${query}" page ${page} failed: ${err.message}`);
        break;
      }
      if (!arks.length) break;
      for (const ark of arks) {
        if (kept >= quota || records.length >= target) break;
        if (seen.has(ark)) continue;
        seen.add(ark);
        let record = null;
        try {
          record = manifestToRecord(ark, await fetcher.fetchJson(`${BASE}/ark:/67531/${ark}/manifest/`));
        } catch (err) {
          log(`texas:${ark} manifest failed: ${err.message}`);
        }
        if (record) {
          records.push(record);
          kept++;
        }
      }
    }
    log(`texas:"${query}" kept ${kept}`);
  }
  return records;
}
