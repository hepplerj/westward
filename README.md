# Westward

*(repo: western-explorer)*

An endless, full-screen scroll of public-domain photographs of the American
West — homesteading, ranching, frontier life — drawn from the Library of
Congress, the Portal to Texas History, and SMU's DeGolyer Library.

Static site: `index.html` + `style.css` + `app.js` + `data/`. No build step,
no dependencies. Deploy by serving the repository root (GitHub Pages,
Netlify, `python3 -m http.server`).

## Refreshing the data

    npm run harvest        # full harvest (~1,000–1,500 records depending on source keep-rates, <30 min)
    npm run harvest:quick  # small harvest for development
    npm run check-images   # spot-check that harvested image URLs still serve

Images are hotlinked from the holding institutions and never rehosted.
Only public-domain / no-known-restrictions items are kept (see
`scripts/lib/rights.mjs`). The harvester throttles to each institution's
published limits — do not lower the LOC interval below 3.5 s.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-23-western-explorer-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-western-explorer.md`
