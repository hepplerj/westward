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
  // Source-expansion round (2026-07-27): stereographs + more western themes.
  ['stereo-cowboy', 'https://www.loc.gov/collections/stereograph-cards/?q=cowboy&fo=json', 75],
  ['stereo-ranch', 'https://www.loc.gov/collections/stereograph-cards/?q=ranch&fo=json', 75],
  ['stereo-mining', 'https://www.loc.gov/collections/stereograph-cards/?q=mining+camp&fo=json', 50],
  ['detroit-california', 'https://www.loc.gov/collections/detroit-publishing-company/?q=california&fo=json', 75],
  ['detroit-new-mexico', 'https://www.loc.gov/collections/detroit-publishing-company/?q=new+mexico&fo=json', 50],
  ['detroit-texas', 'https://www.loc.gov/collections/detroit-publishing-company/?q=texas&fo=json', 50],
  ['fsa-sheep', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=sheep+herder&fa=access-restricted:false&fo=json', 50],
  ['fsa-rodeo', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=rodeo&fa=access-restricted:false&fo=json', 50],
  ['fsa-dust', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?q=dust+storm&fa=access-restricted:false&fo=json', 50],
  ['panoramic-harvest', 'https://www.loc.gov/collections/panoramic-photographs/?q=harvest&fo=json', 40],
  ['photos-covered-wagon', 'https://www.loc.gov/photos/?q=covered+wagon&fa=online-format:image&fo=json', 40],
  ['photos-gold-mining', 'https://www.loc.gov/photos/?q=gold+mining&fa=online-format:image&fo=json', 40],
  // Vocabulary-expansion round (2026-07-28): Native nations. Modern names +
  // LCSH umbrella; no ceremony-targeted queries (owner's editorial policy).
  ['photos-indians-na', 'https://www.loc.gov/photos/?q=Indians+of+North+America&fa=online-format:image&fo=json', 100],
  ['photos-sioux', 'https://www.loc.gov/photos/?q=Sioux&fa=online-format:image&fo=json', 40],
  ['photos-lakota', 'https://www.loc.gov/photos/?q=Lakota&fa=online-format:image&fo=json', 25],
  ['photos-cheyenne', 'https://www.loc.gov/photos/?q=Cheyenne&fa=online-format:image&fo=json', 30],
  ['photos-comanche', 'https://www.loc.gov/photos/?q=Comanche&fa=online-format:image&fo=json', 25],
  ['photos-apache', 'https://www.loc.gov/photos/?q=Apache&fa=online-format:image&fo=json', 35],
  ['photos-navajo', 'https://www.loc.gov/photos/?q=Navajo&fa=online-format:image&fo=json', 40],
  ['photos-hopi', 'https://www.loc.gov/photos/?q=Hopi&fa=online-format:image&fo=json', 30],
  ['photos-pueblo', 'https://www.loc.gov/photos/?q=Pueblo&fa=online-format:image&fo=json', 40],
  ['photos-crow', 'https://www.loc.gov/photos/?q=Crow+Indians&fa=online-format:image&fo=json', 25],
  ['photos-blackfeet', 'https://www.loc.gov/photos/?q=Blackfeet&fa=online-format:image&fo=json', 25],
  ['photos-ute', 'https://www.loc.gov/photos/?q=Ute+Indians&fa=online-format:image&fo=json', 20],
  ['photos-shoshone', 'https://www.loc.gov/photos/?q=Shoshone&fa=online-format:image&fo=json', 25],
  ['photos-arapaho', 'https://www.loc.gov/photos/?q=Arapaho&fa=online-format:image&fo=json', 20],
  ['photos-kiowa', 'https://www.loc.gov/photos/?q=Kiowa&fa=online-format:image&fo=json', 20],
  ['photos-osage', 'https://www.loc.gov/photos/?q=Osage&fa=online-format:image&fo=json', 20],
  ['photos-nez-perce', 'https://www.loc.gov/photos/?q=Nez+Perce&fa=online-format:image&fo=json', 25],
  ['photos-pawnee', 'https://www.loc.gov/photos/?q=Pawnee&fa=online-format:image&fo=json', 20],
  // African American West: proper nouns over period vocabulary.
  ['photos-buffalo-soldiers', 'https://www.loc.gov/photos/?q=Buffalo+Soldiers&fa=online-format:image&fo=json', 30],
  ['photos-exodusters', 'https://www.loc.gov/photos/?q=Exodusters&fa=online-format:image&fo=json', 15],
  ['photos-nicodemus', 'https://www.loc.gov/photos/?q=Nicodemus+Kansas&fa=online-format:image&fo=json', 15],
  // Latino / Hispanic / Mexican West.
  ['photos-vaquero', 'https://www.loc.gov/photos/?q=vaquero&fa=online-format:image&fo=json', 25],
  ['photos-adobe', 'https://www.loc.gov/photos/?q=adobe&fa=online-format:image&fo=json', 40],
  ['photos-acequia', 'https://www.loc.gov/photos/?q=acequia&fa=online-format:image&fo=json', 15],
  ['photos-rio-grande', 'https://www.loc.gov/photos/?q=Rio+Grande&fa=online-format:image&fo=json', 30],
  ['detroit-mission', 'https://www.loc.gov/collections/detroit-publishing-company/?q=mission&fo=json', 40],
  // Chinese railroad labor (Central Pacific construction era).
  ['photos-central-pacific', 'https://www.loc.gov/photos/?q=Central+Pacific&fa=online-format:image&fo=json', 20],
  // Work, water, settlement themes.
  ['photos-irrigation', 'https://www.loc.gov/photos/?q=irrigation&fa=online-format:image&fo=json', 40],
  ['photos-windmill', 'https://www.loc.gov/photos/?q=windmill&fa=online-format:image&fo=json', 30],
  ['photos-land-office', 'https://www.loc.gov/photos/?q=land+office&fa=online-format:image&fo=json', 20],
  ['photos-roundup', 'https://www.loc.gov/photos/?q=roundup&fa=online-format:image&fo=json', 25],
  ['photos-sheep-shearing', 'https://www.loc.gov/photos/?q=sheep+shearing&fa=online-format:image&fo=json', 20],
  ['photos-threshing', 'https://www.loc.gov/photos/?q=threshing&fa=online-format:image&fo=json', 25],
  ['photos-grain-elevator', 'https://www.loc.gov/photos/?q=grain+elevator&fa=online-format:image&fo=json', 20],
  ['photos-stagecoach', 'https://www.loc.gov/photos/?q=stagecoach&fa=online-format:image&fo=json', 30],
  ['photos-wagon-train', 'https://www.loc.gov/photos/?q=wagon+train&fa=online-format:image&fo=json', 25],
  ['photos-dugout', 'https://www.loc.gov/photos/?q=dugout+house&fa=online-format:image&fo=json', 20],
  // Fauna & spectacle: "bison" not "buffalo" (Buffalo, N.Y.); "wild horses"
  // not "mustang" (the P-51 aircraft photographs).
  ['photos-bison', 'https://www.loc.gov/photos/?q=bison&fa=online-format:image&fo=json', 25],
  ['photos-longhorn', 'https://www.loc.gov/photos/?q=longhorn&fa=online-format:image&fo=json', 20],
  ['photos-wild-horses', 'https://www.loc.gov/photos/?q=wild+horses&fa=online-format:image&fo=json', 20],
  ['photos-rodeo', 'https://www.loc.gov/photos/?q=rodeo&fa=online-format:image&fo=json', 30],
  ['photos-frontier-days', 'https://www.loc.gov/photos/?q=Frontier+Days&fa=online-format:image&fo=json', 20],
  // State scopes on thematically strong collections (see triage discussion:
  // bare state queries are thematically indiscriminate; scoped ones aren't).
  ['fsa-new-mexico', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?fa=location:new+mexico&fo=json', 40],
  ['fsa-arizona', 'https://www.loc.gov/collections/fsa-owi-black-and-white-negatives/?fa=location:arizona&fo=json', 30],
  ['detroit-utah', 'https://www.loc.gov/collections/detroit-publishing-company/?q=utah&fo=json', 40],
  ['detroit-arizona', 'https://www.loc.gov/collections/detroit-publishing-company/?q=arizona&fo=json', 40],
  ['detroit-idaho', 'https://www.loc.gov/collections/detroit-publishing-company/?q=idaho&fo=json', 25],
  ['detroit-nevada', 'https://www.loc.gov/collections/detroit-publishing-company/?q=nevada&fo=json', 25],
  ['panoramic-montana', 'https://www.loc.gov/collections/panoramic-photographs/?q=montana&fo=json', 25],
  ['stereo-dakota', 'https://www.loc.gov/collections/stereograph-cards/?q=dakota&fo=json', 30],
  ['stereo-yellowstone', 'https://www.loc.gov/collections/stereograph-cards/?q=yellowstone&fo=json', 30],
  ['stereo-yosemite', 'https://www.loc.gov/collections/stereograph-cards/?q=yosemite&fo=json', 30],
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
