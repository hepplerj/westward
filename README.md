# Westward

Live at [westward.jasonheppler.org](https://westward.jasonheppler.org).

An endless, full-screen scroll of public domain photographs of the American
West — homesteading, ranching, frontier life drawn from the Library of
Congress, the Portal to Texas History, SMU's DeGolyer Library, the
Digital Public Library of America, and the Smithsonian.

Static site: `index.html` + `style.css` + `app.js` + `data/`.

## Refreshing the data

    npm run harvest        # full harvest (~1,000–1,500 records depending on source keep-rates, <30 min)
    npm run harvest:quick  # small harvest for development
    npm run check-images   # spot-check that harvested image URLs still serve

Images are hotlinked from the holding institutions and never rehosted.
Only public-domain / no-known-restrictions items are kept (see
`scripts/lib/rights.mjs`). The harvester throttles to each institution's
published limits — do not lower the LOC interval below 3.5 s.

The DPLA and Smithsonian sources each need an API key. DPLA keys are
self-service at
[pro.dp.la/developers/policies#api-key](https://pro.dp.la/developers/policies#api-key);
Smithsonian keys are self-service at
[api.data.gov/signup](https://api.data.gov/signup/) (registered keys allow
1,000 requests/hour). Create a `.env` file in the repository root with:

    DPLA_API_KEY=your-key-here
    SMITHSONIAN_API_KEY=your-key-here

`.env` is gitignored and never committed. If either key is unset, the
harvester logs `dpla: skipped (no DPLA_API_KEY)` and/or
`smithsonian: skipped (no SMITHSONIAN_API_KEY)` and continues with the
remaining sources — a missing key is not an error.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-23-western-explorer-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-western-explorer.md`
