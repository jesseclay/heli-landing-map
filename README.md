# Helicopter Landing Map

Where a private (Part 91) helicopter can and can't land anywhere in **Texas** and around **Blacksburg, Virginia**. Every
Texas city is colored by what its code says about landings (banned, permit needed, no rule, or not checked yet), so the
answer reads at a glance; click any spot, or search an address, to see a verdict, every rule that applies there, who
enforces it, the maximum penalty for a prohibited landing, and who owns the land.

**Live site:** https://jesseclay.github.io/heli-landing-map/

Links to a spot work: the address bar updates as you click (for example `#texas/30.30500,-97.72920`; old `#austin/…`
links open the Texas map).

This is a planning aid, not legal advice or a preflight briefing. Boundaries are simplified, and the map has no live
TFRs or NOTAMs.

## How it's built

The site is static: `docs/` is served by GitHub Pages. `docs/index.html` holds the page, the rules for each state and
the app; each region's map data loads from `docs/data/<region>.js`. Texas is too big for one file, so `texas.js` holds
what the state view shows (city limits, counties, airspace, airports, highways, land of a square mile or more, big
lakes) and the smaller land, water and roads load from `docs/data/texas/<lon>_<lat>.js`, one per 1° square, once the
map is zoomed in over it or a spot in it is checked. Austin's zoning loads from `texas-zoning.js` near Austin.

```
src/app.html       page markup and styles
src/app.js         the map, the spot check, search and the reference tabs
src/regions.js     per-region settings: view, cities and the rule each one gets, examples
src/rules.js       Texas rules, penalties, checklist and sources
src/rules_va.js    Virginia rules, penalties, checklist and sources
src/cities_tx.json the researched Texas cities' landing rules, keyed by Census GEOID
scripts/fetch_region.mjs  downloads a region's public data into raw/<region>/, a page at a time
scripts/build_data.mjs    turns raw/<region>/ into docs/data/<region>.js (and Texas's squares and zoning)
scripts/merge_cities.mjs  merges city-code research batches into src/cities_tx.json
scripts/assemble.mjs      writes docs/index.html (and test pages under build/)
scripts/cdp_check.mjs     loads the test page in headless Chrome, clicks every example, takes screenshots
```

Rebuild after a change:

```bash
node scripts/fetch_region.mjs texas           # only when refreshing data (Austin zoning too)
node scripts/fetch_region.mjs blacksburg
node scripts/build_data.mjs texas
node scripts/build_data.mjs blacksburg
node scripts/assemble.mjs
python3 -m http.server 8765 --bind 127.0.0.1 --directory build &
node scripts/cdp_check.mjs http://127.0.0.1:8765/test.html build --region texas --shots
```

## Data

- FAA ADDS: Class C and D airspace, special-use airspace, airports and heliports
- US Census TIGER: city and town limits, counties, major roads, water, campuses, correctional facilities
- USGS PAD-US 4.1: parks and protected land; US Forest Service: wilderness boundaries
- EIA power plants; USACE National Inventory of Dams (high-hazard dams)
- City of Austin open data: zoning for every lot
- City codes of ordinances: each Texas city of 10,000 or more people was researched for heliport and landing rules
  (the card says how sure the reading is; smaller towns show as not checked)
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
