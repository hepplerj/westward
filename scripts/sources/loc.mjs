// Library of Congress JSON API (https://www.loc.gov/apis/json-and-yaml/).
// Search results embed derivative image URLs with pixel dimensions as URL
// fragments ("...r.jpg#h=640&w=617"), so no per-item requests are needed.
// Hard limit: 20 JSON requests/minute — the caller passes a fetcher
// throttled to 3500 ms.

import { areRightsOpen } from '../lib/rights.mjs';

// (label, search URL without &c=&sp=, quota) — quotas sum to ~1000.
const QUERIES = [
  ['fsa-ranch', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=ranch&fa=access-restricted:false&fo=json', 150],
  ['fsa-homestead', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=homestead&fa=access-restricted:false&fo=json', 100],
  ['fsa-cattle', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=cattle&fa=access-restricted:false&fo=json', 100],
  ['fsa-farm-plains', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=farm&fa=location:south+dakota&fo=json', 50],
  ['detroit-colorado', 'https://www.loc.gov/collections/detroit-publishing-company/?q=colorado&fo=json', 75],
  ['detroit-wyoming', 'https://www.loc.gov/collections/detroit-publishing-company/?q=wyoming&fo=json', 50],
  ['detroit-montana', 'https://www.loc.gov/collections/detroit-publishing-company/?q=montana&fo=json', 50],
  ['panoramic-ranch', 'https://www.loc.gov/collections/panoramic-photographs/?q=ranch&fo=json', 50],
  ['panoramic-cattle', 'https://www.loc.gov/collections/panoramic-photographs/?q=cattle&fo=json', 25],
  ['curtis', 'https://www.loc.gov/collections/edward-s-curtis/?fo=json', 100],
  ['photos-homesteading', 'https://www.loc.gov/photos/?q=homesteading&fa=online-format:image&fo=json', 75],
  ['photos-sod-house', 'https://www.loc.gov/photos/?q=sod+house&fa=online-format:image&fo=json', 50],
  ['photos-cattle-drive', 'https://www.loc.gov/photos/?q=cattle+drive&fa=online-format:image&fo=json', 50],
  ['photos-chuck-wagon', 'https://www.loc.gov/photos/?q=chuck+wagon&fa=online-format:image&fo=json', 25],
  ['photos-prairie', 'https://www.loc.gov/photos/?q=prairie+settlers&fa=online-format:image&fo=json', 50],
];

export function parseImageUrl(raw) {
  const m = String(raw ?? '').match(/^(.*\.jpg)#h=(\d+)&w=(\d+)$/i);
  if (!m) return null;
  const height = Number(m[2]);
  const width = Number(m[3]);
  if (!width || !height) return null;
  let url = m[1];
  if (url.startsWith('//')) url = `https:${url}`;
  return { url, width, height };
}

function first(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : null;
  return value ? String(value) : null;
}

function toRecord(result) {
  const item = result.item ?? {};
  const images = (result.image_url ?? []).map(parseImageUrl).filter(Boolean)
    .sort((a, b) => a.width - b.width);
  if (!images.length) return null;
  const image = images[images.length - 1];
  if (image.width < 300 && image.height < 300) return null; // thumbnail-only item
  const thumb = images.find((i) => i.width >= 400) ?? image;

  const date = first(result.date) ?? first(item.date);
  if (!areRightsOpen([item.rights_advisory, item.rights_information, result.rights_advisory], date)) return null;

  const sourceUrl = String(result.id ?? result.url ?? '');
  if (!sourceUrl.startsWith('http')) return null;
  const nativeId = sourceUrl.replace(/\/+$/, '').split('/').pop();
  const title = String(result.title ?? '').trim();
  if (!nativeId || !title) return null;

  const subjects = [item.subject_headings ?? result.subject ?? []]
    .flat(2).filter(Boolean).map(String);

  return {
    id: `loc:${nativeId}`,
    title,
    date: date ?? null,
    creator: first(result.contributor) ?? null,
    source: 'Library of Congress',
    sourceUrl,
    imageUrl: image.url,
    thumbUrl: thumb.url,
    width: image.width,
    height: image.height,
    subjects,
  };
}

export function parseSearchPage(json) {
  return (json.results ?? []).map(toRecord).filter(Boolean);
}

export async function harvestLoc(fetcher, { target = 1000, log = console.error } = {}) {
  const seen = new Set();
  const records = [];
  for (const [label, baseUrl, quota] of QUERIES) {
    if (records.length >= target) break;
    let kept = 0;
    for (let page = 1; kept < quota && page <= 5; page++) {
      let json;
      try {
        json = await fetcher.fetchJson(`${baseUrl}&c=100&sp=${page}&at=results,pagination`);
      } catch (err) {
        log(`loc:${label} page ${page} failed: ${err.message}`);
        break;
      }
      const pageRecords = parseSearchPage(json);
      for (const r of pageRecords) {
        if (kept >= quota || records.length >= target) break;
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        records.push(r);
        kept++;
      }
      if (!json.pagination?.next) break;
    }
    log(`loc:${label} kept ${kept}`);
  }
  return records;
}
