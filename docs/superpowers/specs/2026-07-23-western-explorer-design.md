# Western Explorer — Design

**Date:** 2026-07-23
**Status:** Approved (brainstorming complete)

## Overview

A full-screen, infinite-scroll explorer of American West historical imagery —
homesteading, ranching, farming, frontier photography, plains landscapes —
drawn from open cultural-heritage APIs. Images lazy-load and fade in as you
scroll. Clicking an image opens a full-screen lightbox with attribution and a
link to the source record.

Proof-of-concept scope: no filters yet, but harvest and preserve the subject
metadata that filters (e.g. "homesteading", "ranching", "19th century") will
need later.

## Goals

- An ambient, exhibit-like browsing experience that feels bottomless.
- Pure static site: deployable to GitHub Pages/Netlify with no server, no
  client-side API keys, no build framework.
- Respect institutions: public-domain / no-known-restrictions items only,
  visible attribution, images hotlinked from institutional servers (never
  rehosted), harvest throttled to published rate limits.

## Experience

- **Layout:** masonry columns on a full-screen dark canvas. Native aspect
  ratios preserved; space reserved from harvested width/height so there is no
  layout shift.
- **Infinite scroll:** an IntersectionObserver sentinel near the bottom loads
  the next manifest chunk; images lazy-load and fade in on arrival. When
  manifests are exhausted, loop back to the start (endless by design).
- **Lightbox:** click a tile → photo near-full-screen with title, date,
  institution, and a link to the source record. Arrow keys / swipe navigate;
  Esc closes.
- **Resilience:** any image that 404s is dropped from the grid; broken tiles
  never render.

## Architecture

Two cleanly separated halves.

### 1. Harvest pipeline (build time)

`scripts/harvest.mjs` (Node, no server at runtime; run manually to refresh).

- One module per source: `scripts/sources/loc.mjs`, `texas.mjs`, `smu.mjs`.
  Each returns records already normalized to the common schema below.
- The main script merges, dedupes, filters to open rights, interleaves
  sources for visual variety, shuffles within that interleave, and writes
  `data/manifest-000.json`, `manifest-001.json`, … in chunks of ~100 records.
- Retries failed API pages with backoff; skips malformed records rather than
  dying; logs per-source counts.
- Where a source's search results lack pixel dimensions, the harvester reads
  them from the item's IIIF `info.json`.

### 2. Site (runtime)

`index.html` + `style.css` + `app.js` — zero dependencies, no build step.
Fetches manifest chunks, renders masonry, handles lazy load/fade, lightbox.

## Data schema

Every record, regardless of source:

```json
{
  "id": "loc:2017762891",
  "title": "Daniel Freeman homestead, Beatrice, Nebraska",
  "date": "1887",
  "creator": "Solomon D. Butcher",
  "source": "Library of Congress",
  "sourceUrl": "https://www.loc.gov/item/2017762891/",
  "imageUrl": "https://tile.loc.gov/storage-services/service/pnp/.../v.jpg",
  "thumbUrl": "https://tile.loc.gov/storage-services/service/pnp/.../r.jpg",
  "width": 987,
  "height": 1024,
  "subjects": ["Homesteading--Nebraska", "Frontier and pioneer life"]
}
```

`width`/`height` are required (masonry depends on them). `subjects` is kept
for future filters even though the PoC has none.

## Sources (verified 2026-07-22/23 by live API calls)

No API keys required for any PoC source.

### Library of Congress — backbone (~1,000 of ~1,500 images)

- JSON API: `https://www.loc.gov/{endpoint}/?fo=json`. No key.
- Harvest from collections dense in western material, all blanket
  "no known restrictions": FSA/OWI black-and-white negatives, Detroit
  Publishing Company, Panoramic Photographs, Edward S. Curtis. Supplement
  with keyword searches (homesteading, ranch, cattle, sod house, prairie…)
  over `/photos/` with `fa=online-format:image`.
- Search results embed derivative image URLs with dimensions as URL
  fragments (`...r.jpg#h=640&w=617`) — no per-item requests needed.
  Store the `v.jpg` (~1024px) as `imageUrl`, `r.jpg` (~640px) as `thumbUrl`;
  fall back to `r.jpg` for both when `v` is absent.
- Rights: keep only records whose `rights_advisory`/`rights_information`
  contains "No known restrictions" (also pass `fa=access-restricted:false`).
  As implemented, this is the same shared rule used by every source (see
  `scripts/lib/rights.mjs`): each rights-labeled field is evaluated on its
  own and a restrictive field vetoes the record even if another field is
  open (per-field veto semantics), and — the fallback this bullet omits —
  a record with no rights statement at all is still kept when its date is
  1930 or earlier (public domain by date), not dropped outright. Do not
  "fix" the code back to a strict "must contain the phrase" rule; the
  fallback is intentional.
- Subjects: LCSH `subject_headings` copied into `subjects`.
- **Rate limit: 20 JSON requests/minute; blocked 1 hour if exceeded.**
  Throttle to ~1 request per 3.5s; handle 429/520/Cloudflare-HTML responses
  with backoff. Image servers allow 150 req/min.

### Portal to Texas History (UNT) — ~350 images

- No key. OpenSearch/OAI-PMH for discovery; IIIF for images.
- IIIF manifest at `{ark-url}/manifest/` supplies canvas width/height;
  image via `https://texashistory.unt.edu/iiif/ark:/67531/{id}/m1/1/full/{w},/0/default.jpg`.
- CORS `*`, hotlink-verified. Rights are per-item in the `untl` OAI format —
  filter post-harvest to open/no-known-restrictions statements.
- Queries: ranching, cattle drives, windmills, homesteads, railroads.

### SMU DeGolyer Library — ~150 images

- CONTENTdm, no key. Search:
  `digitalcollections.smu.edu/digital/api/search/collection/{alias}/searchterm/{q}/maxRecords/N`
  over the **U.S. West** (`wes`) and **Railroads** (`rwy`) collections.
- IIIF Image API verified: `/digital/iiif/{alias}/{id}/info.json` gives
  width/height; hotlinking works with or without referer.
- Elite 19th-century photographers (W.H. Jackson, Watkins, A.J. Russell,
  Haynes, Curtis). Mostly public domain; check per-item rights fields via
  `dmwebservices` metadata and keep only open statements.

### Deferred to phase 2 (with reasons)

- **Smithsonian Open Access** — free instant key, but only ~hundreds of
  on-theme CC0-media images; good variety add later.
- **DPLA** — one key + one schema subsumes Denver Public Library, Calisphere
  (incl. Autry), Montana, and Wyoming collections; best expansion path, but
  records are thumbnail-only with no dimensions, which fights the masonry.
- **NARA** — vast public-domain western holdings; key by email, WAF-fronted
  flaky API, no dimensions.
- **Yale Beinecke Western Americana** — superb content; requires writing a
  Linked Art graph walker.
- **No direct API (reachable only via DPLA):** Denver Public Library
  (Recollect), Autry, Amon Carter, Calisphere (its own API was retired 2024).

## Error handling

- Harvest: per-page retry with backoff; malformed/rights-unclear records
  skipped and counted; run summary printed (kept/skipped per source).
- Site: image `onerror` removes the tile; manifest fetch failure retries
  once, then stops loading quietly (already-rendered grid keeps working).

## Testing & verification

- Harvest verified by running it for real, then a validation pass over the
  output: every record has imageUrl, positive width/height, open rights, and
  a spot-check that sampled image URLs return HTTP 200 image/*.
- Site verified in the browser against real harvested data (scroll, fade,
  lightbox, keyboard nav, 404-tile handling). Visual PoC → browser
  verification over unit tests.

## PoC scale

~1,500 images (≈15 manifest chunks). LOC ~1,000 / Texas ~350 / SMU ~150.
Harvest runtime dominated by LOC throttling; estimated well under 30 minutes.

## Out of scope (PoC)

Filters UI, search, DPLA/Smithsonian/NARA/Yale sources, service worker /
offline caching, analytics, image rehosting.
