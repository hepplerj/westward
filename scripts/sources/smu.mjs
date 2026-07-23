// SMU DeGolyer Library (CONTENTdm). Search via the /digital/api/search JSON
// endpoint; per-item metadata via dmwebservices dmGetItemInfo; dimensions via
// the IIIF Image API info.json. Collections: wes (U.S. West), rwy (Railroads).
//
// Field nicknames reconciled against a live dmGetCollectionFieldInfo/{wes,rwy}
// call (both collections share the same schema): title/date/creato/rights are
// as guessed, but there is no subjec/copyri/copyright/usage/photog/dated
// nickname in either collection. Subjects live in `author` (the "Authorized
// Subject Terms" field) and `keywor` ("Keywords"); both are combined.
//
// Rights: every sampled item's `rights` field carries one of two site-wide
// DeGolyer citation disclaimers (differing only in whether they mention a
// possible copyright and a paid high-res reproduction fee) - never a
// per-item rights determination, and never matching the "open" rights regex.
// Treating it as a real veto would silently drop every SMU item regardless
// of age, so - mirroring the Portal to Texas History module's handling of
// its generic terms-of-use `license` - the known boilerplate sentences are
// stripped out of the rights text before it is handed to areRightsOpen
// (rather than discarding the whole field on any substring match); any
// residual text - e.g. a genuine per-item restriction appended after the
// boilerplate - still goes through the normal veto evaluation. With no
// residual text, the item falls back to the <=1930 date rule.
//
// restrictionCode: dmGetItemInfo also returns a system field
// `restrictionCode` (not a customizable metadata field - it is absent from
// dmGetCollectionFieldInfo/{wes,rwy}, which only lists descriptive-metadata
// nicknames). CONTENTdm's own API docs and third-party references
// (OCLC help.oclc.org, the pycdm and DigDC API docs) do not define its
// semantics; empirically it is CONTENTdm's item-level IP/user access-control
// flag (see OCLC's "Set item permissions" docs), not a rights/copyright
// determination. Sampled live across both harvested collections - 14 `wes`
// items (dates ranging ca. 1870-1913) and 8 `rwy` items (dates ranging
// 1940s-1947), spanning both boilerplate templates - restrictionCode was
// "1" on every single item with zero variation, uncorrelated with rights
// text, date, or item type. A constant value carries no discriminating
// power, so it is not read or used here.

import { areRightsOpen } from '../lib/rights.mjs';

const BASE = 'https://digitalcollections.smu.edu';
const SEARCHES = [
  ['wes', 'cowboy', 40],
  ['wes', 'ranch', 40],
  ['wes', 'cattle', 30],
  ['rwy', 'railroad', 40],
];

// Known site-wide DeGolyer citation-disclaimer sentences, matched and
// stripped individually (rather than vetoing the whole field on any
// substring match) so any genuinely appended per-item restriction survives
// into the residual text that areRightsOpen evaluates.
const BOILERPLATE_SENTENCES = [
  /this item may be protected by copyright law\.?/gi,
  /please cite degolyer library, southern methodist university as the source of this file\.?/gi,
  /a high-resolution version of this file may be obtained for a fee\.\s*for details,? see the https:\/\/www\.smu\.edu\/libraries\/degolyer\/using\/images web page\.?/gi,
  /for more information,? contact degolyer@smu\.edu\.?/gi,
];

// Strip every known boilerplate sentence out of a rights string and return
// whatever text (if any) is left over, trimmed. An empty result means the
// field carried nothing beyond the standard disclaimer.
function stripBoilerplate(rightsText) {
  let residual = rightsText;
  for (const re of BOILERPLATE_SENTENCES) residual = residual.replace(re, ' ');
  return residual.replace(/\s+/g, ' ').trim();
}

export function parseSearchItems(json) {
  return (json.items ?? [])
    .map((it) => ({
      alias: String(it.collectionAlias ?? it.alias ?? 'wes').replace(/^\//, ''),
      itemId: Number(it.itemId ?? it.id),
    }))
    .filter((it) => it.alias && Number.isInteger(it.itemId) && it.itemId >= 0);
}

// CONTENTdm field nicknames are truncated and collection-specific; read the
// confirmed spellings defensively. Missing fields come back as {} in some
// responses, hence the object check.
function field(itemInfo, ...names) {
  for (const name of names) {
    const v = itemInfo?.[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

// Subjects come from two separate controlled fields rather than one
// pipe/semicolon "subject" field; both use "; " as their internal delimiter.
function subjectsOf(itemInfo) {
  const parts = [field(itemInfo, 'author'), field(itemInfo, 'keywor')].filter(Boolean);
  return parts.flatMap((s) => s.split(';').map((v) => v.trim()).filter(Boolean));
}

export function buildRecord({ alias, itemId, itemInfo, imageInfo }) {
  const srcWidth = Number(imageInfo?.width);
  const srcHeight = Number(imageInfo?.height);
  if (!srcWidth || !srcHeight) return null;

  const title = field(itemInfo, 'title');
  if (!title) return null;

  const date = field(itemInfo, 'date', 'datea');
  // `rights` is the only rights-ish nickname in the wes/rwy schema. The
  // site-wide DeGolyer disclaimer sentences are stripped out (per the header
  // note above); only genuine residual text, if any, is evaluated as a
  // rights field.
  const rawRights = field(itemInfo, 'rights');
  const residualRights = rawRights ? stripBoilerplate(rawRights) : '';
  const rightsFields = residualRights ? [residualRights] : [];
  if (!areRightsOpen(rightsFields, date)) return null;

  // We link the 1024px-wide IIIF derivative, so store its dimensions.
  const width = Math.min(1024, srcWidth);
  const height = Math.round(srcHeight * (width / srcWidth));

  return {
    id: `smu:${alias}:${itemId}`,
    title,
    date,
    creator: field(itemInfo, 'creato'),
    source: 'SMU DeGolyer Library',
    sourceUrl: `${BASE}/digital/collection/${alias}/id/${itemId}`,
    imageUrl: `${BASE}/digital/iiif/${alias}/${itemId}/full/1024,/0/default.jpg`,
    thumbUrl: `${BASE}/digital/iiif/${alias}/${itemId}/full/640,/0/default.jpg`,
    width,
    height,
    subjects: subjectsOf(itemInfo),
  };
}

function imageInfoUrl(alias, itemId) {
  return `${BASE}/digital/iiif/${alias}/${itemId}/info.json`;
}

export async function harvestSmu(fetcher, { target = 150, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [alias, query, quota] of SEARCHES) {
    if (records.length >= target) break;
    let kept = 0;
    let items;
    try {
      items = parseSearchItems(await fetcher.fetchJson(
        `${BASE}/digital/api/search/collection/${alias}/searchterm/${encodeURIComponent(query)}/maxRecords/100`,
      ));
    } catch (err) {
      log(`smu:${alias}/${query} search failed: ${err.message}`);
      continue;
    }
    for (const { alias: itemAlias, itemId } of items) {
      if (kept >= quota || records.length >= target) break;
      const key = `${itemAlias}:${itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let record = null;
      try {
        const itemInfo = await fetcher.fetchJson(
          `${BASE}/digital/bl/dmwebservices/index.php?q=dmGetItemInfo/${itemAlias}/${itemId}/json`,
        );
        const imageInfo = await fetcher.fetchJson(imageInfoUrl(itemAlias, itemId));
        record = buildRecord({ alias: itemAlias, itemId, itemInfo, imageInfo });
      } catch (err) {
        log(`smu:${key} failed: ${err.message}`);
      }
      if (record) {
        records.push(record);
        kept++;
      }
    }
    log(`smu:${alias}/${query} kept ${kept}`);
  }
  return records;
}
