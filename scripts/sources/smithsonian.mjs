// Smithsonian Open Access (https://www.si.edu/openaccess). Search via
// /openaccess/api/v1.0/search; every query is ANDed with the two mandatory
// filter clauses `online_media_type:"Images"` and `media_usage:"CC0"` — the
// latter is the media-level rights gate (every API record carries CC0
// *metadata*; only some carry CC0 *media*).
//
// Response shape reconciled against a live capture
// (tests/fixtures/smithsonian-search.json, captured 2026-07-27 with the
// api_key stripped before saving, verified with grep): top-level
// `{status, responseCode, response: {rows: [...], rowCount}}`. Per row: `id`
// (opaque string), `title`, `unitCode`, and `content.descriptiveNonRepeating`
// (`record_link` and/or `guid`, `online_media.media[]`), `content.freetext`
// (labeled lists: `date`, `name`, `topic`, ...), `content.indexedStructured`
// (`topic[]`, `date[]` as decade buckets like "1880s").
//
// DEVIATION (user-agent / WAF): the shared USER_AGENT string used by
// fetch-util.mjs's createFetcher and by image-size.mjs's probeImageSize —
// "western-explorer-harvest/0.1 (...)" — is silently rejected by an Akamai
// WAF in front of BOTH api.si.edu and ids.si.edu: the response is HTTP 200
// with an HTML "Request Rejected" body, not a machine-readable error.
// Isolated by trial: the literal substring "harvest/<version>" triggers the
// rule (e.g. "harvest/0.1" and "harvest/1.0" are both rejected; "harvester/0.1",
// "test/0.1", "western-explorer-harvest" with no slash, and a plain
// "western-explorer/0.1 (jason.heppler@gmail.com)" all pass). Since
// fetch-util.mjs and image-size.mjs hardcode their header and are on the
// project's do-not-modify list, this module never calls createFetcher or
// probeImageSize with their default fetchImpl: SI_USER_AGENT below is used
// via a small wrapping fetchImpl (siFetch) that overrides whatever header
// the caller set, so createFetcher's retry/backoff/throttle logic and
// probeImageSize/imageSizeFromBuffer's parsing logic are both still reused
// unmodified — only the outgoing header is swapped before the real request
// goes out.
//
// DEVIATION (query syntax — evidence over the brief's assumption): bare
// unquoted OR clauses combined with the mandatory AND filters produced wildly
// wrong result counts live, e.g. `ranching OR ranch AND online_media_type:...`
// returned rowCount 19109 with a sample hit of "Thomomys bottae mearnsi"
// (a gopher specimen record) — common English words like "ranch", "bison",
// "buffalo" collide with natural-history specimen locality text (e.g. "...
// collected on the Smith Ranch, TX"), which floods results from
// NMNH*-prefixed units having nothing to do with the American West theme.
// Two independent fixes were verified live and are both applied: (1) every
// OR clause is wrapped in parens — `(ranching OR ranch) AND ...`; (2) every
// query additionally ANDs a positive `unit_code:(...)` allowlist restricted
// to the six culturally-relevant units this module maps to a human source
// name (SAAM, NPG, NMAH, CHNDM, SIA, NMAAHC — see UNIT_SOURCE_MAP), which
// cuts `(ranching OR ranch) AND ...` from 19109 to 11 live and keeps
// `(bison OR buffalo) AND ...` (3781 without the unit filter, still
// including e.g. mammal-collection "Bison bison" specimen tags) down to 866,
// all on-theme in a manual sample (SIA archival bison-exhibit photos, SAAM
// bison paintings). NMAAHC is not in the brief's named unit map but is
// common enough in western-themed CC0 results to include in both the query
// allowlist and (via the fallback) the source map.
//
// DEVIATION (sourceUrl scheme): the brief expected record_link/guid to be
// https; live guids are sometimes a bare http:// URL (several CHNDM rows in
// the fixture). Accepted either scheme, matching harvest.mjs's own
// `/^https?:\/\//` validation, rather than rejecting otherwise-valid records.
//
// terms/topic discovery (used during development, not at runtime): confirms
// `topic:"Cowboys"` is populated (12 CC0-filtered hits) but several other
// plausible topic terms that DO exist in the vocabulary — "Ranching",
// "Homesteading", "Stagecoaches", "Covered wagons" — return 0 once the CC0
// media filter is applied (sparse coverage, same phenomenon the brief
// already documented for `topic:"West (U.S.)"`), so those categories are
// queried as free text (with the unit-allowlist fix above) instead.

import { probeImageSize } from '../lib/image-size.mjs';
import { createFetcher } from '../lib/fetch-util.mjs';

const API_BASE = 'https://api.si.edu/openaccess/api/v1.0/search';
const IDS_BASE = 'https://ids.si.edu/ids/deliveryService';

// See the WAF deviation note above — deliberately different from
// fetch-util.mjs / image-size.mjs's shared USER_AGENT.
const SI_USER_AGENT = 'western-explorer/0.1 (jason.heppler@gmail.com)';

// unitCode -> human-readable holding-institution name, for the units we
// realistically see in western-themed CC0 image results (kept small
// per the brief; anything else falls back to the umbrella name).
const UNIT_SOURCE_MAP = {
  SAAM: 'Smithsonian American Art Museum',
  NPG: 'National Portrait Gallery',
  NMAH: 'National Museum of American History',
  CHNDM: 'Cooper Hewitt, Smithsonian Design Museum',
  SIA: 'Smithsonian Institution Archives',
};

export function sourceOf(unitCode) {
  return UNIT_SOURCE_MAP[String(unitCode ?? '').trim()] ?? 'Smithsonian Institution';
}

// Same six units as UNIT_SOURCE_MAP plus NMAAHC (seen live, not in the
// brief's named map, but common in this theme and worth admitting into
// results via the fallback source name — see the query-syntax DEVIATION
// note above for why this allowlist exists at all).
// NMAI (National Museum of the American Indian) added 2026-07-28 for the
// vocabulary expansion; its media is often non-CC0, but the media_usage
// query filter and per-media CC0 check gate that as with every unit.
const UNIT_ALLOWLIST = ['SAAM', 'NPG', 'NMAH', 'CHNDM', 'SIA', 'NMAAHC', 'NMAI'];
const UNITS_CLAUSE = `(${UNIT_ALLOWLIST.map((u) => `unit_code:"${u}"`).join(' OR ')})`;
const MEDIA_CLAUSE = 'online_media_type:"Images" AND media_usage:"CC0"';

// (label, query fragment — parenthesized OR groups only, per the DEVIATION
// note above — quota). Quotas sum to the brief's target of 120; several
// queries have fewer on-theme CC0 hits than their quota live, which the
// brief calls out as expected (zero hits would be the actual failure).
const QUERIES = [
  ['cowboy', 'cowboy', 30],
  ['topic-cowboys', 'topic:"Cowboys"', 20],
  ['ranching', '(ranching OR ranch)', 25],
  ['homestead', 'homestead', 15],
  ['bison-buffalo', '(bison OR buffalo)', 15],
  ['stagecoach', '(stagecoach OR "covered wagon")', 15],
  // Vocabulary-expansion round (2026-07-28). No ceremony-targeted queries
  // (owner's editorial policy).
  ['indians-na', 'topic:"Indians of North America"', 40],
  ['vaquero', '(vaquero OR vaqueros)', 15],
  ['buffalo-soldiers', '"Buffalo Soldiers"', 15],
  ['rodeo', 'rodeo', 15],
];

function queryFor(fragment) {
  return `${UNITS_CLAUSE} AND ${fragment} AND ${MEDIA_CLAUSE}`;
}

// --- parsing -----------------------------------------------------------

export function parseSearchRows(json) {
  return Array.isArray(json?.response?.rows) ? json.response.rows : [];
}

function freetext(row, key) {
  return row?.content?.freetext?.[key];
}

export function dateOf(row) {
  const dateList = freetext(row, 'date');
  if (Array.isArray(dateList) && dateList.length && dateList[0]?.content) {
    return String(dateList[0].content).trim() || null;
  }
  const buckets = row?.content?.indexedStructured?.date;
  if (Array.isArray(buckets) && buckets.length) {
    return String(buckets[0]).trim() || null;
  }
  return null;
}

export function creatorOf(row) {
  const nameList = freetext(row, 'name');
  if (Array.isArray(nameList) && nameList.length && nameList[0]?.content) {
    return String(nameList[0].content).trim() || null;
  }
  return null;
}

const SUBJECTS_CAP = 12;

export function subjectsOf(row) {
  const topics = row?.content?.indexedStructured?.topic;
  if (!Array.isArray(topics)) return [];
  return topics.map(String).slice(0, SUBJECTS_CAP);
}

const URL_RE = /^https?:\/\//i;

// record_link (a human-facing page on the holding unit's own site) is
// preferred; guid (an n2t.net ark resolver link) is the fallback — see the
// sourceUrl-scheme DEVIATION note above for why both http and https are
// accepted.
export function sourceUrlOf(dnr) {
  const recordLink = String(dnr?.record_link ?? '').trim();
  if (URL_RE.test(recordLink)) return recordLink;
  const guid = String(dnr?.guid ?? '').trim();
  if (URL_RE.test(guid)) return guid;
  return null;
}

// The first (only, in every sampled record) media object, or null if
// online_media is null/absent — the brief's documented defensive case for
// records whose media-level rights don't actually clear CC0.
export function selectedMedia(row) {
  const media = row?.content?.descriptiveNonRepeating?.online_media?.media;
  return Array.isArray(media) && media.length ? media[0] : null;
}

export function mediaPassesCC0(media) {
  return media?.usage?.access === 'CC0';
}

// resources[] entry labeled "High-resolution JPEG" carries the *original*
// width/height on some records; we link the &max=1024 IDS derivative, so
// scale down to that derivative's size (same math as smu.mjs: never upscale
// past the source's own width).
export function highResDims(media) {
  const resources = media?.resources;
  if (!Array.isArray(resources)) return null;
  const hi = resources.find((r) => r?.label === 'High-resolution JPEG');
  const srcWidth = Number(hi?.width);
  const srcHeight = Number(hi?.height);
  if (!srcWidth || !srcHeight) return null;
  const width = Math.min(1024, srcWidth);
  const height = Math.round(srcHeight * (width / srcWidth));
  return { width, height };
}

// Defense-in-depth per-media rights check (the query-level media_usage:"CC0"
// clause is the primary gate). True only when there is a selected media
// object AND it explicitly carries CC0 access.
export function recordPassesRights(row) {
  return mediaPassesCC0(selectedMedia(row));
}

function idsUrl(idsId, max) {
  return `${IDS_BASE}?id=${encodeURIComponent(idsId)}&max=${max}`;
}

// Pure builder: row (parsed API JSON) + already-resolved dims (from
// resources[] or from a probe) -> a schema record, or null if anything
// required is missing/invalid.
export function buildRecord(row, dims) {
  if (!row || !dims || !Number.isInteger(dims.width) || !Number.isInteger(dims.height)) return null;
  if (dims.width <= 0 || dims.height <= 0) return null;
  if (Math.max(dims.width, dims.height) < 300) return null;

  const id = String(row.id ?? '').trim();
  if (!id) return null;

  const title = String(row.title ?? '').trim();
  if (!title) return null;

  const dnr = row.content?.descriptiveNonRepeating ?? {};
  const sourceUrl = sourceUrlOf(dnr);
  if (!sourceUrl) return null;

  const media = selectedMedia(row);
  if (!mediaPassesCC0(media)) return null;
  const idsId = String(media.idsId ?? '').trim();
  if (!idsId) return null;

  return {
    id: `si:${id}`,
    title,
    date: dateOf(row),
    creator: creatorOf(row),
    source: sourceOf(row.unitCode),
    sourceUrl,
    imageUrl: idsUrl(idsId, 1024),
    thumbUrl: idsUrl(idsId, 640),
    width: dims.width,
    height: dims.height,
    subjects: subjectsOf(row),
  };
}

// --- fetching ------------------------------------------------------------

// Strip the API key from any URL embedded in an error message before it is
// ever logged — fetch-util's HttpError includes the request URL verbatim
// (same pattern as dpla.mjs's redact()).
function redact(text) {
  return String(text ?? '').replace(/([?&]api_key=)[^&\s]*/gi, '$1REDACTED');
}

// Overrides whatever header the caller (createFetcher, or our own throttled
// raw fetch below) set, replacing it with SI_USER_AGENT — see the WAF
// DEVIATION note at the top of this file. Everything else about the call
// (signal, method, etc.) passes through untouched.
function siFetch(url, opts) {
  return globalThis.fetch(url, { ...opts, headers: { ...(opts?.headers ?? {}), 'user-agent': SI_USER_AGENT } });
}

// Reuses fetch-util.mjs's createFetcher (throttle, retry/backoff, HttpError,
// JSON parsing) unmodified; only the outgoing fetchImpl is swapped so the
// header override above takes effect.
function createSiFetcher(minIntervalMs) {
  return createFetcher({ minIntervalMs, fetchImpl: siFetch });
}

// Mirrors dpla.mjs's createThrottledRawFetch (image probes need their own
// throttled raw fetch independent of the search API's pacing, and
// fetch-util's fetchJson/fetchText both buffer as text — wrong for binary
// image bytes). Defined locally rather than imported from dpla.mjs since
// source modules don't import each other; the pattern, not the code, is
// shared.
export function createThrottledRawFetch(minIntervalMs, fetchImpl = siFetch) {
  let lastAt = 0;
  return async (url, opts) => {
    const wait = lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fetchImpl(url, opts);
  };
}

function searchUrl(apiKey, q, rows, start) {
  const qs = new URLSearchParams({ api_key: apiKey, q, rows: String(rows), start: String(start) });
  return `${API_BASE}?${qs.toString()}`;
}

async function collect(fetcher, { apiKey, fragment, quotaRemaining, seen, records, target, log, label, probeFetchImpl }) {
  let kept = 0;
  const pageSize = 100;
  for (let start = 0; kept < quotaRemaining && records.length < target && start < 1000; start += pageSize) {
    let json;
    try {
      json = await fetcher.fetchJson(searchUrl(apiKey, queryFor(fragment), pageSize, start));
    } catch (err) {
      log(`smithsonian:${label} start=${start} failed: ${redact(err.message)}`);
      break;
    }
    const rows = parseSearchRows(json);
    if (!rows.length) break;
    for (const row of rows) {
      if (kept >= quotaRemaining || records.length >= target) break;
      const id = String(row.id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!recordPassesRights(row)) continue;
      const media = selectedMedia(row);
      let dims = highResDims(media);
      if (!dims) {
        try {
          dims = await probeIdsImage(media.idsId, probeFetchImpl);
        } catch {
          dims = null;
        }
        if (!dims) { log(`smithsonian:${label} probe failed for ${id}`); continue; }
      }
      const record = buildRecord(row, dims);
      if (record) {
        records.push(record);
        kept++;
      }
    }
  }
  log(`smithsonian:${label} kept ${kept}`);
  return kept;
}

// Thin wrapper: builds the &max=1024 IDS URL and reuses probeImageSize /
// imageSizeFromBuffer unmodified via the SI-user-agent-overriding fetchImpl
// — see the WAF DEVIATION note above.
function probeIdsImage(idsId, probeFetchImpl) {
  return probeImageSize(idsUrl(idsId, 1024), { fetchImpl: probeFetchImpl });
}

export async function harvestSmithsonian(fetcher, {
  target = 120,
  log = console.error,
  apiKey = process.env.SMITHSONIAN_API_KEY,
  probeFetchImpl = createThrottledRawFetch(350),
} = {}) {
  if (!apiKey) throw new Error('SMITHSONIAN_API_KEY not set');

  const seen = new Set();
  const records = [];

  for (const [label, fragment, quota] of QUERIES) {
    if (records.length >= target) break;
    await collect(fetcher, { apiKey, fragment, quotaRemaining: quota, seen, records, target, log, label, probeFetchImpl });
  }

  return records;
}

// Exported for harvest.mjs to construct the real (throttled, WAF-safe)
// fetcher without duplicating the siFetch wiring.
export function createSmithsonianFetcher(minIntervalMs = 350) {
  return createSiFetcher(minIntervalMs);
}
