# Helicopter Landing Map

Where a private (Part 91) helicopter can and can't land around **Austin, Texas** and **Blacksburg, Virginia**. Click any
spot, or search an address, to see a verdict, every rule that applies there, who enforces it, and the maximum penalty for
a prohibited landing.

**Live site:** https://jesseclay.github.io/heli-landing-map/

Links to a spot work: the address bar updates as you click (for example `#austin/30.30500,-97.72920`).

This is a planning aid, not legal advice or a preflight briefing. Boundaries are simplified, and the map has no live
TFRs or NOTAMs.

## How it's built

The site is static: `docs/` is served by GitHub Pages. `docs/index.html` holds the page, the rules for each state and
the app; each region's map data loads from `docs/data/<region>.js`.

```
src/app.html       page markup and styles
src/app.js         the map, the spot check, search and the reference tabs
src/regions.js     per-region settings: view, cities and the rule each one gets, examples
src/rules.js       Texas rules, penalties, checklist and sources
src/rules_va.js    Virginia rules, penalties, checklist and sources
scripts/fetch_region.sh   downloads a region's public data into raw/<region>/
scripts/build_data.mjs    turns raw/<region>/ into docs/data/<region>.js
scripts/assemble.mjs      writes docs/index.html (and test pages under build/)
scripts/cdp_check.mjs     loads the test page in headless Chrome, clicks every example, takes screenshots
```

Rebuild after a change:

```bash
scripts/fetch_region.sh austin -98.95,29.55,-96.85,31.25          # only when refreshing data
MIN_WATER_M2=150000 scripts/fetch_region.sh blacksburg -81.05,36.80,-79.70,37.55
node scripts/build_data.mjs austin
node scripts/build_data.mjs blacksburg
node scripts/assemble.mjs
node scripts/cdp_check.mjs build/test.html build --shots
```

## Data

- FAA ADDS: Class C and D airspace, special-use airspace, airports and heliports
- US Census TIGER: city and town limits, counties, major roads, water, campuses, correctional facilities
- USGS PAD-US 4.1: parks and protected land; US Forest Service: wilderness boundaries
- EIA power plants; USACE National Inventory of Dams (high-hazard dams)
- City of Austin open data: zoning for every lot
- Address search runs in the browser against OpenStreetMap's Nominatim, falling back to Photon
- Landowners: clicking a spot asks a public parcel service, live, for the parcel under the pin (owner of record, mailing
  address, size, parcel ID) and outlines it; zoomed in, the map draws property lines (and, in Texas, owner names on
  tracts big enough to hold them). Nothing about owners is stored in the site. Texas uses TxGIO's statewide StratMap
  parcels, compiled from every county appraisal district's roll; Virginia uses VGIN's statewide parcels for lines and
  parcel IDs, and each county's or city's own service for owners where it publishes one. A spot that no parcel covers
  is treated as road or other right-of-way. These lookups run only where the page can reach the services (the
  website, not a sandboxed preview); `scripts/cdp_owner.mjs` tests them against a local server with names masked

The rules and penalties come from the statutes, regulations and local codes cited on each card and listed under
"Before you land".
