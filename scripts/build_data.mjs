// Builds one region's compact data bundle for the helicopter landing map from the files fetch_region.sh saved.
// Usage: node scripts/build_data.mjs <region>   (reads raw/<region>/, writes docs/data/<region>.js)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REGION = process.argv[2] || 'austin';
const RAW = path.join(ROOT, 'raw', REGION);
const OUT = path.join(ROOT, 'docs', 'data', `${REGION}.js`);
const read = (p) => JSON.parse(fs.readFileSync(path.join(RAW, p), 'utf8'));
const exists = (p) => fs.existsSync(path.join(RAW, p));

// ---------- geometry helpers ----------
function sqSegDist(p, a, b, kx) {
  let x = a[0] * kx, y = a[1], dx = b[0] * kx - x, dy = b[1] - y;
  const px = p[0] * kx, py = p[1];
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0] * kx; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x; dy = py - y;
  return dx * dx + dy * dy;
}
function simplify(pts, tol) {
  if (pts.length <= 4 || tol <= 0) return pts;
  const kx = Math.cos((pts[0][1] * Math.PI) / 180);
  const sq = tol * tol;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [f, l] = stack.pop();
    let max = 0, idx = -1;
    for (let i = f + 1; i < l; i++) {
      const d = sqSegDist(pts[i], pts[f], pts[l], kx);
      if (d > max) { max = d; idx = i; }
    }
    if (max > sq) { keep[idx] = 1; stack.push([f, idx], [idx, l]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// Delta-encode a ring/line as integers at 1e5 (about 1 m).
function enc(pts) {
  const out = [];
  let px = 0, py = 0;
  for (const [x, y] of pts) {
    const ix = Math.round(x * 1e5), iy = Math.round(y * 1e5);
    if (out.length && ix === px && iy === py) continue;
    out.push(ix - px, iy - py);
    px = ix; py = iy;
  }
  return out;
}
function ringsOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}
function ringArea(r) { // rough planar area in deg^2
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
function encPolys(geom, tol, minArea = 0) {
  // returns [[ring, hole, ...], ...] per polygon, encoded
  const polys = [];
  for (const poly of ringsOf(geom)) {
    const outer = simplify(poly[0], tol);
    if (outer.length < 4 || ringArea(outer) < minArea) continue;
    const rings = [enc(outer)];
    for (const hole of poly.slice(1)) {
      const h = simplify(hole, tol);
      if (h.length >= 4 && ringArea(h) >= minArea) rings.push(enc(h));
    }
    polys.push(rings);
  }
  return polys;
}
function bboxOf(geom) {
  let a = [1e9, 1e9, -1e9, -1e9];
  const w = (c) => Array.isArray(c[0]) ? c.forEach(w) : (a = [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[0]), Math.max(a[3], c[1])]);
  w(geom.coordinates);
  return a;
}
function pip(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function inGeom(pt, geom) {
  return ringsOf(geom).some((poly) => pip(pt, poly[0]) && !poly.slice(1).some((h) => pip(pt, h)));
}
function centroidish(geom) {
  // point on the largest outer ring: average of its vertices, nudged inside if needed
  let best = null, bestA = -1;
  for (const poly of ringsOf(geom)) { const a = ringArea(poly[0]); if (a > bestA) { bestA = a; best = poly[0]; } }
  if (!best) return null;
  let sx = 0, sy = 0;
  for (const p of best) { sx += p[0]; sy += p[1]; }
  let c = [sx / best.length, sy / best.length];
  if (!pip(c, best)) c = best[Math.floor(best.length / 2)];
  return c;
}
const r5 = (n) => Math.round(n * 1e5) / 1e5;
const dms = (s) => { // "30-11-40.2980N" -> decimal
  const m = /^(\d+)-(\d+)-([\d.]+)([NSEW])$/.exec(s.trim());
  if (!m) return Number(s);
  const v = +m[1] + m[2] / 60 + m[3] / 3600;
  return m[4] === 'S' || m[4] === 'W' ? -v : v;
};
const title = (s) => (s || '').toLowerCase().replace(/(^|[\s\-/(.])([a-z])/g, (m, a, c) => a + c.toUpperCase())
  .replace(/\b(Aaf|Ahp|Arng|Lz|Vip|Sts|Mgm|Lyj|Jej|Hbr|Crc|Gw|Tow|Lqlz|Bh|Ii|Iii|Tx|Va|Aap)\b/g, (w) => w.toUpperCase());
const STATE_FIPS = { '05': 'AR', 22: 'LA', 35: 'NM', 40: 'OK', 48: 'TX', 51: 'VA', 54: 'WV' };

// ---------- what differs by region ----------
function austinLandKind(p, c, ctx) {
  const m = p.Mang_Name, t = p.Mang_Type, d = p.Des_Tp, name = p.Unit_Nm || '';
  const who = `${p.Loc_Mang || ''} | ${p.Loc_Own || ''}`;
  if (m === 'DOD' || d === 'MIL') return /Mabry|Swift|National Guard/.test(name) ? 'military_guard' : 'military_federal';
  if (m === 'FWS') return d === 'NWR' ? 'nwr' : 'federal_other';
  if (m === 'NPS') return 'nps';
  if (m === 'USACE' || /Corps of Engineers|Forth Worth/i.test(who)) return 'usace';
  if (m === 'NRCS') return 'easement';
  if (m === 'SPR') return 'state_park';
  if (m === 'SFW') return 'state_wma';
  if (/Balcones Canyonlands Preserve/i.test(name)) return 'bcp';
  if (/Lower Colorado River Authority/i.test(p.Loc_Mang || '')) return 'lcra';
  if (t === 'STAT') return 'state_other';
  if (t === 'FED') return /Park\b/.test(name) ? 'usace' : 'federal_other';
  if (m === 'CITY') {
    if (/Austin/i.test(who) || (c && inGeom(c, ctx.hub._geom) && !/Round Rock|Pflugerville|Cedar Park|Sunset Valley|Rollingwood|West Lake/i.test(who))) {
      return /Water Quality|Conservation Easement|FRPP/i.test(name) || d === 'WPA' || d === 'PCON' ? 'austin_wqpl' : 'park_austin';
    }
    return 'park_city';
  }
  if (m === 'CNTY') return /Travis/i.test(who) ? 'park_travis' : 'park_county';
  if (/ISD/i.test(who)) return 'school';
  if (t === 'DIST' || m === 'REG' || m === 'UNKL') return 'district';
  if (t === 'NGO') return 'ngo';
  if (t === 'PVT') return /Home ?Owners|HOA|Association|Owners Assoc|Community Assoc/i.test(who) ? 'hoa' : 'private_cons';
  return 'unknown';
}
// Texas statewide: Austin's kinds, plus national forests and grasslands (open outside wilderness, as in Virginia)
function texasLandKind(p, c, ctx) {
  if (p.Mang_Name === 'USFS') return 'usfs';
  return austinLandKind(p, c, ctx);
}
// Virginia: national forest is open to landings outside wilderness, which comes from the Forest Service's own
// boundaries; West Virginia's state and local land falls outside the Virginia rules this region applies.
function vaLandKind(p, c, ctx) {
  const m = p.Mang_Name, t = p.Mang_Type, d = p.Des_Tp, name = p.Unit_Nm || '';
  const who = `${p.Loc_Mang || ''} | ${p.Loc_Own || ''}`;
  if (m === 'DOD' || d === 'MIL') return 'military_federal';
  if (m === 'NPS') return 'nps';
  if (m === 'USACE') return 'usace';
  if (m === 'USFS') return 'usfs';
  if (m === 'FWS') return d === 'NWR' ? 'nwr' : 'federal_other';
  if (t === 'FED') return 'federal_other';
  const wv = /\bWV\b|West Virginia/.test(who) || (c && ctx.stateAt(c) === 'WV');
  if (wv) return 'other_state';
  if (/Virginia Polytechnic|Radford University|University of Virginia/i.test(who)) return 'campus_public';
  if (/Natural Area Preserve/i.test(name)) return 'state_nap';
  if (d === 'SP' || /State Park/i.test(name)) return 'state_park';
  if (m === 'SFW' || /Wildlife Management Area|Fish Hatchery/i.test(name)) return 'state_wma';
  if (/Dept of Forestry|State Forest|VA-DOF/i.test(who + name)) return 'state_forest';
  if (/Carvins Cove/i.test(name)) return 'park_city';
  if (/Explore Park/i.test(name)) return 'park_county';
  if (t === 'STAT' || m === 'OTHS' || /VOF Holding|Outdoors Foundation/i.test(name + who)) return 'state_other';
  if (m === 'CITY') return 'park_city';
  if (m === 'CNTY') return 'park_county';
  if (t === 'NGO' || /Conservancy/i.test(who + name)) return 'ngo';
  if (t === 'PVT') return 'private_cons';
  if (/^(LP|LREC|LCA|LHCA|LOTH)$/.test(d)) return c && ctx.places.some((pl) => pl.st === 'VA' && inGeom(c, pl._geom)) ? 'park_city' : 'park_county';
  return 'unknown';
}
// Corps of Engineers reservoirs in Texas, where landing is barred outside designated areas
const TX_USACE_LAKES = /Lk Georgetown|Granger Lk|Canyon Lk|Belton Lk|Stillhouse|Lewisville Lk|Grapevine Lk|Lavon Lk|Ray Roberts|Lk Texoma|Sam Rayburn|B A Steinhagen|Lk Whitney|Waco Lk|Lk Waco|Somerville Lk|Proctor Lk|Hords Creek Lk|O C Fisher|Benbrook Lk|Joe Pool|Aquilla Lk|Navarro Mills|Bardwell Lk|Pat Mayse|Jim Chapman|Cooper Lk|Wright Patman|Lk O' the Pines|Lake O' the Pines/;
const REGION_CFG = {
  texas: {
    state: 'TX',
    bounds: [-106.65, 25.83, -93.5, 36.51],
    hub: 'Austin',
    statewide: true,
    // cities with their own rule card in src/rules.js; the researched cities (src/cities_tx.js) are keyed by GEOID
    cityReg: { Austin: 'austin', 'West Lake Hills': 'wlh', Lakeway: 'lakeway', 'Dripping Springs': 'dripping', 'Horseshoe Bay': 'hsb' },
    cityResearch: 'src/cities_tx.json',
    waterKind: (name, c, b) => {
      const n = name || '';
      if (/Lk Travis|Creek Arm|Lk Buchanan|Inks Lk|Lyndon B Johnson|Lake Marble|Lk Bastrop/.test(n)) return 'lake_lcra';
      if (TX_USACE_LAKES.test(n)) return 'lake_usace';
      if (/Walter E Long/.test(n)) return 'lake_austin_park';
      if (n === 'Colorado Riv' && b[0] < -97.85 && b[2] > -97.75 && b[1] < 30.3 && b[3] > 30.3) return 'lake_austin_city';
      if (/Riv\b|Crk\b/.test(n)) return 'river';
      return 'lake_other';
    },
    landKind: texasLandKind,
    extraLands: [{ n: 'Texas Capitol Complex', k: 'capitol', m: 'State of Texas', a: 0, acc: '', d: 'CAP',
      geom: { type: 'Polygon', coordinates: [[[-97.7438, 30.27248], [-97.74051, 30.28133], [-97.73451, 30.27964], [-97.73792, 30.27083], [-97.7438, 30.27248]]] } }],
    publicCampus: /University of Texas|Univ of Texas|Texas State|Texas A ?& ?M|Texas Tech|Univ of Houston|University of Houston|Univ of North Texas|University of North Texas|Stephen F Austin|Sam Houston State|Lamar Univ|Prairie View|Texas Southern|Angelo State|Midwestern State|Sul Ross|Tarleton|West Texas A|Texas Woman|Community Colg|Community College|Junior Colg|Central Texas College|Blinn|Austin Community/,
    // part-time towers get a pointer to the Chart Supplement; these are the hours where they're known
    towerHours: {
      EDC: 'tower 0700–2200 local, Class E when closed', GTU: 'tower 0700–2200 local, Class E when closed',
      HYI: 'tower 0700–2100 local, Class E when closed', BAZ: 'tower 0700–1900 local, Class G when closed',
      GRK: 'tower continuous', RND: 'tower Mon–Fri 0700–1900, Class E when closed',
    },
    partTimeHours: 'part-time tower: hours in the Chart Supplement, Class E or G when closed',
    towered: 'airspace', // every airport with Class B, C or D airspace has a tower
    stadiums: 'raw/texas/stadiums.json',
    wilderness: 'usfs/wilderness.geojson',
    zoning: true,
    zoningFile: 'texas-zoning',
    clipToState: 'tiger/state.geojson',
  },
  austin: {
    state: 'TX',
    bounds: [-98.95, 29.55, -96.85, 31.25],
    hub: 'Austin',
    cityReg: {
      Austin: 'austin', 'West Lake Hills': 'wlh', Lakeway: 'lakeway', 'Dripping Springs': 'dripping', 'Horseshoe Bay': 'hsb',
      Georgetown: 'zoning', Kyle: 'zoning', Buda: 'zoning', 'Cedar Park': 'zoning', 'Marble Falls': 'zoning', Leander: 'zoning', 'Round Rock': 'zoning',
    },
    waterKind: (name, c, b) => {
      const n = name || '';
      if (/Lk Travis|Creek Arm|Lk Buchanan|Inks Lk|Lyndon B Johnson|Lake Marble|Lk Bastrop/.test(n)) return 'lake_lcra';
      if (/Lk Georgetown|Granger Lk|Canyon Lk|Belton Lk|Stillhouse/.test(n)) return 'lake_usace';
      if (/Walter E Long/.test(n)) return 'lake_austin_park';
      if (n === 'Colorado Riv' && b[0] < -97.85 && b[2] > -97.75 && b[1] < 30.3 && b[3] > 30.3) return 'lake_austin_city';
      if (/Riv|Crk/.test(n)) return 'river';
      return 'lake_other';
    },
    landKind: austinLandKind,
    extraLands: [{ n: 'Texas Capitol Complex', k: 'capitol', m: 'State of Texas', a: 0, acc: '', d: 'CAP',
      geom: { type: 'Polygon', coordinates: [[[-97.7438, 30.27248], [-97.74051, 30.28133], [-97.73451, 30.27964], [-97.73792, 30.27083], [-97.7438, 30.27248]]] } }],
    publicCampus: /University of Texas|Texas State|Central Texas College/,
    towerHours: {
      EDC: 'tower 0700–2200 local, Class E when closed', GTU: 'tower 0700–2200 local, Class E when closed',
      HYI: 'tower 0700–2100 local, Class E when closed', BAZ: 'tower 0700–1900 local, Class G when closed',
      GRK: 'tower continuous', RND: 'tower Mon–Fri 0700–1900, Class E when closed',
    },
    towered: { AUS: 'C', EDC: 'D', GTU: 'D', HYI: 'D', BAZ: 'D', GRK: 'D', RND: 'D', SAT: 'C' },
    stadiums: [
      { n: 'Darrell K Royal–Texas Memorial Stadium', short: 'DKR', ev: 'UT football home games (standing TFR, FDC 0/0367)', cap: 100119, lat: 30.28366, lon: -97.73246 },
      { n: 'Circuit of the Americas', short: 'COTA', ev: 'NASCAR Cup race day (standing TFR); the F1 Grand Prix gets its own TFRs by NOTAM', cap: null, lat: 30.1328, lon: -97.6411 },
    ],
    zoning: true,
  },
  blacksburg: {
    state: 'VA',
    bounds: [-81.05, 36.80, -79.70, 37.55],
    hub: 'Blacksburg',
    cityReg: {
      Blacksburg: 'blacksburg', Christiansburg: 'christiansburg', Radford: 'radford', Roanoke: 'roanoke', Salem: 'salem',
      Pulaski: 'pulaski', Dublin: 'dublin', Pearisburg: 'pearisburg', Vinton: 'vinton', Floyd: 'floyd', Narrows: 'narrows',
    },
    waterKind: (name) => {
      const n = name || '';
      if (/Claytor Lk|Smith Mountain Lk/.test(n)) return 'lake_utility';
      if (/Philpott Lk|Bluestone/.test(n) && !/Riv/.test(n)) return 'lake_usace';
      if (/Riv\b|Crk\b/.test(n)) return 'river';
      return 'lake_other';
    },
    landKind: vaLandKind,
    extraLands: [],
    publicCampus: /Virginia Polytechnic|Virginia Tech|Radford Univ|Concord Univ|Virginia Western|New River Community/,
    towerHours: { ROA: 'tower and approach continuous' },
    towered: { ROA: 'C' },
    stadiums: [
      { n: 'Lane Stadium (Virginia Tech)', short: 'Lane', ev: 'Virginia Tech football home games (standing TFR)', cap: 65632, lat: 37.21995, lon: -80.41803 },
    ],
    wilderness: 'usfs/wilderness.geojson',
    damSkip: /#\s?\d|No\.\s?\d/,
  },
};
const CFG = REGION_CFG[REGION];
if (!CFG) throw new Error(`unknown region ${REGION}`);

// ---------- places (city and town limits) ----------
// a statewide region labels cities by size (t: 3 for 500,000+, 2 for 50,000+, 1 for 10,000+) and gives each city
// whose code was researched its own rule, keyed by its Census GEOID
const popOf = exists('places_pop.json') ? new Map(read('places_pop.json').map((r) => [r.fips, r.p])) : null;
const research = CFG.cityResearch && fs.existsSync(path.join(ROOT, CFG.cityResearch)) ? JSON.parse(fs.readFileSync(path.join(ROOT, CFG.cityResearch), 'utf8')) : [];
const researched = new Set(research.filter((r) => r.level).map((r) => r.fips));
const places = read('tiger/places.geojson').features.map((f) => {
  const p = f.properties;
  const n = p.NAME.replace(/ (city|town|village)$/, '');
  const st = STATE_FIPS[String(p.GEOID).slice(0, 2)] || '';
  const pop = popOf ? popOf.get(String(p.GEOID)) || 0 : 0;
  return {
    reg: st && st !== CFG.state ? 'other_state' : (CFG.cityReg[n] || (researched.has(String(p.GEOID)) ? String(p.GEOID) : '')),
    n, st, ...(popOf ? { t: pop >= 500000 ? 3 : pop >= 50000 ? 2 : pop >= 10000 ? 1 : 0 } : {}),
    lsad: (p.NAME.match(/ (city|town|village)$/) || [, 'city'])[1],
    l: [r5(+p.INTPTLAT), r5(+p.INTPTLON)],
    g: encPolys(f.geometry, 0.00025, 1e-8),
    _geom: f.geometry,
  };
});
const hub = places.find((p) => p.n === CFG.hub);

// ---------- counties (Virginia's independent cities are county-equivalents) ----------
const countyFeats = read('tiger/counties.geojson').features;
const counties = countyFeats.map((f) => ({
  n: f.properties.NAME.replace(/ County$/, '').replace(/ city$/, ''),
  ic: / city$/.test(f.properties.NAME) ? 1 : 0,
  st: STATE_FIPS[String(f.properties.STATE)] || '',
  g: encPolys(f.geometry, 0.0008),
  l: (() => { const c = centroidish(f.geometry); return [r5(c[1]), r5(c[0])]; })(),
}));
const stateAt = (pt) => { const f = countyFeats.find((x) => inGeom(pt, x.geometry)); return f ? STATE_FIPS[String(f.properties.STATE)] : ''; };
// a statewide region keeps only the roads, water and special land that touch the state
const stateGeom = CFG.clipToState ? read(CFG.clipToState).features[0].geometry : null;
const stateBox = stateGeom ? bboxOf(stateGeom) : null;
function touchesState(geom) {
  if (!stateGeom) return true;
  const b = bboxOf(geom);
  if (b[2] < stateBox[0] || b[0] > stateBox[2] || b[3] < stateBox[1] || b[1] > stateBox[3]) return false;
  const pts = [];
  const w = (c) => (Array.isArray(c[0]) ? c.forEach(w) : pts.push(c));
  w(geom.coordinates);
  const step = Math.max(1, Math.floor(pts.length / 12));
  for (let i = 0; i < pts.length; i += step) if (inGeom(pts[i], stateGeom)) return true;
  return inGeom(pts[pts.length - 1], stateGeom);
}

// ---------- roads ----------
const roadName = (n) => (n || '')
  .replace(/^I- ?(\d+).*$/, 'I-$1')
  .replace(/^(N|S|E|W) /, '')
  .replace(/Mo-?Pac Expy|Mopac Expy|State Loop 1\b/i, 'MoPac (Loop 1)')
  .replace(/^State Hwy /, 'SH ').replace(/^US Hwy /, 'US ').replace(/^State Loop /, 'Loop ').replace(/^State Rte /, 'VA ');
const roads = [];
for (const [file, cls, tol] of [['tiger/primary.geojson', 'P', 0.0002], ['tiger/secondary.geojson', 'S', 0.0003]]) {
  for (const f of read(file).features) {
    if (!f.geometry || !touchesState(f.geometry)) continue;
    for (const line of linesOf(f.geometry)) {
      const s = simplify(line, tol);
      if (s.length < 2) continue;
      roads.push({ c: cls, n: roadName(f.properties.NAME), g: enc(s) });
    }
  }
}

// ---------- water ----------
const prettyWater = (n) => (n || '').replace(/^Lk /, 'Lake ').replace(/ Lk$/, ' Lake').replace(/ Riv$/, ' River').replace(/ Crk$/, ' Creek').replace('Lake Lyndon B Johnson', 'Lake LBJ').replace('Lake Marble Fls', 'Lake Marble Falls').replace('Lake Mc Queeney', 'Lake McQueeney');
const water = read('tiger/areahydro.geojson').features.filter((f) => f.geometry && touchesState(f.geometry)).map((f) => {
  const c = centroidish(f.geometry);
  const k = CFG.waterKind(f.properties.NAME, c, bboxOf(f.geometry));
  // ar: area in km², so a statewide map can leave small ponds until it's zoomed in
  const ar = Math.round((f.properties.AREAWATER || 0) / 1e5) / 10;
  return { n: prettyWater(f.properties.NAME) || 'Lake or pond', k, ar, g: encPolys(f.geometry, !CFG.statewide ? 0.00012 : ar >= 20 ? 0.0004 : 0.00018), _c: c };
});

// ---------- protected and public lands (PAD-US, plus wilderness from the Forest Service) ----------
const pad = fs.readdirSync(path.join(RAW, 'padus')).filter((f) => /^fee_\d+\.geojson$/.test(f)).flatMap((f) => read(`padus/${f}`).features);
const ctx = { hub, places, stateAt };
const lands = [];
const skipped = {};
for (const f of pad) {
  const p = f.properties;
  if (!f.geometry) continue;
  if (p.Unit_Nm === 'Lake Travis' && /Lower Colorado/.test(p.Loc_Mang || '')) { skipped.lakeTravis = 1; continue; }
  if ((p.GIS_Acres || 0) < 0.3) { skipped.tiny = (skipped.tiny || 0) + 1; continue; }
  const c = centroidish(f.geometry);
  const k = CFG.landKind(p, c, ctx);
  const big = p.GIS_Acres > 2000;
  const g = encPolys(f.geometry, big ? 0.00015 : 0.00005, 2e-9);
  if (!g.length) { skipped.empty = (skipped.empty || 0) + 1; continue; }
  const mgr = [p.Loc_Mang, p.Loc_Own].find((s) => s && !/^Unknown$/i.test(s)) || '';
  lands.push({
    n: (p.Unit_Nm && p.Unit_Nm !== 'Unknown') ? p.Unit_Nm.replace(/_\d+$/, '') : 'Unnamed protected land',
    k, m: mgr, a: Math.round(p.GIS_Acres), acc: p.Pub_Access, d: p.Des_Tp, g, _c: c,
  });
}
if (CFG.wilderness && exists(CFG.wilderness)) {
  for (const f of read(CFG.wilderness).features) {
    const p = f.properties;
    lands.push({ n: p.wildernessname, k: 'wilderness', m: 'US Forest Service', a: Math.round(p.gis_acres), acc: 'OA', d: 'WA', g: encPolys(f.geometry, 0.0001, 2e-9) });
  }
}
for (const x of CFG.extraLands) { const { geom, ...rest } = x; lands.push({ ...rest, g: encPolys(geom, 0) }); }

// ---------- campuses and correctional facilities (TIGER special land use) ----------
const prettyCampus = (n) => n.replace(/^Univ of Texas$/, 'University of Texas at Austin').replace(/^Virginia Polytechnic Institute and State Univ$/, 'Virginia Tech')
  .replace(/Univ\b/, 'University').replace(/Colg\b/, 'College').replace(/Smry\b/, 'Seminary').replace(/Schl\b/, 'School').replace("Saint Edward's University", "St. Edward's University");
for (const f of read('tiger/colleges.geojson').features) {
  if (!touchesState(f.geometry)) continue;
  const n = prettyCampus(f.properties.NAME);
  lands.push({ n, k: CFG.publicCampus.test(n) || CFG.publicCampus.test(f.properties.NAME) ? 'campus_public' : 'campus_private', m: n, a: Math.round(f.properties.AREALAND / 4047), acc: '', d: 'CAMPUS', g: encPolys(f.geometry, 0.00004) });
}
for (const f of read('tiger/prisons.geojson').features) {
  if (!touchesState(f.geometry)) continue;
  const n = f.properties.NAME.replace(/Complx/, 'Complex').replace(/Ctr\b/g, 'Center').replace(/Corr Faclty/, 'Correctional Facility').replace(/Faclty\b/, 'Facility').replace(/Acdmy/, 'Academy').replace(/Schl/, 'School').replace(/Ofc/, 'Office');
  lands.push({ n, k: 'prison', m: n, a: Math.round(f.properties.AREALAND / 4047), acc: '', d: 'CORR', g: encPolys(f.geometry, 0.00004) });
}

// ---------- airspace ----------
const airspace = [];
for (const f of read('faa/class_airspace2.geojson').features) {
  const p = f.properties;
  if (!/^CLASS_(B|C|D)$/.test(p.LOCAL_TYPE)) continue;
  const cls = p.CLASS;
  const sfc = +p.LOWER_VAL === 0;
  // some areas are listed twice; a Class B's sectors share an ident and floor, so the outline tells them apart
  const key = `${p.IDENT}-${cls}-${p.LOWER_VAL}-${p.UPPER_VAL}-${bboxOf(f.geometry).map((v) => v.toFixed(3)).join(',')}`;
  if (airspace.some((a) => a.key === key)) continue;
  airspace.push({
    key, id: p.IDENT, c: cls, sfc, lo: sfc ? 'SFC' : `${p.LOWER_VAL} MSL`, hi: `${p.UPPER_VAL} MSL`,
    pt: p.WKHR_CODE !== 'H24', hrs: CFG.towerHours[p.IDENT] || (p.WKHR_CODE !== 'H24' && CFG.partTimeHours) || '', n: title(p.NAME), g: encPolys(f.geometry, 0.0004),
  });
}
const sua = [];
for (const f of read('faa/sua.geojson').features || []) {
  const p = f.properties;
  const surface = p.LOWER_CODE === 'SFC' && +p.LOWER_VAL === 0;
  if (!surface || !/^(R|A)$/.test(p.TYPE_CODE)) continue;
  sua.push({ n: p.NAME, t: p.TYPE_CODE, lo: 'SFC', hi: `${p.UPPER_VAL} ${p.UPPER_CODE}`, tm: p.TIMESOFUSE, ag: p.CONT_AGENT || '', g: encPolys(f.geometry, 0.0004) });
}

// ---------- airports and heliports ----------
// every airport with its own Class B, C or D airspace has a tower; Love Field and Hobby sit inside a Class B
const toweredBy = CFG.towered === 'airspace'
  ? Object.assign(Object.fromEntries(airspace.map((a) => [a.id, a.c])), { DAL: 'B', HOU: 'B' })
  : CFG.towered;
const airports = read('faa/airports.geojson').features.map((f) => {
  const p = f.properties;
  return {
    id: p.IDENT, n: title(p.NAME).replace(/\bIntl\b/, 'International').replace(/\bMuni\b/, 'Municipal').replace(/\bRgnl\b/, 'Regional')
      .replace(/\bExec\b/, 'Executive').replace(/\bFld\b/, 'Field').replace(/\bNtl\b/, 'National').replace(/\bMeml\b/, 'Memorial')
      .replace(/^Lago Vista TX\/Rusty Allen$/, 'Lago Vista (Rusty Allen)').replace('Hosital', 'Hospital').replace(/\bCo\b/, 'County').replace(/\bDep\b/, 'Department').replace(/\s+/g, ' '),
    t: p.TYPE_CODE, pub: p.PRIVATEUSE === 0 ? 1 : 0, mil: p.MIL_CODE === 'MIL' ? 1 : 0, city: title(p.SERVCITY),
    lat: r5(dms(p.LATITUDE)), lon: r5(dms(p.LONGITUDE)), el: Math.round(p.ELEVATION), tw: toweredBy[p.IDENT] || '',
    st: p.OPERSTATUS,
  };
}).filter((a) => a.st === 'OPERATIONAL');

// ---------- critical infrastructure ----------
const infra = [];
for (const f of read('eia/plants.geojson').features) {
  const p = f.properties;
  if (!(p.Total_MW >= 10)) continue; // skip rooftop solar and store microgrids
  const [lon, lat] = f.geometry.coordinates;
  infra.push({ k: 'power', n: p.Plant_Name, op: p.Utility_Na, s: p.PrimSource, mw: Math.round(p.Total_MW), lat: r5(lat), lon: r5(lon) });
}
for (const f of read('nid/dams_high.geojson').features) {
  const p = f.properties;
  if (/\b(WS|SCS|NRCS|FRS|Site)\b/i.test(p.NAME || '') || (CFG.damSkip && CFG.damSkip.test(p.NAME || '')) || !(p.NID_HEIGHT >= 40) || p.PRIMARY_OWNER_TYPE === 'Private') continue;
  const [lon, lat] = f.geometry.coordinates;
  infra.push({ k: 'dam', n: title(p.NAME).replace(/\bWs\b/g, 'WS').replace(/\bScs\b/g, 'SCS').replace(/\bNrcs\b/g, 'NRCS').replace(/\bFrs\b/g, 'FRS').replace(/^Lcra /, 'LCRA '), ow: p.PRIMARY_OWNER_TYPE, h: p.NID_HEIGHT, rv: (p.RIVER_OR_STREAM || '').trim(), lat: r5(lat), lon: r5(lon) });
}

// ---------- Austin zoning (City of Austin "Zoning (Large Map Scale)", fetched generalized to about 2 m) ----------
// The base district decides whether a heli-facility permit is possible, so each lot keeps its full zoning string
// and its base code. Lots go out as one base64 varint stream: per lot its type index and ring count, per ring its
// vertex count and the vertices as zigzag deltas carried on from the previous vertex, lots in Morton order so
// neighbors sit together and the deltas stay small.
let zoning = null, zStats = null;
if (CFG.zoning) {
  const ZQ = 5e4; // grid units per degree, about 2 m
  const ZTOL = +(process.env.ZTOL_M || 4) / 111320; // simplify lot lines to within about 4 m
  const ZRE = /^(W\/LO|R&D|CBD|DMU|PUD|TOD|NBG|ERC|TND|UNZ|SF|MF|MH|LA|RR|NO|LO|GO|LR|GR|CR|CS|CH|IP|MI|LI|DR|AV|AG|P|L)(?=$|[-\d])/;
  const zBase = (zt, base) => (ZRE.exec(zt.replace(/^I-/, '')) || [])[1] || (base && ZRE.test(base.toUpperCase()) ? base.toUpperCase() : 'UNK');
  const zFeats = fs.readdirSync(path.join(RAW, 'coa')).filter((f) => /^zoning_\d+\.geojson$/.test(f)).flatMap((f) => read(`coa/${f}`).features);
  const zTypes = [], zTypeIdx = new Map();
  const zPolys = [];
  let zDropped = 0, zOutside = 0;
  const signedArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return a / 2; };
  for (const f of zFeats) {
    const p = f.properties;
    const zt = String(p.ZONING_ZTYPE || p.ZONING_BASE || 'UNK').toUpperCase().replace(/\s+/g, '');
    for (const poly of ringsOf(f.geometry)) {
      const rings = [];
      for (const r of poly) {
        const q = [];
        for (const [x, y] of simplify(r.slice(0, -1), ZTOL)) {
          const ix = Math.round(x * ZQ), iy = Math.round(y * ZQ);
          const l = q[q.length - 1];
          if (!l || l[0] !== ix || l[1] !== iy) q.push([ix, iy]);
        }
        if (q.length < 3 || ringArea(q) < 4) { if (!rings.length) break; continue; } // under about 20 m²
        // outer rings counterclockwise and holes clockwise, so the page can fill with the nonzero rule
        if ((signedArea(q) > 0) !== !rings.length) q.reverse();
        rings.push(q);
      }
      if (!rings.length) { zDropped++; continue; }
      // the page takes jurisdiction from the Census limits, so lots outside them would contradict its verdict
      const o = rings[0];
      if (!inGeom([o.reduce((s, v) => s + v[0], 0) / o.length / ZQ, o.reduce((s, v) => s + v[1], 0) / o.length / ZQ], hub._geom)) { zOutside++; continue; }
      if (!zTypeIdx.has(zt)) { zTypeIdx.set(zt, zTypes.length); zTypes.push([zt, zBase(zt, p.ZONING_BASE)]); }
      zPolys.push({ t: zTypeIdx.get(zt), rings });
    }
  }
  let zb = [1e12, 1e12, -1e12, -1e12];
  for (const z of zPolys) for (const [x, y] of z.rings[0]) zb = [Math.min(zb[0], x), Math.min(zb[1], y), Math.max(zb[2], x), Math.max(zb[3], y)];
  const morton = (x, y) => { let k = 0; for (let b = 15; b >= 0; b--) k = k * 4 + ((y >> b) & 1) * 2 + ((x >> b) & 1); return k; };
  for (const z of zPolys) {
    const [x, y] = z.rings[0][0];
    z.key = morton(Math.floor((x - zb[0]) / (zb[2] - zb[0] + 1) * 65535), Math.floor((y - zb[1]) / (zb[3] - zb[1] + 1) * 65535));
  }
  zPolys.sort((a, b) => a.key - b.key);
  const zBytes = [];
  const vint = (n) => { while (n >= 128) { zBytes.push((n % 128) | 128); n = Math.floor(n / 128); } zBytes.push(n); };
  const zz = (n) => vint(n < 0 ? -2 * n - 1 : 2 * n);
  let zpx = zb[0], zpy = zb[1], zVerts = 0;
  for (const z of zPolys) {
    vint(z.t); vint(z.rings.length);
    for (const r of z.rings) {
      vint(r.length); zVerts += r.length;
      for (const [x, y] of r) { zz(x - zpx); zz(y - zpy); zpx = x; zpy = y; }
    }
  }
  zoning = { q: ZQ, o: [zb[0], zb[1]], n: zPolys.length, types: zTypes, g: Buffer.from(zBytes).toString('base64'), date: '2026-10-30' };
  zStats = { lots: zPolys.length, dropped: zDropped, outside: zOutside, vertices: zVerts, types: zTypes.length, bytes: zBytes.length, box: [zb[2], zb[3]] };
}

// ---------- a statewide region: a base file the page loads first, and detail in 1° squares loaded as needed ----------
// The base keeps what a statewide view shows (city limits, counties, airspace, airports, highways, land of a square
// mile or more, lakes of 20 km² or more); the smaller land, water and roads go to the square or squares each one
// touches, with an id so a feature in two squares is kept once.
const clean = (o) => { const { _c, ...rest } = o; return rest; };
let chunkKeys = null, idx = null, chunkStats = null;
const baseLands = [], baseWater = [], baseRoads = [];
if (CFG.statewide) {
  const decBox = (enc) => { let x = 0, y = 0, b = [1e9, 1e9, -1e9, -1e9]; for (let i = 0; i < enc.length; i += 2) { x += enc[i]; y += enc[i + 1]; b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; } return b.map((v) => v / 1e5); };
  const polyBox = (g) => g.flatMap((poly) => [decBox(poly[0])]).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
  const cells = new Map();
  let id = 0;
  const put = (kind, o, box) => {
    const f = { ...clean(o), i: id++ };
    for (let x = Math.floor(box[0] - 0.002); x <= Math.floor(box[2] + 0.002); x++) {
      for (let y = Math.floor(box[1] - 0.002); y <= Math.floor(box[3] + 0.002); y++) {
        const k = `${x}_${y}`;
        if (!cells.has(k)) cells.set(k, { l: [], w: [], r: [] });
        cells.get(k)[kind].push(f);
      }
    }
  };
  for (const l of lands) {
    if (l.a >= 640 || l.k === 'capitol' || l.k === 'wilderness') baseLands.push(clean(l));
    else put('l', l, polyBox(l.g));
  }
  for (const w of water) { if (w.ar >= 20) baseWater.push(clean(w)); else put('w', w, polyBox(w.g)); }
  for (const r of roads) { if (r.c === 'P') baseRoads.push(r); else put('r', r, decBox(r.g)); }
  const dir = path.join(ROOT, 'docs', 'data', REGION);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let biggest = 0;
  for (const [k, v] of cells) {
    const body = `window.heliChunk&&window.heliChunk(${JSON.stringify(k)},${JSON.stringify(v)});\n`;
    fs.writeFileSync(path.join(dir, `${k}.js`), body);
    biggest = Math.max(biggest, body.length);
  }
  chunkKeys = [...cells.keys()].sort();
  // named land and water outside the base, so search finds them before their square has loaded
  const best = new Map();
  for (const l of [...lands, ...water]) {
    if (!l._c || /^Unnamed|^Lake or pond$/.test(l.n) || baseLands.some((b) => b.n === l.n)) continue;
    const size = l.a != null ? l.a : (l.ar || 0) * 247;
    if (size < 20) continue;
    const key = l.n.toLowerCase();
    if (!best.has(key) || best.get(key)[4] < size) best.set(key, [l.n, l.k, r5(l._c[1]), r5(l._c[0]), size]);
  }
  idx = [...best.values()].map(([n, k, la, lo]) => [n, k, la, lo]);
  chunkStats = { squares: chunkKeys.length, biggestKB: Math.round(biggest / 1024), detailFeatures: id, indexed: idx.length };
}

const data = {
  v: 1,
  region: REGION,
  built: new Date().toISOString().slice(0, 10),
  bounds: CFG.bounds,
  places: places.map(({ _geom, ...p }) => p),
  counties, airspace, sua, airports, infra,
  ...(CFG.statewide ? { roads: baseRoads, water: baseWater, lands: baseLands, chunks: { dir: `data/${REGION}`, keys: chunkKeys }, idx } : { roads, water, lands: lands.map(clean) }),
  stadiums: typeof CFG.stadiums === 'string' ? JSON.parse(fs.readFileSync(path.join(ROOT, CFG.stadiums), 'utf8')) : CFG.stadiums,
  // a statewide region loads Austin's zoning from its own file, only once the map or a spot check needs it
  ...(zoning && !CFG.zoningFile ? { zoning } : {}),
  ...(zoning && CFG.zoningFile ? { zoningFile: `data/${CFG.zoningFile}.js`, zoningBox: [zoning.o[0] / zoning.q, zoning.o[1] / zoning.q, zStats.box[0] / zoning.q, zStats.box[1] / zoning.q] } : {}),
};
const json = JSON.stringify(data);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `window.HELI_DATA=${json};\n`);
if (zoning && CFG.zoningFile) fs.writeFileSync(path.join(ROOT, 'docs', 'data', `${CFG.zoningFile}.js`), `window.HELI_ZONING=${JSON.stringify(zoning)};\n`);
const kinds = {};
for (const l of lands) kinds[l.k] = (kinds[l.k] || 0) + 1;
console.log(JSON.stringify({
  region: REGION, out: path.relative(ROOT, OUT), bytes: json.length, places: places.length, counties: counties.length, roads: roads.length, water: water.length,
  lands: lands.length, kinds, skipped, chunks: chunkStats, airspace: airspace.length, sua: sua.length, airports: airports.length, infra: infra.length, zoning: zStats,
  waterKinds: water.reduce((o, w) => ((o[w.k] = (o[w.k] || 0) + 1), o), {}),
  regs: places.filter((p) => p.reg).map((p) => `${p.n}:${p.reg}`).join(' '),
}, null, 1));
