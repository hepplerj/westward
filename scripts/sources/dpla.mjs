// Digital Public Library of America (https://pro.dp.la/developers). Search
// via /v2/items; Denver Public Library / Plains to Peaks Collective material
// is prioritized via the `provider.name` hub filter, then supplemented with
// national queries scoped to Western states.
//
// Response shape reconciled against a live capture (tests/fixtures/dpla-search.json,
// captured 2026-07-27 with the api_key stripped before saving): top-level
// `{count, docs: [...], facets, limit, start}`. Per doc: `id` (bare hex
// string — the id half of the "dpla:{id}" record id), `isShownAt` (item page),
// `object` (thumbnail URL on the holding institution's own server — present
// on ~87% of docs in the capture; absent docs are skipped), `dataProvider`
// (holding institution; always an object `{name, ...}` in the capture, never
// a bare string, though both are handled defensively per the brief),
// `rights` (a rightsstatements.org URI in every sampled doc) and/or
// `sourceResource.rights` (free text; present on non-hub aggregators like
// Digital Commonwealth, absent on every p2p-hub doc sampled), and
// `sourceResource.{title, date: [{displayDate, begin, end}], creator,
// subject: [{name}]}` — title/creator/subject are arrays even when singular.
//
// DEVIATION (provider filter): `provider.name=Plains to Peaks Collective`
// works exactly as the brief assumed — confirmed live, every doc in a
// provider-filtered capture carries that provider name, including at least
// one Denver Public Library dataProvider.
//
// DEVIATION (state filter): the brief suggested `sourceResource.spatial.state`
// for the two "west-*" queries. Live testing shows this field is an
// exact-match keyword only a handful of large aggregators populate (e.g.
// Digital Commonwealth/Boston Public Library) — none of the Colorado/Wyoming
// local-archive dataProviders that P2P surfaces populate it at all. Combined
// with a topic `q`, it returned 0 results for Colorado and for 6 of 7 target
// states, and only 2 total for Wyoming (verified across all seven target
// states: Colorado, Wyoming, Montana, Nebraska, Kansas, South Dakota, North
// Dakota — see task-dpla-report.md for the raw counts). `sourceResource.spatial.name`
// (a free-text field carrying place names like "Denver (Colo.)", "Eagle,
// Colorado") is populated far more broadly and reliably intersects with
// topic queries (130 hits for q=homesteading + name=Colorado, vs. 0 for the
// `.state` equivalent), so the "west-*" queries filter on `.name`, one state
// name per request (the API has no OR syntax for a single field param).
//
// DEVIATION (rights vocabulary beyond the brief's pinned cases): live rights
// facets on our actual queries show `CNE` (Copyright Not Evaluated) and
// `UND` (Copyright Undetermined) as the two MOST common rightsstatements.org
// values (923 and 208 of ~2300 in one facet sample) — ambiguous, not in the
// brief's named list, but squarely "any other rightsstatements.org URI"
// under its veto rule, so they're dropped like InC/NoC-NC. Also seen live:
// non-public-domain Creative Commons licenses (e.g. `creativecommons.org/licenses/by-nc/4.0/`,
// 28 hits in the same facet) — not `.../publicdomain/...`, so not the open
// case, and not a rightsstatements.org URI either. Per this project's
// stated policy (public domain / no-known-restrictions only — see README),
// these are treated as restrictive same as any other recognized rights URI
// that isn't the two explicitly-open forms; see the classifyRightsValue
// test cases pinning CC-BY-NC as dropped.

import { isRightsOpen } from '../lib/rights.mjs';
import { probeImageSize } from '../lib/image-size.mjs';

const API_BASE = 'https://api.dp.la/v2/items';
const PROVIDER_P2P = 'Plains to Peaks Collective';
const WEST_STATES = ['Colorado', 'Wyoming', 'Montana', 'Nebraska', 'Kansas', 'South Dakota', 'North Dakota'];

// (label, base query params, quota). Plains to Peaks first per the brief.
const HUB_QUERIES = [
  ['p2p-ranching', { q: 'ranching', 'provider.name': PROVIDER_P2P }, 60],
  ['p2p-homestead', { q: 'homestead', 'provider.name': PROVIDER_P2P }, 60],
  ['p2p-mining', { q: 'mining', 'provider.name': PROVIDER_P2P }, 50],
  ['p2p-cattle', { q: 'cattle', 'provider.name': PROVIDER_P2P }, 40],
];

// (label, q, quota) — each iterates WEST_STATES via sourceResource.spatial.name.
const STATE_QUERIES = [
  ['west-homesteading', 'homesteading', 45],
  ['west-cattle-ranch', 'cattle ranch', 45],
];

// --- rights classification -------------------------------------------------

const OPEN_URI_RE = /creativecommons\.org\/publicdomain|rightsstatements\.org\/vocab\/NoC-US\b/i;
const URI_RE = /^https?:\/\//i;
const KNOWN_RIGHTS_DOMAIN_RE = /rightsstatements\.org|creativecommons\.org/i;

// Classify a single rights value. URIs: CC0/PDM or NoC-US are 'open'; any
// other rightsstatements.org or creativecommons.org URI is 'restrictive'
// (see the module-level DEVIATION note on CNE/UND/non-PD CC licenses). Free
// text: delegate to the shared isRightsOpen regex.
function classifyRightsValue(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return null;
  if (URI_RE.test(v)) {
    if (OPEN_URI_RE.test(v)) return 'open';
    if (KNOWN_RIGHTS_DOMAIN_RE.test(v)) return 'restrictive';
    return 'restrictive'; // unrecognized rights URI: treat conservatively as restrictive
  }
  return isRightsOpen(v, null) ? 'open' : 'restrictive';
}

// A record is kept only if at least one rights value is explicitly open AND
// no value is restrictive (first restrictive value vetoes immediately, even
// if an open value was already seen). With no rights values at all, fall
// back to the shared <=1930 date rule.
export function dplaRightsOpen(values, date) {
  const flat = [values].flat(2).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!flat.length) return isRightsOpen(null, date);
  let anyOpen = false;
  for (const v of flat) {
    const cls = classifyRightsValue(v);
    if (cls === 'restrictive') return false;
    if (cls === 'open') anyOpen = true;
  }
  return anyOpen;
}

// --- parsing ----------------------------------------------------------------

function firstString(value) {
  if (Array.isArray(value)) return value.length ? (String(value[0]).trim() || null) : null;
  return value ? (String(value).trim() || null) : null;
}

function dataProviderName(doc) {
  const dp = doc.dataProvider;
  if (!dp) return null;
  if (typeof dp === 'string') return dp.trim() || null;
  if (typeof dp === 'object') return firstString(dp.name);
  return null;
}

function dateOf(sr) {
  const raw = sr?.date;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const entry of entries) {
    if (typeof entry === 'string') { if (entry.trim()) return entry.trim(); continue; }
    if (entry && typeof entry === 'object') {
      if (entry.displayDate) return String(entry.displayDate).trim() || null;
      const range = [entry.begin, entry.end].filter(Boolean).join('-');
      if (range) return range;
    }
  }
  return null;
}

function subjectsOf(sr) {
  const raw = sr?.subject;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((s) => (typeof s === 'string' ? s : s?.name)).filter(Boolean).map(String);
}

// Rights fields collected from a doc, pre-probe (no network needed — this is
// what lets harvestDpla skip the expensive thumbnail probe for docs that
// would be dropped anyway).
export function docPassesRights(doc) {
  const sr = doc.sourceResource ?? {};
  return dplaRightsOpen([doc.rights, sr.rights], dateOf(sr));
}

// Pure builder: doc (parsed API JSON) + already-probed thumbnail dimensions
// -> a schema record, or null if anything required is missing/invalid.
export function buildRecord(doc, dims) {
  if (!doc || !dims || !Number.isInteger(dims.width) || !Number.isInteger(dims.height)) return null;
  if (dims.width <= 0 || dims.height <= 0) return null;
  if (Math.max(dims.width, dims.height) < 300) return null;

  const id = String(doc.id ?? '').trim();
  if (!id) return null;

  const sr = doc.sourceResource ?? {};
  const title = firstString(sr.title);
  if (!title) return null;

  const sourceUrl = String(doc.isShownAt ?? '').trim();
  if (!sourceUrl.startsWith('http')) return null;

  const imageUrl = String(doc.object ?? '').trim();
  if (!imageUrl.startsWith('http')) return null;

  const source = dataProviderName(doc);
  if (!source) return null;

  if (!docPassesRights(doc)) return null;

  return {
    id: `dpla:${id}`,
    title,
    date: dateOf(sr),
    creator: firstString(sr.creator),
    source,
    sourceUrl,
    imageUrl,
    thumbUrl: imageUrl,
    width: dims.width,
    height: dims.height,
    subjects: subjectsOf(sr),
  };
}

export function parseSearchDocs(json) {
  return Array.isArray(json?.docs) ? json.docs : [];
}

// --- harvesting ---------------------------------------------------------

// Strip the API key from any URL embedded in an error message before it is
// ever logged — fetch-util's HttpError includes the request URL verbatim.
function redact(text) {
  return String(text ?? '').replace(/([?&]api_key=)[^&\s]*/gi, '$1REDACTED');
}

function searchUrl(apiKey, params, page) {
  const qs = new URLSearchParams({ ...params, api_key: apiKey, page_size: '100', page: String(page) });
  return `${API_BASE}?${qs.toString()}`;
}

// fetch-util.mjs's createFetcher is left untouched (per the brief), and its
// fetchJson/fetchText both buffer the whole body as text — wrong for binary
// image bytes anyway. Thumbnail probes need their own throttled raw fetch;
// this mirrors createFetcher's minIntervalMs pacing but only wraps a bare
// fetch call (no retry/JSON parsing), independent of the DPLA API's own
// request pacing since it targets institution image servers, not dp.la.
export function createThrottledRawFetch(minIntervalMs, fetchImpl = globalThis.fetch) {
  let lastAt = 0;
  return async (url, opts) => {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fetchImpl(url, opts);
  };
}

async function collect(fetcher, { apiKey, paramsForPage, quotaRemaining, seen, records, target, log, label, probeFetchImpl }) {
  let kept = 0;
  for (let page = 1; kept < quotaRemaining && records.length < target && page <= 10; page++) {
    let json;
    try {
      json = await fetcher.fetchJson(searchUrl(apiKey, paramsForPage, page));
    } catch (err) {
      log(`dpla:${label} page ${page} failed: ${redact(err.message)}`);
      break;
    }
    const docs = parseSearchDocs(json);
    if (!docs.length) break;
    for (const doc of docs) {
      if (kept >= quotaRemaining || records.length >= target) break;
      const id = String(doc.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!docPassesRights(doc)) continue;
      const objectUrl = String(doc.object ?? '').trim();
      if (!objectUrl.startsWith('http')) continue;
      let dims;
      try {
        dims = await probeImageSize(objectUrl, { fetchImpl: probeFetchImpl });
      } catch {
        dims = null;
      }
      if (!dims) { log(`dpla:${label} probe failed for ${id}`); continue; }
      const record = buildRecord(doc, dims);
      if (record) {
        records.push(record);
        kept++;
      }
    }
  }
  log(`dpla:${label} kept ${kept}`);
  return kept;
}

export async function harvestDpla(fetcher, {
  target = 300,
  log = console.error,
  apiKey = process.env.DPLA_API_KEY,
  probeFetchImpl = createThrottledRawFetch(350),
} = {}) {
  if (!apiKey) throw new Error('DPLA_API_KEY not set');

  const seen = new Set();
  const records = [];

  for (const [label, params, quota] of HUB_QUERIES) {
    if (records.length >= target) break;
    await collect(fetcher, { apiKey, paramsForPage: params, quotaRemaining: quota, seen, records, target, log, label, probeFetchImpl });
  }

  for (const [label, q, quota] of STATE_QUERIES) {
    if (records.length >= target) break;
    let kept = 0;
    for (const state of WEST_STATES) {
      if (kept >= quota || records.length >= target) break;
      kept += await collect(fetcher, {
        apiKey,
        paramsForPage: { q, 'sourceResource.spatial.name': state },
        quotaRemaining: quota - kept,
        seen,
        records,
        target,
        log,
        label: `${label}:${state}`,
        probeFetchImpl,
      });
    }
    log(`dpla:${label} kept ${kept} total across states`);
  }

  return records;
}
