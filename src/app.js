// Picks a region from the URL hash (#austin, #blacksburg/37.22900,-80.41400), loads that region's data file,
// then builds the map and the briefing panel for it.
// GitHub Pages lets browsers keep a file for 10 minutes, so each data file's link carries the build's stamp (set by
// assemble.mjs from the data's contents) and a new deploy's data is fetched at once
const HELI_BUILD = '__BUILD__';
const withBuild = (src) => `${src}?v=${HELI_BUILD}`;

(function () {
  'use strict';
  const REGIONS = window.HELI_REGIONS;
  function parseHash() {
    const m = /^#([a-z]+)(?:\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?/.exec(location.hash || '');
    // a region can answer to an older name (the Austin map became the Texas map)
    const named = m && (REGIONS[m[1]] ? m[1] : Object.keys(REGIONS).find((k) => (REGIONS[k].aliases || []).includes(m[1])));
    const key = named || Object.keys(REGIONS)[0];
    return { key, at: m && m[2] ? [+m[2], +m[3]] : null };
  }
  const h = parseHash();
  const REGION = REGIONS[h.key];
  window.addEventListener('hashchange', () => {
    const n = parseHash();
    if (n.key !== REGION.key) location.reload();
    else if (n.at && window.__heliGoTo) window.__heliGoTo(n.at[0], n.at[1]);
  });
  const s = document.createElement('script');
  s.src = withBuild(REGION.data);
  s.onload = () => heliStart(REGION, h.at);
  s.onerror = () => { document.getElementById('pane-spot').innerHTML = '<p class="hint" style="padding-top:16px">The map data didn’t load. Reload the page to try again.</p>'; };
  document.head.appendChild(s);
})();

function heliStart(REGION, startAt) {
  'use strict';
  const D = window.HELI_DATA;
  const RB = window.HELI_RULES[REGION.state];
  const RULES = RB.rules;
  const NM = 1852;
  const REGIONS = window.HELI_REGIONS;

  // ---------- geometry ----------
  function dec(a) {
    const o = new Array(a.length / 2);
    let x = 0, y = 0;
    for (let i = 0, j = 0; i < a.length; i += 2, j++) { x += a[i]; y += a[i + 1]; o[j] = [y / 1e5, x / 1e5]; }
    return o;
  }
  const decG = (g) => g.map((p) => p.map(dec));
  function bbOf(polys) {
    let s = 90, w = 180, n = -90, e = -180;
    for (const p of polys) for (const c of p[0]) { if (c[0] < s) s = c[0]; if (c[0] > n) n = c[0]; if (c[1] < w) w = c[1]; if (c[1] > e) e = c[1]; }
    return [s, w, n, e];
  }
  function pip(la, lo, r) {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const yi = r[i][0], xi = r[i][1], yj = r[j][0], xj = r[j][1];
      if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  function inZone(z, la, lo) {
    const b = z.bb;
    if (la < b[0] || la > b[2] || lo < b[1] || lo > b[3]) return false;
    return z.polys.some((p) => pip(la, lo, p[0]) && !p.slice(1).some((h) => pip(la, lo, h)));
  }
  function meters(la1, lo1, la2, lo2) {
    const k = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
    return Math.hypot((lo2 - lo1) * k * 111320, (la2 - la1) * 110574);
  }
  function bearing(la1, lo1, la2, lo2) {
    const t = Math.PI / 180;
    const y = Math.sin((lo2 - lo1) * t) * Math.cos(la2 * t);
    const x = Math.cos(la1 * t) * Math.sin(la2 * t) - Math.sin(la1 * t) * Math.cos(la2 * t) * Math.cos((lo2 - lo1) * t);
    return (Math.atan2(y, x) / t + 360) % 360;
  }
  function segMeters(la, lo, a, b) {
    const kx = Math.cos(la * Math.PI / 180) * 111320, ky = 110574;
    const px = lo * kx, py = la * ky, ax = a[1] * kx, ay = a[0] * ky, bx = b[1] * kx, by = b[0] * ky;
    const dx = bx - ax, dy = by - ay;
    let t = 0;
    if (dx || dy) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function insidePoint(z) {
    const [s, w, n, e] = z.bb;
    if (inZone(z, (s + n) / 2, (w + e) / 2)) return [(s + n) / 2, (w + e) / 2];
    for (let k = 3; k <= 11; k += 2) {
      for (let i = 1; i < k; i++) for (let j = 1; j < k; j++) {
        const la = s + ((n - s) * i) / k, lo = w + ((e - w) * j) / k;
        if (inZone(z, la, lo)) return [la, lo];
      }
    }
    return z.polys[0][0][0];
  }
  const inBounds = (b, la, lo) => lo >= b[0] && la >= b[1] && lo <= b[2] && la <= b[3];

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function dm(v, pos, neg) {
    const h = v >= 0 ? pos : neg;
    v = Math.abs(v);
    let d = Math.floor(v), m = Math.round((v - d) * 600) / 10;
    if (m >= 60) { d += 1; m = 0; }
    return `${d}°${m.toFixed(1).padStart(4, '0')}′${h}`;
  }
  const fmtLL = (la, lo) => `${dm(la, 'N', 'S')} ${dm(lo, 'E', 'W')}`;
  const compass = (b) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(b / 22.5) % 16];
  const nmStr = (m) => (m < 0.2 * NM ? `${Math.round(m / 0.3048).toLocaleString()} ft` : `${(m / NM).toFixed(m < 10 * NM ? 1 : 0)} NM`);
  // Virginia's independent cities are county-equivalents, so the county list holds them too
  const countyName = (c) => (c.ic ? `City of ${c.n}` : `${c.n} County`);
  const STATE_NAMES = { TX: 'Texas', VA: 'Virginia', WV: 'West Virginia', NM: 'New Mexico', OK: 'Oklahoma', AR: 'Arkansas', LA: 'Louisiana' };
  const placeKind = (p) => ({ town: 'Town', village: 'Village' }[p.lsad] || 'City');

  // ---------- what each kind of zone means (kinds come from the build; rule ids from the region's state) ----------
  const LAND = {
    military_federal: { s: 'red', label: 'Military installation', rules: ['military_fed'] },
    military_guard: { s: 'red', label: 'National Guard installation', rules: ['military_guard'] },
    nwr: { s: 'red', label: 'National wildlife refuge', rules: ['nwr', 'esa'] },
    nps: { s: 'red', label: 'National Park Service land', rules: ['nps'] },
    usace: { s: 'red', label: 'Army Corps of Engineers lake land', rules: ['usace'] },
    federal_other: { s: 'red', label: 'Federal land', rules: ['federal_land'] },
    usfs: { s: 'green', label: 'National forest', rules: ['usfs'] },
    wilderness: { s: 'red', label: 'National forest wilderness', rules: ['wilderness'] },
    state_nap: { s: 'red', label: 'State natural area preserve', rules: ['state_nap'] },
    other_state: { s: 'amber', label: 'Public land in another state', rules: ['other_state'] },
    state_park: { s: 'red', label: 'State park or natural area', rules: ['state_park'] },
    state_wma: { s: 'red', label: 'State wildlife area or hatchery', rules: ['state_wma'] },
    state_forest: { s: 'amber', label: 'State forest', rules: ['state_forest'] },
    state_other: { s: 'red', label: 'State-owned land', rules: ['state_land'] },
    capitol: { s: 'red', label: 'Texas Capitol Complex', rules: ['capitol'] },
    campus_public: { s: 'red', label: 'Public university campus', rules: ['campus_public'] },
    prison: { s: 'red', label: 'Jail or correctional facility', rules: ['prison'] },
    lcra: { s: 'red', label: 'LCRA park or land', rules: ['lcra_land'] },
    utility: { s: 'red', label: 'Utility project land', rules: ['utility_land'] },
    bcp: { s: 'red', label: 'Balcones Canyonlands Preserve', rules: ['bcp', 'esa'] },
    park_austin: { s: 'red', label: 'City of Austin parkland', rules: ['austin_park'] },
    austin_wqpl: { s: 'red', label: 'City of Austin protected land', rules: ['austin_wqpl'] },
    park_city: { s: 'red', label: 'City or town park', rules: ['city_park'] },
    park_travis: { s: 'red', label: 'Travis County park', rules: ['travis_park'] },
    park_county: { s: 'red', label: 'County park', rules: ['county_park'] },
    school: { s: 'red', label: 'School district property', rules: ['school'] },
    district: { s: 'red', label: 'Utility or special-district park', rules: ['district'] },
    campus_private: { s: 'amber', label: 'Private college campus', rules: ['campus_private'] },
    ngo: { s: 'amber', label: 'Nonprofit conservation land', rules: ['ngo'] },
    private_cons: { s: 'amber', label: 'Private conservation land', rules: ['private_cons'] },
    hoa: { s: 'amber', label: 'HOA common area', rules: ['hoa'] },
    unknown: { s: 'amber', label: 'Protected land, owner unclear', rules: ['unknown_protected'] },
    easement: { s: 'none', label: 'Private farmland under easement', rules: [] },
  };
  const WATER = {
    lake_lcra: { s: 'amber', label: 'Highland Lakes (LCRA)', rules: ['lcra_lake'] },
    lake_austin_city: { s: 'red', label: 'City-regulated lake', rules: ['austin_lakes'] },
    lake_austin_park: { s: 'red', label: 'Lake inside an Austin park', rules: ['austin_park', 'water_other'] },
    lake_usace: { s: 'red', label: 'Army Corps of Engineers lake', rules: ['usace', 'water_other'] },
    lake_utility: { s: 'amber', label: 'Utility reservoir', rules: ['utility_lake'] },
    river: { s: 'green', label: 'River', rules: ['water_river'] },
    lake_other: { s: 'amber', label: 'Lake or pond', rules: ['water_other'] },
  };
  const CITY = REGION.cities || {};
  // a city's landing rule: its own entry in the region's settings, or the card its researched code produced
  // (city_<GEOID>); tint is the map color. A city with neither hasn't been checked
  function cityRuleOf(p) {
    if (!p || p.reg === 'other_state') return null;
    if (CITY[p.reg]) return CITY[p.reg];
    const id = `city_${p.reg}`, r = p.reg && RULES[id];
    return r ? { rule: id, tint: !r.unknown && ['red', 'amber', 'green'].includes(r.level) ? r.level : '' } : null;
  }
  const CITY_NOTES = REGION.cityNotes || {};
  const MAJOR = new Set(REGION.major || []);
  const WATER_LABELS = REGION.waterLabels || [];

  // ---------- decode the bundle ----------
  const zone = (o) => { const polys = decG(o.g); const bb = bbOf(polys); return { ...o, polys, bb, area: (bb[2] - bb[0]) * (bb[3] - bb[1]) }; };
  // a zone's map color follows the level of its main rule in this state, so a kind can be off-limits in one state
  // and ask-first in another
  const withLevel = (d) => { const r = RULES[d.rules[0]]; return d.s === 'none' || !r ? d : { ...d, s: r.level === 'info' ? 'none' : r.level }; };
  const landZone = (o) => { const z = zone(o); return { ...z, def: withLevel(LAND[z.k] || LAND.unknown) }; };
  const waterZone = (o) => { const z = zone(o); return { ...z, def: withLevel(WATER[z.k] || WATER.lake_other) }; };
  const roadLine = (r) => {
    const line = dec(r.g);
    let s = 90, w = 180, n = -90, e = -180;
    for (const c of line) { if (c[0] < s) s = c[0]; if (c[0] > n) n = c[0]; if (c[1] < w) w = c[1]; if (c[1] > e) e = c[1]; }
    return { ...r, line, bb: [s, w, n, e] };
  };
  // a statewide region's smaller land, water and roads arrive later, in 1° squares (see "detail squares")
  const lands = D.lands.map(landZone);
  const water = D.water.map(waterZone);
  const roads = D.roads.map(roadLine);
  const places = D.places.map(zone);
  const counties = D.counties.map(zone);
  const airspace = D.airspace.map(zone);
  const sua = D.sua.map(zone);
  const airports = D.airports;
  const infra = D.infra;

  // ---------- Austin zoning ----------
  // A lot's base district decides whether the city can permit a heli-facility on it: never in a residential district
  // (§13-1-176, bar hospital heliports and construction-site helistops), as a conditional use in all the rest (§25-2-861).
  const ZBASE = {
    LA: ['Lake Austin residence', 'res'], RR: ['Rural residence', 'res'], SF: ['Single-family residence', 'res'], MF: ['Multifamily residence', 'res'], MH: ['Mobile home residence', 'res'],
    NO: ['Neighborhood office', 'com'], LO: ['Limited office', 'com'], GO: ['General office', 'com'], LR: ['Neighborhood commercial', 'com'], GR: ['Community commercial', 'com'],
    CR: ['Commercial recreation', 'com'], L: ['Lake commercial', 'com'], CBD: ['Central business district', 'com'], DMU: ['Downtown mixed use', 'com'],
    'W/LO': ['Warehouse and limited office', 'com'], CS: ['General commercial services', 'com'], CH: ['Commercial highway services', 'com'],
    IP: ['Industrial park', 'ind'], MI: ['Major industry', 'ind'], LI: ['Limited industrial services', 'ind'], 'R&D': ['Research and development', 'ind'],
    DR: ['Development reserve', 'sp'], AV: ['Aviation services', 'sp'], AG: ['Agricultural', 'sp'], P: ['Public', 'sp'], PUD: ['Planned unit development', 'sp'],
    TOD: ['Transit-oriented development', 'sp'], NBG: ['North Burnet/Gateway', 'sp'], ERC: ['East Riverside Corridor', 'sp'], TND: ['Traditional neighborhood', 'sp'],
    UNZ: ['Unzoned', 'unz'], UNK: ['Zoning not recorded', 'unz'],
  };
  let zTypes = [], zLots = [], zDate = '';
  // Lots are kept in Web Mercator world units (256 to the world at zoom 0): tiles draw them as they are, and
  // lookups convert the clicked point instead.
  const WU = 256;
  const mercY = (la) => { const s = Math.sin(la * Math.PI / 180); return WU / 2 - (WU / (4 * Math.PI)) * Math.log((1 + s) / (1 - s)); };
  const toWorld = (la, lo) => [(lo + 180) * WU / 360, mercY(la)];
  const fromWorld = (x, y) => [(2 * Math.atan(Math.exp((WU / 2 - y) * 2 * Math.PI / WU)) - Math.PI / 2) * 180 / Math.PI, x * 360 / WU - 180];
  function decodeZoning(Z) {
    zDate = Z.date;
    zTypes = Z.types.map(([code, base]) => {
      const b = ZBASE[base] || ZBASE.UNK;
      return { code, base, cls: b[1], name: (/^(I-)?CS-1\b/.test(code) ? 'Commercial-liquor sales' : b[0]) + (code.startsWith('I-') ? ' (interim)' : '') };
    });
    const bin = atob(Z.g), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let p = 0;
    const uint = () => { let v = 0, m = 1, b; do { b = bytes[p++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
    const sint = () => { const v = uint(); return v % 2 ? -(v + 1) / 2 : v / 2; };
    let x = Z.o[0], y = Z.o[1];
    const lots = [];
    for (let k = 0; k < Z.n; k++) {
      const t = zTypes[uint()], rings = [];
      for (let r = 0, nr = uint(); r < nr; r++) {
        const n = uint(), a = new Float64Array(n * 2);
        for (let v = 0; v < n; v++) { x += sint(); y += sint(); a[2 * v] = (x / Z.q + 180) * WU / 360; a[2 * v + 1] = mercY(y / Z.q); }
        rings.push(a);
      }
      const o = rings[0];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < o.length; i += 2) { if (o[i] < x0) x0 = o[i]; if (o[i] > x1) x1 = o[i]; if (o[i + 1] < y0) y0 = o[i + 1]; if (o[i + 1] > y1) y1 = o[i + 1]; }
      lots.push({ t, rings, bb: [x0, y0, x1, y1] });
    }
    zLots = lots;
  }
  if (D.zoning) decodeZoning(D.zoning);
  function pipW(x, y, a) {
    let ins = false;
    for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
      const xi = a[i], yi = a[i + 1], xj = a[j], yj = a[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }
  function lotAt(la, lo) {
    const [x, y] = toWorld(la, lo);
    for (const z of zLots) {
      const b = z.bb;
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
      let ins = false;
      for (const r of z.rings) if (pipW(x, y, r)) ins = !ins;
      if (ins) return z;
    }
    return null;
  }
  // the nearest lot within maxM meters, for a spot that falls between lots
  function nearLot(la, lo, maxM) {
    const [x, y] = toWorld(la, lo);
    const mPer = 40075016.686 * Math.cos(la * Math.PI / 180) / WU;
    let best = null, bd = maxM / mPer;
    for (const z of zLots) {
      const b = z.bb;
      if (x < b[0] - bd || x > b[2] + bd || y < b[1] - bd || y > b[3] + bd) continue;
      const a = z.rings[0];
      for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
        const ax = a[j], ay = a[j + 1], dx = a[i] - ax, dy = a[i + 1] - ay;
        const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < bd) { bd = d; best = z; }
      }
    }
    return best ? { z: best, d: bd * mPer } : null;
  }
  const lotNote = (t) => (t.cls === 'res' ? 'no permit possible' : t.cls === 'unz' ? 'unzoned' : 'permit possible');
  const zoned = (p) => !!(p && zLots.length && p.reg === 'austin');

  // ---------- page chrome for the region ----------
  document.title = REGION.title;
  document.getElementById('title').textContent = REGION.title;
  document.getElementById('tagline').textContent = `Where a private helicopter can and can't put down ${REGION.where || `around ${REGION.name}`}, and what a prohibited landing can cost. Click any spot on the map, or search an address.`;
  const regionsEl = document.getElementById('regions');
  const regionKeys = Object.keys(REGIONS);
  if (regionKeys.length > 1) {
    regionsEl.innerHTML = regionKeys.map((k) => `<button type="button" data-region="${k}" aria-pressed="${k === REGION.key}">${esc(REGIONS[k].label)}</button>`).join('');
    regionsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.region !== REGION.key) location.hash = b.dataset.region; }));
  } else regionsEl.hidden = true;
  if (!D.zoning && !D.zoningFile) document.getElementById('zoneLegend').hidden = true;
  if (!lands.some((l) => l.def.s === 'green')) document.getElementById('greenLegend').hidden = true;
  if (!places.some((p) => (cityRuleOf(p) || {}).tint === 'green')) document.getElementById('cityOkLegend').hidden = true;
  if (REGION.parcels) document.getElementById('parcelText').textContent = REGION.parcels.lines.legend;
  else document.getElementById('parcelLegend').hidden = true;

  // ---------- map ----------
  const map = L.map('map', {
    minZoom: REGION.minZoom || 8, maxZoom: 18, zoomSnap: 0.5, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
    maxBounds: REGION.maxBounds, maxBoundsViscosity: 0.7, attributionControl: true,
  });
  map.zoomControl.setPosition('topright');
  window.__heliMap = map; // TEST-ONLY
  map.attributionControl.setPrefix(false).addAttribution(REGION.attribution);
  const pane = (name, z) => { map.createPane(name).style.zIndex = z; return L.canvas({ pane: name, padding: 0.4, tolerance: 2 }); };
  const rBase = pane('p-base', 210), rTint = pane('p-tint', 212), rWater = pane('p-water', 220), rLand = pane('p-land', 230), rRoad = pane('p-road', 240), rAir = pane('p-air', 250), rHl = pane('p-hl', 260);
  map.createPane('p-zone').style.zIndex = 215;
  const labelPane = map.createPane('p-label');
  labelPane.style.zIndex = 450;
  labelPane.style.pointerEvents = 'none';
  map.createPane('p-pin').style.zIndex = 700;

  let C = {};
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (n) => cs.getPropertyValue(n).trim();
    const num = (n, d) => { const v = parseFloat(g(n)); return Number.isFinite(v) ? v : d; };
    C = {
      land: g('--map-land'), water: g('--map-water'), waterEdge: g('--map-water-edge'), road: g('--map-road'), roadMinor: g('--map-road-minor'),
      county: g('--map-county'), city: g('--map-city'), cityFill: g('--map-city-fill'), c: g('--air-c'), d: g('--air-d'), r: g('--air-r'), tfr: g('--air-tfr'),
      red: g('--s-red'), amber: g('--s-amber'), green: g('--s-green'), blue: g('--s-blue'), ink: g('--ink'), panel: g('--panel'), accent: g('--accent'),
      parcel: g('--map-parcel'), parcelLabel: g('--map-parcel-label'),
      fillRed: num('--fill-red', 0.26), fillAmber: num('--fill-amber', 0.2), fillGreen: num('--fill-green', 0.12), cityTint: num('--city-tint', 0.14), cityTintGreen: num('--city-tint-green', 0.1),
      zoneHatch: num('--zone-hatch', 0.5), zoneRes: num('--zone-res-fill', 0.08), zoneOk: num('--zone-ok-fill', 0.12),
    };
  }
  readColors();

  const G = {};
  // d-groups hold a statewide region's detail squares, shown from zoom 9
  ['counties', 'cities', 'zone', 'water', 'dwater', 'roads', 'droads', 'green', 'dgreen', 'red', 'dred', 'amber', 'damber', 'parcel', 'airspace', 'sua', 'tfr', 'ap', 'priv', 'infra', 'labels', 'hl', 'pin'].forEach((k) => { G[k] = L.layerGroup(); });
  const styled = []; // [layer, fn] pairs, restyled on theme change
  function add(group, layer, styleFn) { layer.setStyle(styleFn()); styled.push([layer, styleFn]); group.addLayer(layer); return layer; }
  const noI = { interactive: false };

  for (const z of counties) add(G.counties, L.polygon(z.polys, { ...noI, renderer: rBase }), () => ({ color: C.county, weight: 1, dashArray: '5 4', opacity: 0.7, fill: false }));
  for (const z of places) {
    const tint = (cityRuleOf(z) || {}).tint;
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rBase }), () => ({ color: C.city, weight: 1, opacity: 0.5, fillColor: C.cityFill, fillOpacity: 0.55 }));
    if (!tint) continue;
    // a city with a landing rule gets a wash under its zoning and water and a border above them (bold and dashed
    // where it bans or limits landings), so the whole area it covers reads at a glance
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rTint }), () => ({ stroke: false, fillColor: C[tint], fillOpacity: tint === 'green' ? C.cityTintGreen : C.cityTint }));
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rLand }), () => (tint === 'green'
      ? { color: C.green, weight: 1.5, opacity: 0.85, fill: false }
      : { color: C[tint], weight: 2.4, opacity: 0.95, dashArray: '9 4', fill: false }));
  }
  // Austin zoning, drawn into canvas tiles: residential lots hatched red (no permit possible), the other districts amber
  let hatchSrc = null;
  function hatch(dpr) {
    const key = `${C.red}${C.zoneHatch}${dpr}`;
    if (hatchSrc && hatchSrc.key === key) return hatchSrc;
    const n = Math.round(8 * dpr), c = document.createElement('canvas'); // 8 px divides the 256 px tile, so lines meet across tiles
    c.width = c.height = n;
    const g = c.getContext('2d');
    g.strokeStyle = C.red; g.globalAlpha = C.zoneHatch; g.lineWidth = 1.3 * dpr;
    g.beginPath(); g.moveTo(0, n); g.lineTo(n, 0); g.moveTo(-n / 2, n / 2); g.lineTo(n / 2, -n / 2); g.moveTo(n / 2, n * 1.5); g.lineTo(n * 1.5, n / 2); g.stroke();
    c.key = key;
    return (hatchSrc = c);
  }
  const ZoneTiles = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize(), dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      const tile = document.createElement('canvas');
      tile.width = Math.round(size.x * dpr); tile.height = Math.round(size.y * dpr);
      const k = 2 ** coords.z * dpr, ox = coords.x * size.x * dpr, oy = coords.y * size.y * dpr;
      const x0 = ox / k, y0 = oy / k, x1 = (ox + tile.width) / k, y1 = (oy + tile.height) / k;
      const res = new Path2D(), ok = new Path2D();
      let n = 0;
      for (const z of zLots) {
        const b = z.bb;
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1 || z.t.cls === 'unz') continue;
        const path = z.t.cls === 'res' ? res : ok;
        for (const a of z.rings) {
          path.moveTo(a[0] * k - ox, a[1] * k - oy);
          for (let i = 2; i < a.length; i += 2) path.lineTo(a[i] * k - ox, a[i + 1] * k - oy);
          path.closePath();
        }
        n++;
      }
      if (!n) return tile;
      const g = tile.getContext('2d');
      g.fillStyle = C.amber; g.globalAlpha = C.zoneOk; g.fill(ok);
      g.fillStyle = C.red; g.globalAlpha = C.zoneRes; g.fill(res);
      g.globalAlpha = 1; g.fillStyle = g.createPattern(hatch(dpr), 'repeat'); g.fill(res);
      return tile;
    },
  });
  let zoneLayer = null;
  function addZoneLayer() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { bb } of zLots) { x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]); x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]); }
    zoneLayer = new ZoneTiles({ pane: 'p-zone', updateWhenZooming: false, keepBuffer: 3, bounds: L.latLngBounds([fromWorld(x0, y1), fromWorld(x1, y0)]) });
    G.zone.addLayer(zoneLayer);
  }
  if (zLots.length) addZoneLayer();
  function drawWater(z, detail) {
    add(detail ? G.dwater : G.water, L.polygon(z.polys, { ...noI, renderer: rWater }), () => ({ color: C.waterEdge, weight: 0.8, opacity: 0.9, fillColor: C.water, fillOpacity: 1 }));
  }
  function drawRoad(r, detail) {
    const p = r.c === 'P';
    add(detail ? G.droads : G.roads, L.polyline(r.line, { ...noI, renderer: rRoad }), () => ({ color: p ? C.road : C.roadMinor, weight: p ? 2.4 : 1.4, opacity: 0.9, lineCap: 'round' }));
  }
  function drawLand(z, detail) {
    const s = z.def.s;
    if (s === 'green') { add(detail ? G.dgreen : G.green, L.polygon(z.polys, { ...noI, renderer: rTint }), () => ({ color: C.green, weight: 1.1, opacity: 0.8, fillColor: C.green, fillOpacity: C.fillGreen })); return; }
    if (s !== 'red' && s !== 'amber') return;
    const g = detail ? (s === 'red' ? G.dred : G.damber) : (s === 'red' ? G.red : G.amber);
    add(g, L.polygon(z.polys, { ...noI, renderer: rLand }), () => ({ color: C[s], weight: 0.9, opacity: 0.9, fillColor: C[s], fillOpacity: s === 'red' ? C.fillRed : C.fillAmber }));
  }
  for (const z of water) drawWater(z, false);
  for (const r of roads) drawRoad(r, false);
  for (const z of lands) drawLand(z, false);
  for (const z of airspace) {
    const c = z.c === 'C', b = z.c === 'B';
    add(G.airspace, L.polygon(z.polys, { ...noI, renderer: rAir }), () => (b
      ? { color: C.d, weight: z.sfc ? 3 : 1.8, opacity: 0.95, fill: z.sfc, fillColor: C.d, fillOpacity: 0.05 }
      : { color: c ? C.c : C.d, weight: c ? (z.sfc ? 2.6 : 1.6) : 2, dashArray: c ? null : '7 5', opacity: 0.95, fill: c && z.sfc, fillColor: C.c, fillOpacity: 0.05 }));
  }
  for (const z of sua) {
    const r = z.t === 'R';
    add(G.sua, L.polygon(z.polys, { ...noI, renderer: rAir }), () => ({ color: r ? C.r : C.c, weight: r ? 2.2 : 1.6, dashArray: r ? '2 4' : '1 5', opacity: 0.95, fillColor: r ? C.r : C.c, fillOpacity: r ? 0.12 : 0.05 }));
  }
  for (const s of D.stadiums) {
    add(G.tfr, L.circle([s.lat, s.lon], { ...noI, radius: 3 * NM, renderer: rAir }), () => ({ color: C.tfr, weight: 2, dashArray: '8 6', opacity: 0.95, fillColor: C.tfr, fillOpacity: 0.05 }));
  }

  // property lines from the region's public parcel service, above the land fills and under the airspace; they only
  // draw where the page can reach that service (the website, not a sandboxed preview)
  const PARCELS = REGION.parcels || null;
  map.createPane('p-parcel').style.zIndex = 245;
  map.getPane('p-parcel').style.pointerEvents = 'none';
  const rgba = (hex, a = 255) => { const h = hex.replace('#', ''); const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; };
  // owner names go only on tracts big enough to hold them at the zoom: 60+ acres from zoom 15, 15+ from 16, 4+ from 17,
  // 1+ from 18 (town lots stay unlabeled; a click shows their owner)
  const LABEL_STEPS = [[60, Infinity, 20000], [15, 60, 10000], [4, 15, 5000], [1, 4, 2500]];
  function parcelStyle(src) {
    const di = { renderer: { type: 'simple', symbol: { type: 'esriSFS', style: 'esriSFSNull', outline: { type: 'esriSLS', style: 'esriSLSSolid', color: rgba(C.parcel, 220), width: 0.7 } } } };
    if (src.label) {
      const symbol = { type: 'esriTS', color: rgba(C.parcelLabel), haloColor: rgba(C.land), haloSize: 1.2, font: { family: 'Arial', size: 7.5 } };
      di.showLabels = true;
      di.labelingInfo = LABEL_STEPS.map(([lo, hi, minScale]) => ({
        labelExpression: `[${src.label}]`, labelPlacement: 'esriServerPolygonPlacementAlwaysHorizontal', useCodedValues: false, symbol, minScale, maxScale: 0,
        where: `${src.labelArea} >= ${lo}${hi < Infinity ? ` AND ${src.labelArea} < ${hi}` : ''}`,
      }));
    }
    return { id: src.layer, source: { type: 'mapLayer', mapLayerId: src.layer }, drawingInfo: di };
  }
  // one server-drawn image per view (so owner names aren't cut at tile edges), kept until the next one has loaded
  const ParcelView = L.Layer.extend({
    onAdd(m) { this._seq = 0; m.on('moveend resize', this.refresh, this); this.refresh(); },
    onRemove(m) { m.off('moveend resize', this.refresh, this); this._seq++; if (this._img) m.removeLayer(this._img); this._img = null; },
    refresh() {
      const m = this._map, src = PARCELS.lines;
      if (!m) return;
      const seq = ++this._seq;
      const b = m.getBounds(), size = m.getSize(), dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
      if (m.getZoom() < src.minZoom || parcelFails >= 3) { if (this._img) m.removeLayer(this._img); this._img = null; return; }
      if (size.x < 2 || size.y < 2) return; // a hidden page has no size yet; its resize brings it back here
      const sw = L.CRS.EPSG3857.project(b.getSouthWest()), ne = L.CRS.EPSG3857.project(b.getNorthEast());
      const url = `${src.url}/export?${new URLSearchParams({
        f: 'image', format: 'png32', transparent: 'true', bboxSR: '3857', imageSR: '3857', bbox: [sw.x, sw.y, ne.x, ne.y].map((v) => v.toFixed(1)).join(','),
        size: `${Math.round(size.x * dpr)},${Math.round(size.y * dpr)}`, dpi: String(Math.round(96 * dpr)), dynamicLayers: JSON.stringify([parcelStyle(src)]),
      })}`;
      const img = L.imageOverlay(url, b, { pane: 'p-parcel', interactive: false, opacity: 0 });
      img.once('load', () => {
        parcelsReached();
        if (seq !== this._seq) { m.removeLayer(img); return; }
        img.setOpacity(1);
        if (this._img) m.removeLayer(this._img);
        this._img = img;
      });
      img.once('error', () => { m.removeLayer(img); if (seq === this._seq) parcelFailed(); });
      img.addTo(m);
    },
  });
  // three failures in a row with nothing drawn means the page can't reach the service (a sandboxed preview); one
  // failure on the website is just a slow or busy server
  let parcelFails = 0, parcelsSeen = false;
  const parcelHint = (t) => { const h = document.getElementById('parcelHint'); if (h) h.textContent = t; };
  function parcelsReached() { parcelsSeen = true; if (parcelFails) { parcelFails = 0; parcelHint('zoom in'); } }
  function parcelFailed() { if (!parcelsSeen && ++parcelFails === 3) parcelHint('only on the website'); }
  const parcelLayer = !PARCELS ? null : PARCELS.lines.kind === 'tiles'
    ? L.tileLayer(`${PARCELS.lines.url}/tile/{z}/{y}/{x}`, { pane: 'p-parcel', minZoom: PARCELS.lines.minZoom, maxZoom: 18, maxNativeZoom: 19, className: 'parcel-tiles' })
    : new ParcelView();
  if (parcelLayer) {
    G.parcel.addLayer(parcelLayer);
    // a cached tile layer is missing tiles past its state's edge, so only failures before any tile loads count
    if (PARCELS.lines.kind === 'tiles') parcelLayer.on('tileload', parcelsReached).on('tileerror', parcelFailed);
  }

  // labels
  const label = (lat, lon, cls, text) => L.marker([lat, lon], { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl ${cls}">${esc(text)}</div>` }), interactive: false, keyboard: false, pane: 'p-label' });
  for (const z of counties) if (!z.ic) G.labels.addLayer(label(z.l[0], z.l[1], 'lbl-county', `${z.n} Co.`));
  // a statewide region sizes city labels by population: the biggest show from the state view, cities of 50,000+ from
  // zoom 7.5, the rest from zoom 10
  for (const z of places) G.labels.addLayer(label(z.l[0], z.l[1], `lbl-city${MAJOR.has(z.n) || z.t >= 2 ? ' major' : ''}${z.t === 3 ? ' mega' : ''}`, z.n));
  for (const [n, la, lo, m] of WATER_LABELS) G.labels.addLayer(label(la, lo, `lbl-water ${m}`, n));
  const hideAir = new Set(REGION.hideAirspaceLabels || []);
  for (const z of airspace) {
    if (hideAir.has(z.id)) continue;
    const top = z.bb[2] - (z.bb[2] - z.bb[0]) * 0.07;
    const mid = (z.bb[1] + z.bb[3]) / 2;
    const ceil = String(parseInt(z.hi, 10) / 100 | 0);
    const floor = z.sfc ? 'SFC' : String(parseInt(z.lo, 10) / 100 | 0);
    const txt = z.c === 'D' ? `[${ceil}]` : `${ceil}/${floor}`;
    G.labels.addLayer(L.marker([top, mid], { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl lbl-air" style="position:absolute;transform:translate(-50%,-50%);font:600 12px var(--font-mono);color:${z.c === 'C' ? 'var(--air-c)' : 'var(--air-d)'}">${txt}</div>` }), interactive: false, keyboard: false, pane: 'p-label' }));
  }
  for (const z of sua) {
    const p = insidePoint(z);
    G.labels.addLayer(L.marker(p, { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl lbl-air" style="position:absolute;transform:translate(-50%,-50%);font:600 12px var(--font-mono);color:${z.t === 'R' ? 'var(--air-r)' : 'var(--air-c)'}">${esc(z.n)}</div>` }), interactive: false, keyboard: false, pane: 'p-label' }));
  }
  for (const s of D.stadiums) {
    G.labels.addLayer(L.marker([s.lat + 3 * NM / 110574 * 0.86, s.lon], { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl lbl-tfr" style="position:absolute;transform:translate(-50%,-50%);font:600 11px var(--font-mono);color:var(--air-tfr)">TFR ${esc(s.short)}</div>` }), interactive: false, keyboard: false, pane: 'p-label' }));
  }

  // airport and infrastructure symbols (SVG colored by CSS variables, so they follow the theme)
  function apIcon(a) {
    let svg;
    if (a.pub && a.t === 'AD') {
      const col = a.tw ? 'var(--air-d)' : 'var(--air-c)';
      svg = `<svg width="18" height="18" viewBox="-9 -9 18 18"><circle r="7" style="fill:${col}"/><circle r="2.8" style="fill:var(--panel)"/></svg>`;
    } else {
      const ch = a.t === 'HP' ? 'H' : (a.t === 'GL' ? 'G' : (a.t === 'UL' ? 'U' : 'R'));
      svg = `<svg width="16" height="16" viewBox="-8 -8 16 16"><circle r="6.4" style="fill:var(--panel);stroke:var(--muted)" stroke-width="1.4"/><text y="3.1" text-anchor="middle" font-size="8.5" font-weight="700" style="font-family:var(--font-body);fill:var(--muted)">${ch}</text></svg>`;
    }
    const lbl = a.pub && a.t === 'AD' ? `<span class="lbl lbl-ap">${esc(a.id)}</span>` : '';
    return L.divIcon({ className: a.pub && a.t === 'AD' ? 'ap-ic' : 'ap-ic ap-priv', iconSize: [18, 18], iconAnchor: [9, 9], html: svg + lbl });
  }
  for (const a of airports) {
    const m = L.marker([a.lat, a.lon], { icon: apIcon(a), keyboard: false, title: `${a.n} (${a.id})` });
    m.on('click', () => setSpot(a.lat, a.lon));
    (a.pub && a.t === 'AD' ? G.ap : G.priv).addLayer(m);
  }
  for (const i of infra) {
    const svg = i.k === 'power'
      ? '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" style="fill:var(--panel);stroke:var(--s-red)" stroke-width="2"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 10 L7 3 L12 10 Z" style="fill:var(--panel);stroke:var(--s-red)" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    const m = L.marker([i.lat, i.lon], { icon: L.divIcon({ className: 'infra-ic', iconSize: [14, 14], iconAnchor: [7, 7], html: svg }), keyboard: false, title: i.n });
    m.on('click', () => setSpot(i.lat, i.lon));
    G.infra.addLayer(m);
  }

  const ORDER = ['counties', 'cities', 'zone', 'green', 'dgreen', 'water', 'dwater', 'roads', 'droads', 'red', 'dred', 'amber', 'damber', 'parcel', 'airspace', 'sua', 'tfr', 'labels', 'priv', 'ap', 'infra', 'hl', 'pin'];
  const TOGGLES = { 't-red': ['red', 'dred'], 't-amber': ['amber', 'damber'], 't-green': ['green', 'dgreen'], 't-city': ['cities'], 't-zone': ['zone'], 't-parcel': ['parcel'], 't-infra': ['infra'], 't-airspace': ['airspace'], 't-sua': ['sua'], 't-tfr': ['tfr'], 't-ap': ['ap'], 't-priv': ['priv'] };
  // a statewide region keeps its detail squares, private strips and infrastructure off the map below zoom 9, and its
  // public airports below zoom 8, so the state view shows the cities' colors
  const DETAIL_Z = 9;
  const MIN_Z = D.chunks ? { dgreen: DETAIL_Z, dwater: DETAIL_Z, droads: DETAIL_Z, dred: DETAIL_Z, damber: DETAIL_Z, priv: DETAIL_Z, infra: DETAIL_Z, ap: 8 } : {};
  const toggleOf = {};
  for (const [id, groups] of Object.entries(TOGGLES)) for (const g of groups) toggleOf[g] = document.getElementById(id);
  function syncGroups() {
    const z = map.getZoom();
    for (const k of ORDER) {
      const want = (!toggleOf[k] || toggleOf[k].checked) && !(z < (MIN_Z[k] || 0));
      if (want !== map.hasLayer(G[k])) (want ? map.addLayer(G[k]) : map.removeLayer(G[k]));
    }
  }
  for (const id of Object.keys(TOGGLES)) document.getElementById(id).addEventListener('change', syncGroups);
  map.on('zoomend', syncGroups);
  const layersEl = document.getElementById('layers');
  const layersHint = document.getElementById('layersHint');
  const syncHint = () => { layersHint.textContent = layersEl.open ? 'hide' : 'show'; };
  if (matchMedia('(max-width: 860px)').matches) layersEl.open = false;
  syncHint();
  layersEl.addEventListener('toggle', syncHint);

  function zoomClass() {
    const z = map.getZoom();
    const el = map.getContainer();
    el.classList.toggle('map-z-state', z < 7.5);
    el.classList.toggle('map-z-lo', z < 10);
    el.classList.toggle('map-z-mid', z >= 10 && z < 12);
    el.classList.toggle('map-z-hi', z >= 12);
  }
  map.on('zoomend', zoomClass);

  // theme changes repaint the canvas layers
  function restyle() { readColors(); for (const [l, f] of styled) l.setStyle(f()); if (zoneLayer) zoneLayer.redraw(); if (parcelLayer && parcelLayer.refresh) parcelLayer.refresh(); drawHighlight(); }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
  new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });

  // ---------- detail squares and zoning (a statewide region) ----------
  // The base file holds what a statewide view shows; each 1° square's smaller land, water and roads load once the
  // map is zoomed in over it or a spot in it is checked. A feature that crosses squares comes in each of them under
  // one id and is kept once. Austin's zoning loads the same way, near Austin.
  const CH = D.chunks || null;
  const chunkKeys = new Set(CH ? CH.keys : []);
  const chunkLoads = new Map(), chunkDone = new Map(), seenIds = new Set();
  window.heliChunk = (key, data) => { const done = chunkDone.get(key); if (done) done(data); };
  function addDetail(data) {
    for (const o of data.l) if (!seenIds.has(o.i)) { seenIds.add(o.i); const z = landZone(o); lands.push(z); drawLand(z, true); }
    for (const o of data.w) if (!seenIds.has(o.i)) { seenIds.add(o.i); const z = waterZone(o); water.push(z); drawWater(z, true); }
    for (const o of data.r) if (!seenIds.has(o.i)) { seenIds.add(o.i); const r = roadLine(o); roads.push(r); drawRoad(r, true); }
  }
  function loadScript(src, onload, onerror) {
    const el = document.createElement('script');
    el.src = src; el.onload = onload; el.onerror = onerror;
    document.head.appendChild(el);
  }
  function loadChunk(key) {
    if (!chunkKeys.has(key)) return Promise.resolve();
    if (!chunkLoads.has(key)) {
      chunkLoads.set(key, new Promise((resolve) => {
        chunkDone.set(key, (data) => { chunkDone.delete(key); addDetail(data); resolve(); });
        // a square that fails to load is tried again by the next view or spot that needs it
        loadScript(withBuild(`${CH.dir}/${key}.js`), null, () => { chunkLoads.delete(key); chunkDone.delete(key); resolve(); });
      }));
    }
    return chunkLoads.get(key);
  }
  const cellKey = (la, lo) => `${Math.floor(lo)}_${Math.floor(la)}`;
  let zoningLoad = null;
  const inZoningBox = (la, lo) => !!D.zoningBox && lo >= D.zoningBox[0] && la >= D.zoningBox[1] && lo <= D.zoningBox[2] && la <= D.zoningBox[3];
  function ensureZoning() {
    if (!D.zoningFile || zLots.length) return Promise.resolve();
    if (!zoningLoad) {
      zoningLoad = new Promise((resolve) => loadScript(withBuild(D.zoningFile),
        () => { if (window.HELI_ZONING) { decodeZoning(window.HELI_ZONING); addZoneLayer(); syncGroups(); } resolve(); },
        () => { zoningLoad = null; resolve(); }));
    }
    return zoningLoad;
  }
  function loadView() {
    const b = map.getBounds(), z = map.getZoom();
    if (D.zoningBox && z >= 11 && b.intersects(L.latLngBounds([[D.zoningBox[1], D.zoningBox[0]], [D.zoningBox[3], D.zoningBox[2]]]))) ensureZoning();
    if (!CH || z < DETAIL_Z) return;
    const keys = [];
    for (let x = Math.floor(b.getWest()); x <= Math.floor(b.getEast()); x++) for (let y = Math.floor(b.getSouth()); y <= Math.floor(b.getNorth()); y++) keys.push(`${x}_${y}`);
    if (keys.length <= 30) keys.forEach(loadChunk);
  }
  map.on('moveend', loadView);
  // everything a spot check needs at this point: its square, and Austin's zoning if it's near Austin
  const ensureSpot = (la, lo) => Promise.all([CH ? loadChunk(cellKey(la, lo)) : null, inZoningBox(la, lo) ? ensureZoning() : null]);

  // ---------- the spot check ----------
  // rough size of a plant's or dam's grounds around its mapped point
  function infraRadius(i) { return i.k === 'power' ? (i.mw >= 300 ? 350 : i.mw >= 50 ? 200 : 90) : (i.h >= 80 ? 250 : 120); }
  const AP_RADIUS = REGION.airportRadius || {};
  function airportRadius(a) { return AP_RADIUS[a.id] || 700; }
  function nearestRoad(la, lo, maxM) {
    const dLa = maxM / 110574, dLo = maxM / (111320 * Math.cos(la * Math.PI / 180));
    let best = null;
    for (const r of roads) {
      const b = r.bb;
      if (la < b[0] - dLa || la > b[2] + dLa || lo < b[1] - dLo || lo > b[3] + dLo) continue;
      for (let i = 1; i < r.line.length; i++) {
        const m = segMeters(la, lo, r.line[i - 1], r.line[i]);
        if (m <= maxM && (!best || m < best.d)) best = { r, d: m };
      }
    }
    return best;
  }
  function austinLakeName(lo) { return lo < -97.7855 ? 'Lake Austin' : 'Lady Bird Lake'; }
  const HOSPITAL = /hospital|medical|health|children|seton|baylor|st david|heart|starflight|air rescue|9-1-1|carilion|lewisgale|clinic/i;

  // known: what a parcel lookup found, when it has answered ({ parcelGap: true } where no parcel covers the spot)
  function check(la, lo, known) {
    const hits = [];
    const add = (id, where) => {
      const r = RULES[id];
      if (!r) return;
      const h = hits.find((x) => x.id === id);
      if (h) { if (where && !h.where.includes(where)) h.where.push(where); return; }
      hits.push({ id, r, level: r.level, where: where ? [where] : [] });
    };
    const res = { la, lo };
    res.place = places.find((z) => inZone(z, la, lo)) || null;
    res.county = counties.find((z) => inZone(z, la, lo)) || null;
    // an independent city is its own county-equivalent; near its edge the simplified limits can miss the spot
    if (!res.place && res.county && res.county.ic) res.place = places.find((p) => p.n === res.county.n) || null;
    res.lands = lands.filter((z) => z.def.s !== 'none' && inZone(z, la, lo)).sort((a, b) => a.area - b.area);
    res.water = water.filter((z) => inZone(z, la, lo)).map((z) => {
      if (z.k === 'lake_austin_city' && lo > -97.7135) return { ...z, n: 'Colorado River (below Longhorn Dam)', def: withLevel(WATER.river) };
      if (z.k === 'lake_austin_city') return { ...z, n: austinLakeName(lo) };
      return z;
    });
    res.air = airspace.filter((z) => inZone(z, la, lo));
    res.sua = sua.filter((z) => inZone(z, la, lo));
    res.tfr = D.stadiums.filter((s) => meters(la, lo, s.lat, s.lon) <= 3 * NM);
    const aps = airports.map((a) => ({ a, d: meters(la, lo, a.lat, a.lon) }));
    res.atPub = aps.filter((x) => x.a.pub && x.a.t === 'AD' && x.d <= airportRadius(x.a)).sort((p, q) => p.d - q.d)[0] || null;
    res.atPriv = res.atPub ? null : (aps.filter((x) => !x.a.pub && x.d <= (x.a.t === 'HP' ? 150 : 600)).sort((p, q) => p.d - q.d)[0] || null);
    res.nearPub = aps.filter((x) => x.a.pub && x.a.t === 'AD').sort((p, q) => p.d - q.d)[0] || null;
    res.infra = infra.map((i) => ({ i, d: meters(la, lo, i.lat, i.lon) })).filter((x) => x.d <= infraRadius(x.i)).sort((p, q) => p.d - q.d);
    res.road = res.atPub ? null : nearestRoad(la, lo, 40);
    // Austin zones every lot but not its streets, so a spot between lots is almost always a street, alley or rail line
    res.lot = zoned(res.place) ? lotAt(la, lo) : null;
    res.lotGap = zoned(res.place) && !res.lot && !res.water.length && !res.lands.length && !res.road && !res.atPub ? nearLot(la, lo, 20) : null;

    // land and water (wilderness lies inside the national forest, and its ban wins)
    const inWilderness = res.lands.some((z) => z.k === 'wilderness');
    for (const z of res.lands) if (!(inWilderness && z.k === 'usfs')) for (const id of z.def.rules) add(id, `${z.n}${z.m && z.m !== z.n ? ` · ${z.m}` : ''}`);
    for (const z of res.water) for (const id of z.def.rules) add(id, z.n);
    for (const x of res.infra) add(x.i.k === 'power' ? 'critical_infra' : 'dam', `${x.i.n}${x.i.k === 'power' ? ` (${x.i.op}, ${x.i.mw} MW)` : ` (${x.i.h} ft)`}, ${nmStr(x.d)} away`);
    if (res.road) add('roadway', `${res.road.r.n || 'Highway'}, about ${Math.round(res.road.d / 0.3048 / 10) * 10} ft away (map roads are simplified)`);
    // airspace
    for (const z of res.sua) add(z.t === 'R' ? 'restricted' : 'alert', `${z.n}, SFC to ${z.hi} · ${z.tm}`);
    for (const z of res.air) {
      if (z.c === 'B') add(z.sfc ? 'class_b' : 'class_b_shelf', `${(REGION.airspaceNames || {})[z.id] || airportName(z.id)} Class B, ${z.lo} to ${z.hi}`);
      else if (z.c === 'C') add(z.sfc ? 'class_c' : 'class_c_shelf', `${(REGION.airspaceNames || {})[z.id] || airportName(z.id)} Class C, ${z.lo} to ${z.hi}${z.hrs ? `; ${z.hrs}` : ''}`);
      else add('class_d', `${airportName(z.id)} (${z.id}) Class D, SFC to ${z.hi}${z.hrs ? `; ${z.hrs}` : ''}`);
    }
    for (const s of res.tfr) add('tfr_stadium', `${s.n}: ${s.ev}`);
    // landing facilities
    if (res.atPub) add('airport_public', `${res.atPub.a.n} (${res.atPub.a.id})`);
    if (res.atPriv) {
      const a = res.atPriv.a;
      add(a.mil ? 'heliport_military' : HOSPITAL.test(a.n) ? 'heliport_hospital' : (a.t === 'HP' ? 'heliport_private' : 'private_strip'), `${a.n} (${a.id})`);
    }
    // Austin zoning decides whether the city can permit a landing site here (an existing heliport already has its answer)
    if (res.lot && !res.atPub && !res.atPriv) {
      const t = res.lot.t;
      const offLimits = res.lands.some((z) => z.def.s === 'red') || res.water.some((z) => z.def.s === 'red');
      const extra = t.base === 'PUD' ? '. A PUD’s own ordinance can rule out uses the district otherwise allows' : t.base === 'AV' ? '. Aviation facilities are a permitted use in this district' : '';
      if (t.cls === 'res') add('austin_res', `${t.code}: ${t.name}`);
      else if (!offLimits) add(t.cls === 'unz' ? 'austin_unzoned' : 'austin_permit', `${t.code}: ${t.name}${extra}`);
    } else if (res.lotGap) add('roadway', `Between zoning lots (${Math.round(res.lotGap.d / 0.3048)} ft from the nearest), so most likely a street, alley or rail line`);
    // the same reading from the county's parcel map: land outside every parcel is almost always right-of-way
    res.parcelGap = !!(known && known.parcelGap) && !!res.county && !res.lot && !res.lotGap && !res.road && !res.water.length && !res.lands.length && !res.infra.length && !res.atPub && !res.atPriv;
    if (res.parcelGap) add('roadway', 'No parcel on the county’s parcel map here, so most likely a road, rail line or other right-of-way');
    // jurisdiction (the region's rules are one state's; a spot over the state line only gets a pointer)
    res.outOfState = !!(res.county && res.county.st && res.county.st !== REGION.state);
    res.abroad = !res.county && !!RULES.outside_us;
    if (res.abroad) add('outside_us', 'No US county here: Mexico, or offshore in the Gulf');
    else if (res.outOfState) add('other_state', `${countyName(res.county)}, ${STATE_NAMES[res.county.st] || res.county.st}`);
    else if (res.place) {
      const cr = cityRuleOf(res.place);
      const note = CITY_NOTES[res.place.n];
      add(cr ? cr.rule : 'city_other', note ? `${res.place.n}: ${note}` : `${placeKind(res.place)} of ${res.place.n}`);
    } else add('unincorporated', `${res.county ? countyName(res.county) : 'County'}, outside city and town limits`);
    const offLimitsLand = res.lands.some((z) => z.def.s === 'red');
    if (res.county && !res.place && !res.outOfState && !offLimitsLand && (REGION.countyRules || {})[countyName(res.county)]) add(REGION.countyRules[countyName(res.county)], countyName(res.county));
    const parkRule = res.county && (REGION.countyParkRules || {})[countyName(res.county)];
    if (parkRule) for (const z of res.lands) if (z.k === 'park_county') add(parkRule, z.n);
    add('baseline_faa');
    add('baseline_consent');
    add('baseline_conduct');

    const lv = (l) => hits.some((h) => h.level === l);
    res.verdict = lv('red') ? 'red' : res.atPub ? 'blue' : lv('amber') ? 'amber' : 'green';
    const rank = { red: 0, amber: 1, blue: 2, green: 3, info: 4 };
    res.hits = hits.sort((a, b) => rank[a.level] - rank[b.level]);
    return res;
  }
  function airportName(id) { const a = airports.find((x) => x.id === id); return a ? a.n : id; }

  function spotName(res) {
    if (res.atPub) return res.atPub.a.n;
    if (res.atPriv) return res.atPriv.a.n;
    if (res.lands.length) return res.lands[0].n;
    if (res.water.length) return res.water[0].n;
    if (res.infra.length) return res.infra[0].i.n;
    if (res.road) return `Beside ${res.road.r.n || 'a highway'}`;
    if (res.lotGap) return `Street or alley in ${res.place.n}`;
    if (res.parcelGap) return 'Road or other right-of-way';
    if (res.lot) return `${LOT_NAME[res.lot.t.base] || LOT_NAME[res.lot.t.cls]} in ${res.place.n}`;
    if (res.abroad) return 'Outside the United States';
    return res.place ? `Private land in ${res.place.n}` : `Private land, ${res.county ? (res.county.ic ? `City of ${res.county.n}` : `unincorporated ${res.county.n} County`) : 'unincorporated area'}`;
  }
  const LOT_NAME = {
    res: 'Residential lot', com: 'Commercial lot', ind: 'Industrial lot', unz: 'Unzoned land', sp: 'Special district', UNK: 'Lot',
    P: 'Public land', PUD: 'Planned development', DR: 'Reserve land', AV: 'Aviation district', AG: 'Farmland',
    TOD: 'Transit district', NBG: 'North Burnet/Gateway district', ERC: 'East Riverside district', TND: 'Neighborhood district',
  };

  const ICON = {
    red: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M5 15 L15 5"/></svg>',
    amber: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M10 5v6"/><circle cx="10" cy="14.6" r="0.6" fill="currentColor"/></svg>',
    green: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10.5 L8.5 14 L15 6.5"/></svg>',
    blue: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v12M14 4v12M6 10h8"/></svg>',
  };
  const VERDICT = {
    red: ['Off-limits', (n) => `A landing here breaks ${n === 1 ? 'a rule that applies' : `${n} rules that apply`} to this spot. What it can cost is listed below.`],
    amber: ['Ask first', () => 'Legal only with the owner’s permission, a permit or an ATC clearance, as listed below.'],
    green: ['OK with the landowner’s permission', () => 'No park, preserve, airspace or local rule on this map blocks this spot. You still need the owner’s consent and a safe site.'],
    blue: ['Airport: land here', () => 'A public-use airport. Follow its procedures and any ATC instructions.'],
  };
  const LEVEL_WORD = { red: 'Prohibited', amber: 'Condition', green: 'OK', blue: 'Airport', info: 'Applies' };

  function ruleCard(h) {
    const r = h.r;
    const where = h.where.length ? `<div class="where">${h.where.map(esc).join('<br>')}</div>` : '';
    const who = r.who ? `<dt>Enforced by</dt><dd>${esc(r.who)}</dd>` : '';
    const pen = r.pen && r.pen.length ? `<dt>${r.level === 'red' ? 'Max penalty' : 'If ignored'}</dt><dd><ul>${r.pen.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></dd>` : '';
    const cites = r.cites && r.cites.length ? `<div class="cites">${r.cites.map((c) => (c.u ? `<a class="cite" href="${esc(c.u)}" target="_blank" rel="noopener">${esc(c.t)}</a>` : `<span class="cite">${esc(c.t)}</span>`)).join('')}</div>` : '';
    const note = r.note ? `<p class="hint">${esc(r.note)}</p>` : '';
    return `<article class="rule lv-${h.level}"><div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><h3>${esc(r.title)}</h3><span class="badge lv-${h.level}">${LEVEL_WORD[h.level]}</span></div>${where}<p>${esc(r.text)}</p>${note}${who || pen ? `<dl class="meta">${who}${pen}</dl>` : ''}${cites}</article>`;
  }

  // a shareable link to the spot, when the page is its own tab (inside a frame the address isn't the page's)
  const canLink = (() => { try { return window.self === window.top && /^https?:/.test(location.protocol); } catch { return false; } })();
  // the public site, where address search and owner lookups can reach their outside services
  const SITE = 'https://jesseclay.github.io/heli-landing-map/', SITE_HOST = 'jesseclay.github.io';
  const spotPane = document.getElementById('pane-spot');
  let current = null;
  function render(res, opts) {
    const [vt, vs] = VERDICT[res.verdict];
    const main = res.hits.filter((h) => !RULES[h.id].always);
    const always = res.hits.filter((h) => RULES[h.id].always);
    const nRed = main.filter((h) => h.level === 'red').length;
    const air = res.air.filter((z) => z.sfc || z.c === 'D');
    const airTxt = air.length
      ? air.map((z) => (z.c === 'D' ? `Class D (${z.id}), SFC–${z.hi}${z.hrs ? `; ${z.hrs}` : ''}` : `Class ${z.c} surface area, SFC–${z.hi}`)).join('; ')
      : (res.air.length ? `Under the Class ${res.air[0].c} shelf (floor ${res.air[0].lo})` : 'Class G (uncontrolled) near the ground');
    const jur = res.place
      ? `${placeKind(res.place)} of ${res.place.n}${res.county && !res.county.ic ? `, ${res.county.n} County` : ''}`
      : res.county ? (res.county.ic ? `City of ${res.county.n}` : `Unincorporated ${res.county.n} County`) : res.abroad ? 'Mexico or offshore' : 'Unincorporated';
    const jurAll = res.outOfState ? `${jur}, ${STATE_NAMES[res.county.st] || res.county.st}` : jur;
    const np = res.nearPub && !res.atPub ? `${esc(res.nearPub.a.n)} (<span class="mono">${esc(res.nearPub.a.id)}</span>), ${nmStr(res.nearPub.d)} ${compass(bearing(res.la, res.lo, res.nearPub.a.lat, res.nearPub.a.lon))}` : '';
    const zoneTxt = res.lot ? `<span class="mono">${esc(res.lot.t.code)}</span> · ${esc(res.lot.t.name)}` : res.lotGap ? 'None (between lots)' : '';
    spotPane.innerHTML = `
      <div class="spot-head">
        <div class="coords"><span>${fmtLL(res.la, res.lo)}</span>${opts && opts.example ? '<span class="example-tag">Example spot</span>' : ''}${canLink && !(opts && opts.example) ? '<button type="button" class="linkbtn" id="copyLink">Copy link</button>' : ''}</div>
        <h2 class="spot-name">${esc(spotName(res))}</h2>
        ${opts && opts.addr ? `<div class="addr">${esc(opts.addr)}</div>` : ''}
      </div>
      <div class="verdict lv-${res.verdict}" role="status">
        <div class="v-icon" aria-hidden="true">${ICON[res.verdict]}</div>
        <div class="v-title">${vt}</div>
        <div class="v-sub">${esc(vs(nRed))}</div>
      </div>
      <dl class="facts">
        <dt>Jurisdiction</dt><dd>${esc(jurAll)}</dd>
        ${zoneTxt ? `<dt>Zoning</dt><dd>${zoneTxt}</dd>` : ''}
        <dt>Airspace</dt><dd>${esc(airTxt)}</dd>
        ${np ? `<dt>Nearest airport</dt><dd>${np}</dd>` : ''}
      </dl>
      ${PARCELS ? `<section class="owner" id="owner" aria-live="polite">${ownerHtml(res)}</section>` : ''}
      <div class="group-title"><span class="eyebrow">What applies here</span><span class="hint">${main.length} ${main.length === 1 ? 'rule' : 'rules'}</span></div>
      <div class="rules">${main.map(ruleCard).join('')}</div>
      <details class="baseline" style="margin-top:14px">
        <summary class="group-title" style="margin:0"><span class="eyebrow"><span class="chev">›</span> Applies everywhere</span><span class="hint">${always.length} rules</span></summary>
        <div class="rules" style="margin-top:10px">${always.map(ruleCard).join('')}</div>
      </details>
      <div class="group-title"><span class="eyebrow">Try another spot</span></div>
      <div class="examples">${EXAMPLES.map((e, i) => `<button class="chip lv-${e.lv}" data-ex="${i}"><span class="dot"></span>${esc(e.n)}</button>`).join('')}</div>
      <p class="foot">This map is a planning aid, not legal advice or a substitute for a preflight briefing. Boundaries are simplified and can be off by a few hundred feet; check NOTAMs, TFRs and the owner's rules before any landing. Rules and penalty figures were checked in ${esc(RB.checked)}.</p>`;
    spotPane.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => { const e = EXAMPLES[+b.dataset.ex]; goTo(e.la, e.lo, e.z || 13); }));
    if (PARCELS) wireOwner(res);
    const cl = document.getElementById('copyLink');
    if (cl) {
      cl.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(location.href); cl.textContent = 'Link copied'; } catch { cl.textContent = 'Copy the address bar'; }
        setTimeout(() => { cl.textContent = 'Copy link'; }, 2200);
      });
    }
  }

  // highlight the zones that produced the verdict
  function drawHighlight() {
    G.hl.clearLayers();
    if (!current) return;
    const res = current;
    const col = (s) => C[s] || C.ink;
    if (res.owner && res.owner.rings) G.hl.addLayer(L.polygon(res.owner.rings, { interactive: false, renderer: rHl, color: C.accent, weight: 2.6, opacity: 1, fill: false }));
    for (const z of res.lands) G.hl.addLayer(L.polygon(z.polys, { interactive: false, renderer: rHl, color: col(z.def.s), weight: 3, opacity: 1, fill: false }));
    for (const z of res.water) G.hl.addLayer(L.polygon(z.polys, { interactive: false, renderer: rHl, color: C.waterEdge, weight: 2.5, opacity: 1, fill: false }));
    if (res.lands.length || res.water.length) return;
    if (res.lot) {
      const rings = res.lot.rings.map((a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push(fromWorld(a[i], a[i + 1])); return o; });
      G.hl.addLayer(L.polygon(rings, { interactive: false, renderer: rHl, color: res.lot.t.cls === 'res' ? C.red : res.lot.t.cls === 'unz' ? C.ink : C.amber, weight: 2.5, opacity: 1, fill: false }));
    } else if (res.place) G.hl.addLayer(L.polygon(res.place.polys, { interactive: false, renderer: rHl, color: C.city, weight: 2.4, opacity: 0.9, fill: false, dashArray: '6 4' }));
  }

  // ---------- landowners ----------
  // The owner of record for the parcel under the pin, asked live from the public parcel service that covers the spot
  // (a statewide parcel layer or the county's own), one parcel per click, as the county's own map does. Nothing is stored.
  async function arcgis(url, params) {
    const r = await fetch(`${url}?${new URLSearchParams({ f: 'json', ...params })}`, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'service error');
    return j;
  }
  function parcelsAt(src, la, lo) {
    const at = { geometry: `${lo},${la}`, geometryType: 'esriGeometryPoint', returnGeometry: 'true', maxAllowableOffset: '0.000005', geometryPrecision: '6' };
    if (src.op === 'identify') {
      const d = 0.001;
      return arcgis(`${src.url}/identify`, { ...at, sr: '4326', layers: `all:${src.layer}`, tolerance: '0', mapExtent: `${lo - d},${la - d},${lo + d},${la + d}`, imageDisplay: '400,400,96' })
        .then((j) => (j.results || []).map((x) => ({ a: x.attributes, g: x.geometry })));
    }
    return arcgis(`${src.url}/${src.layer}/query`, { ...at, inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: fieldNames(src) })
      .then((j) => (j.features || []).map((x) => ({ a: x.attributes, g: x.geometry })));
  }
  const blank = (v) => v == null || /^\s*(null|none|0)?\s*$/i.test(String(v)); // the Texas layer fills gaps with "Null" or "0"
  const tidy = (v) => (blank(v) ? '' : String(v).replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/,(\s*,)+/g, ',').replace(/^[\s,]+|[\s,]+$/g, ''));
  // a field list's entries are joined with commas; an entry that is itself a list (a house number and its street)
  // is joined with spaces
  const fieldsOf = (a, f) => [].concat(f || []).map((k) => (Array.isArray(k) ? k.map((x) => tidy(a[x])).filter(Boolean).join(' ') : tidy(a[k]))).filter(Boolean);
  // every field a source's settings name, so a query asks for only those (Roanoke County's layer has 347)
  function fieldNames(src) {
    const out = new Set();
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'string') out.add(v); };
    Object.values(src.f).forEach(walk);
    for (const m of (src.link || '').matchAll(/\{(\w+)\}/g)) if (m[1] !== 'id') out.add(m[1]);
    if (src.linkField) out.add(src.linkField);
    return [...out].join(',');
  }
  const ringsOf = (g) => (g && g.rings && g.rings.length ? g.rings.map((r) => r.map(([x, y]) => [y, x])) : null);
  function acresOf(rings) {
    const [la0, lo0] = rings[0][0], kx = 111320 * Math.cos(la0 * Math.PI / 180), ky = 110574;
    let s = 0;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][1] - lo0) * kx * (r[i][0] - la0) * ky - (r[i][1] - lo0) * kx * (r[j][0] - la0) * ky;
    }
    return Math.abs(s / 2) / 4046.86;
  }
  const fmtAcres = (a) => (a < 1 ? `${a.toFixed(2)} acres` : a < 10 ? `${a.toFixed(1)} acres` : `${Math.round(a).toLocaleString()} acres`);
  // a rough read of who the owner is, to suggest how to reach them
  const CO_SUFFIX = /\b(L ?L ?C|INC|CORP|CORPORATION|CO(?!-)|COMPANY|L ?P|LTD|L ?L ?P|PLLC|LIMITED)\b/;
  const GOV = /\b(CITY OF|[A-Z]+ COUNTY|COUNTY OF|STATE OF|COMMONWEALTH|UNITED STATES|U ?S ?A|TOWN OF|VILLAGE OF|I ?S ?D|SCHOOL DIST(RICT)?|SCHOOL BOARD|PUBLIC SCHOOLS|UNIVERSITY|COLLEGE|AUTHORITY|LCRA|LOWER COLORADO RIVER|TXDOT|VDOT|DEPT OF|DEPARTMENT OF|FEDERAL|NATIONAL PARK|REGENTS|MUNICIPAL|WATER CONTROL|BOARD OF SUPERVISORS|GOVERNMENT|GOVT|STATE HIGHWAY|VPI|V P I|VA TECH|VIRGINIA TECH)\b/;
  const ORG = /\b(CHURCH|MINISTRY|MINISTRIES|DIOCESE|ASSOCIATION|ASSN|ASSOC|HOA|OWNERS ASSOC|FOUNDATION|CLUB|COOPERATIVE|COOP|RAILROAD|RAILWAY|BANK|HOLDINGS|PROPERTIES|INVESTMENTS|PARTNERS|PARTNERSHIP|VENTURES|DEVELOPMENT|ENTERPRISES|GROUP|REALTY|ELECTRIC|ENERGY|PIPELINE|UTILITY|UTILITIES|CEMETERY)\b/;
  const TRUSTY = /\b(TRUST|TRUSTS|TRUSTEE|TRUSTEES|TR|TRS|ESTATE|EST OF)\b/;
  function ownerKind(names) {
    const s = names.join(' ').toUpperCase();
    if (/CONFIDENTIAL/.test(s)) return 'hidden';
    if (CO_SUFFIX.test(s)) return 'company';
    if (GOV.test(s)) return 'public';
    if (ORG.test(s)) return 'company';
    if (TRUSTY.test(s)) return 'trust';
    return 'person';
  }
  // the house number and first street word, so "403 E LESTER ST NE" and "403 LESTER ST" read as the same address
  const DIRECTION = /^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST)$/;
  function streetKey(line) {
    const m = line.toUpperCase().match(/^(\d+)\s+(.*)$/);
    const word = m && m[2].split(/[\s,.]+/).find((w) => w && !DIRECTION.test(w));
    return word ? `${m[1]} ${word}` : null;
  }
  function mailsHere(o) {
    const k = streetKey(o.situs);
    return !!k && o.parts[0].mail.some((l) => streetKey(l) === k);
  }
  function ownerRecord(src, hits) {
    const f = src.f, parts = [], seen = new Set();
    for (const { a } of hits) {
      let owners = fieldsOf(a, f.owner);
      if (!owners.length) continue;
      // an owner the locality shields (Roanoke County flags them) is treated like a Texas confidential owner
      const shielded = f.shielded && /^(y|yes|true|1)$/i.test(tidy(a[f.shielded]));
      if (shielded) owners = ['CONFIDENTIAL'];
      const care = fieldsOf(a, f.care).filter((c) => !owners.includes(c));
      const lines = [...care, ...fieldsOf(a, f.mail).filter((l) => !owners.includes(l))];
      const place = [tidy(a[f.mailCity]), tidy(a[f.mailState])].filter(Boolean).join(', ');
      const zip = /^\d{5}/.test(tidy(a[f.mailZip])) ? tidy(a[f.mailZip]) : '';
      let mail = !lines.length ? fieldsOf(a, f.mailFull)
        : place ? [...lines, zip ? `${place} ${zip}` : place]
        : zip ? [...lines.slice(0, -1), `${lines[lines.length - 1]} ${zip}`] // the city is already in the last line
        : lines;
      if (shielded) mail = [];
      const key = `${owners.join('|')}#${mail.join('|')}`;
      if (!seen.has(key)) { seen.add(key); parts.push({ owners, mail }); }
    }
    const { a, g } = hits[0], rings = ringsOf(g);
    return {
      parts, rings, acres: rings ? acresOf(rings) : null, situs: fieldsOf(a, f.situs).join(', '), id: tidy(a[f.id]), legal: fieldsOf(a, f.legal).join(' '),
      alt: tidy(a[f.alt]), county: tidy(a[f.county]), year: tidy(a[f.year]), attrs: a,
    };
  }
  async function lookupOwner(res) {
    const st = res.county && res.county.st ? res.county.st : REGION.state, loc = res.county ? countyName(res.county) : '';
    // a county's own service first where it has one, then the statewide layer
    const srcs = PARCELS.sources.filter((s) => s.state === st && (!s.only || s.only.includes(loc)));
    if (!srcs.length) return { state: 'none', st, loc };
    let err = null;
    for (const src of srcs) {
      try {
        const hits = await parcelsAt(src, res.la, res.lo);
        if (!hits.length) { if (src.only) continue; return { state: 'gap', src, st, loc }; }
        const rec = ownerRecord(src, hits);
        // failed: the locality's own service didn't answer, so this came from the statewide layer
        return { ...rec, state: rec.parts.length ? 'ok' : 'noowner', src, st, loc, failed: !!err };
      } catch (e) { err = err || e; }
    }
    if (err) throw err;
    return { state: 'gap', src: srcs[srcs.length - 1], st, loc };
  }
  let ownerSeq = 0;
  function loadOwner(res) {
    const seq = ++ownerSeq;
    res.owner = { state: 'loading' };
    lookupOwner(res)
      // a sandboxed preview refuses outside requests; the website can make them
      .catch((e) => ({ state: e instanceof TypeError && location.hostname !== SITE_HOST ? 'blocked' : 'error' }))
      .then((o) => {
        if (seq !== ownerSeq || current !== res) return;
        res.owner = o;
        if (o.state === 'gap') {
          // no parcel: recheck the spot as right-of-way, which can change the verdict
          const next = check(res.la, res.lo, { parcelGap: true });
          if (next.parcelGap) {
            next.owner = o; next.opts = res.opts; current = next;
            render(next, next.opts);
            drawHighlight();
            return;
          }
        }
        const el = document.getElementById('owner');
        if (el) { el.innerHTML = ownerHtml(res); wireOwner(res); }
        drawHighlight();
      });
  }
  const capWords = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  function rollTitle(o) {
    if (!o.src) return '';
    if (o.src.title) return o.src.title.replace('{loc}', o.loc);
    return `${o.county ? `${capWords(o.county)} County` : o.loc} appraisal roll${o.year ? `, ${o.year}` : ''}`;
  }
  // the parcel's official record: a Texas appraisal district's page, a link pattern filled from the parcel ({id}, {id9}
  // for the ID zero-padded to 9 digits, {year}, or any {FIELD}), or a link the record carries itself
  function fillLink(tpl, o) {
    let ok = true;
    const u = tpl.replace(/\{(\w+)\}/g, (m, k) => {
      const pad = /^id(\d+)$/.exec(k);
      const v = k === 'id' ? o.id : pad ? o.id.padStart(+pad[1], '0') : k === 'year' ? o.year : k === 'countyslug' ? (o.county || '').toLowerCase().replace(/[^a-z]/g, '') : tidy(o.attrs[k]);
      if (!v) ok = false;
      return encodeURIComponent(v);
    });
    return ok ? u : null;
  }
  function recordUrl(o) {
    const s = o.src;
    if (!s || !o.id) return null;
    const label = s.linkLabel || 'County record';
    if (s.linkField) { const u = tidy(o.attrs[s.linkField]); return /^https?:\/\//i.test(u) ? [label, u] : null; }
    const tpl = s.records ? s.records[(o.county || '').toLowerCase()] : s.link;
    if (!tpl && s.recordsFallback) { const f = fillLink(s.recordsFallback[1], o); return f ? [s.recordsFallback[0], f] : null; }
    const u = tpl && fillLink(tpl, o);
    return u ? [label, u] : null;
  }
  const extLink = (label, u) => `<a class="cite" href="${esc(u)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;
  function ownerHtml(res) {
    const o = res.owner || { state: 'idle' };
    const head = (right) => `<div class="group-title"><span class="eyebrow">Landowner</span>${right ? `<span class="hint">${esc(right)}</span>` : ''}</div>`;
    const box = (inner) => `<div class="owner-card">${inner}</div>`;
    const viewer = o.src && o.src.viewer ? extLink(o.src.viewerName || 'County parcel map', o.src.viewer) : '';
    if (o.state === 'idle') return head() + box('<p class="hint">Who owns this spot, from the county’s parcel records.</p><div class="cites"><button type="button" class="cite" data-owner="load">Look up the owner</button></div>');
    if (o.state === 'loading') return head() + box('<p class="hint">Looking up the parcel record…</p>');
    if (o.state === 'blocked') return head() + box(`<p class="hint">The owner lookup can’t run in this preview. <a href="${SITE}" target="_blank" rel="noopener">Open the website</a> to see who owns a spot.</p>`);
    if (o.state === 'error') return head() + box(`<p class="hint">The parcel service didn’t answer.</p><div class="cites"><button type="button" class="cite" data-owner="load">Try again</button>${viewer}</div>`);
    if (o.state === 'none') {
      const v = (PARCELS.viewers || {})[o.loc] || (PARCELS.viewers || {})[o.st];
      return head() + box(`<p class="hint">This map has no owner lookup for ${esc(o.loc || STATE_NAMES[o.st] || 'this area')} yet.</p>${v ? `<div class="cites">${extLink(v[0], v[1])}</div>` : ''}`);
    }
    if (o.state === 'gap') return head(rollTitle(o)) + box('<p>No parcel at this spot.</p><p class="hint">Gaps between parcels are usually roads, railways or rivers: public right-of-way or railroad land.</p>');
    const rec = recordUrl(o);
    const facts = [
      o.situs ? `<dt>Property</dt><dd>${esc(o.situs)}</dd>` : '',
      o.acres != null ? `<dt>Size</dt><dd>About ${fmtAcres(o.acres)}</dd>` : '',
      o.id ? `<dt>Parcel</dt><dd><span class="mono">${esc(o.id)}</span>${o.alt && o.alt !== o.id ? ` · tax map <span class="mono">${esc(o.alt)}</span>` : ''}${o.legal ? `<br><span class="hint">${esc(o.legal)}</span>` : ''}</dd>` : '',
    ].join('');
    if (o.state === 'noowner') {
      const v = (PARCELS.viewers || {})[o.loc];
      const why = o.failed ? `${o.loc}’s parcel service didn’t answer, so only the statewide parcel record is shown.`
        : v ? `${o.loc} shows owners only on its own parcel map.` : `This map can’t read owner names for ${o.loc || 'this locality'}.`;
      return head(rollTitle(o)) + box(`<p>${esc(why)}</p><dl class="meta">${facts}</dl><p class="hint">Look the parcel up by its ID${v ? ' on the county’s parcel map' : ' with the county’s real estate office'}.</p><div class="cites">${o.failed ? '<button type="button" class="cite" data-owner="load">Try again</button>' : ''}${rec ? extLink(rec[0], rec[1]) : ''}${v ? extLink(v[0], v[1]) : ''}</div>`);
    }
    const kind = ownerKind(o.parts.flatMap((p) => p.owners));
    const shown = o.parts.slice(0, 6);
    const owners = shown.map((p) => `<dt>Owner</dt><dd class="owner-name">${p.owners.map(esc).join('<br>')}</dd>${p.mail.length ? `<dt>Mail to</dt><dd>${p.mail.map(esc).join('<br>')}</dd>` : ''}`).join('');
    const more = o.parts.length > shown.length ? `<dt></dt><dd class="hint">and ${o.parts.length - shown.length} more owners of record</dd>` : '';
    const biz = (PARCELS.business || {})[o.st];
    const how = {
      hidden: 'The owner’s name and address are confidential by law, so this record can’t say who to ask.',
      public: 'Public land. Ask the office that manages it; the rules below may name the agency.',
      company: `Owned by a company or organization. Write to its mailing address, or find its registered agent and officers in ${biz ? biz[0] : 'the state’s business records'}.`,
      trust: 'Held in a trust or an estate. Write to the trustee or executor at the mailing address.',
      person: !o.parts[0].mail.length ? 'The record lists no mailing address; the county’s tax office may know how to reach the owner.'
        : mailsHere(o) ? 'The owner’s mailing address is this property.' : 'The owner gets mail at another address. Write there first.',
    }[kind];
    const links = [rec ? extLink(rec[0], rec[1]) : '', kind === 'company' && biz ? extLink(biz[0], biz[1]) : '', kind === 'hidden' ? '' : '<button type="button" class="cite" data-owner="copy">Copy name and address</button>'].join('');
    return head(rollTitle(o)) + box(`<dl class="meta">${owners}${more}${facts}</dl><p class="owner-how">${esc(how)}</p><div class="cites">${links}</div><p class="hint owner-note">Tax records give a mailing address, not a phone number. They can trail a recent sale, and a tenant or ranch lessee may control access day to day.</p>`);
  }
  function wireOwner(res) {
    const el = document.getElementById('owner');
    if (!el) return;
    el.querySelectorAll('[data-owner="load"]').forEach((b) => b.addEventListener('click', () => { loadOwner(res); el.innerHTML = ownerHtml(res); }));
    const cp = el.querySelector('[data-owner="copy"]');
    if (cp) {
      cp.addEventListener('click', async () => {
        const text = res.owner.parts.map((p) => [...p.owners, ...p.mail].join('\n')).join('\n\n');
        try { await navigator.clipboard.writeText(text); cp.textContent = 'Copied'; } catch { cp.textContent = 'Copy failed: select the text'; }
        setTimeout(() => { cp.textContent = 'Copy name and address'; }, 2200);
      });
    }
  }

  const pinIcon = L.divIcon({ className: 'pin', iconSize: [30, 30], iconAnchor: [15, 15], html: '<svg viewBox="0 0 30 30"><circle class="ring" cx="15" cy="15" r="11" fill="none" style="stroke:var(--accent)" stroke-width="2"/><circle cx="15" cy="15" r="6.5" style="fill:var(--accent)" /><circle cx="15" cy="15" r="2.4" style="fill:var(--panel)"/><path d="M15 0v6M15 24v6M0 15h6M24 15h6" style="stroke:var(--accent)" stroke-width="2"/></svg>' });
  const pin = L.marker([0, 0], { icon: pinIcon, interactive: false, keyboard: false, pane: 'p-pin' });
  let spotSeq = 0;
  async function setSpot(la, lo, opts) {
    const seq = ++spotSeq;
    pin.setLatLng([la, lo]);
    if (!G.pin.hasLayer(pin)) G.pin.addLayer(pin);
    await ensureSpot(la, lo);
    if (seq !== spotSeq) return; // a newer spot was picked while this one's square loaded
    current = check(la, lo);
    // the page's opening example waits for a click before asking the parcel service
    current.owner = PARCELS && !(opts && opts.initial) ? { state: 'loading' } : { state: 'idle' };
    current.opts = opts;
    drawHighlight();
    if (!(opts && opts.example)) {
      try { history.replaceState(null, '', `#${REGION.key}/${la.toFixed(5)},${lo.toFixed(5)}`); } catch { /* a sandboxed frame can refuse */ }
    }
    render(current, opts);
    if (current.owner.state === 'loading') loadOwner(current);
    selectTab('spot');
    document.getElementById('scroller').scrollTop = 0;
  }
  function goTo(la, lo, z, opts) {
    map.flyTo([la, lo], Math.max(map.getZoom(), z), { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.8 });
    setSpot(la, lo, opts);
  }
  window.__heliGoTo = (la, lo) => { if (inBounds(REGION.bounds, la, lo)) goTo(la, lo, 15); };
  map.on('click', (e) => setSpot(e.latlng.lat, e.latlng.lng));

  // hover readout
  const readout = document.getElementById('readout');
  let raf = 0, lastMove = null;
  map.on('mousemove', (e) => { lastMove = e.latlng; if (!raf) raf = requestAnimationFrame(updateReadout); });
  map.on('mouseout', () => { readout.innerHTML = '<span class="z">Move over the map</span>'; });
  function updateReadout() {
    raf = 0;
    if (!lastMove) return;
    const la = lastMove.lat, lo = lastMove.lng;
    let best = null;
    for (const z of lands) if (z.def.s !== 'none' && (!best || z.area < best.area) && inZone(z, la, lo)) best = z;
    let txt;
    if (best) txt = `${esc(best.n)} <span class="z">· ${{ red: 'off-limits', amber: 'ask first', green: 'open to landing' }[best.def.s]}</span>`;
    else {
      const w = water.find((z) => inZone(z, la, lo));
      const p = places.find((z) => inZone(z, la, lo));
      const lot = zoned(p) && !w ? lotAt(la, lo) : null;
      const cr = cityRuleOf(p), lv = cr && RULES[cr.rule] && RULES[cr.rule].level;
      const cityNote = p ? ` <span class="z">· ${!cr ? 'city rules not checked' : RULES[cr.rule] && RULES[cr.rule].unknown ? 'city code not online' : lv === 'red' ? 'landings banned' : lv === 'amber' ? 'permit needed' : 'no city ban'}</span>` : '';
      txt = w ? `${esc(w.k === 'lake_austin_city' ? (lo > -97.7135 ? 'Colorado River' : austinLakeName(lo)) : w.n)}`
        : lot ? `${esc(p.n)} · ${esc(lot.t.code)} <span class="z">· ${lotNote(lot.t)}</span>`
        : p ? `${esc(p.n)} ${p.lsad === 'town' ? 'town' : 'city'} limits${cityNote}` : '<span class="z">Unincorporated</span>';
    }
    readout.innerHTML = `${fmtLL(la, lo)} · ${txt}`;
  }

  // ---------- search: places on the map as you type, street addresses on Enter ----------
  const qEl = document.getElementById('q');
  const resEl = document.getElementById('results');
  const index = [];
  {
    const seen = new Map();
    for (const z of lands) {
      if (z.def.s === 'none' || /^Unnamed/.test(z.n)) continue;
      const key = z.n.toLowerCase();
      if (!seen.has(key) || seen.get(key).z.area < z.area) seen.set(key, { n: z.n, k: z.def.label, z });
    }
    index.push(...seen.values());
    for (const z of places) index.push({ n: z.n, k: `${placeKind(z)} limits`, z, zoom: 12 });
    for (const z of counties) if (!z.ic) index.push({ n: `${z.n} County`, k: 'County', z, zoom: 10 });
    for (const [n, la, lo] of WATER_LABELS) index.push({ n, k: 'Lake', la, lo, zoom: 12 });
    for (const a of airports) index.push({ n: `${a.n} (${a.id})`, k: a.pub && a.t === 'AD' ? 'Public-use airport' : a.t === 'HP' ? 'Private heliport' : 'Private airfield', la: a.lat, lo: a.lon, zoom: 14 });
    for (const i of infra) if (i.k === 'power' || i.h >= 40) index.push({ n: i.n, k: i.k === 'power' ? 'Power plant' : 'High-hazard dam', la: i.lat, lo: i.lon, zoom: 14 });
    for (const s of D.stadiums) index.push({ n: s.n, k: 'Stadium TFR on event days', la: s.lat, lo: s.lon, zoom: 12 });
    for (const [n, k, la, lo] of D.idx || []) if (!seen.has(n.toLowerCase())) index.push({ n, k: (LAND[k] || WATER[k] || LAND.unknown).label, la, lo, zoom: 15 });
    for (const e of index) e.l = e.n.toLowerCase();
  }
  // rows: local matches, then one row that searches addresses; geo rows replace them once an address search returns
  let rows = [], sel = -1;
  const looksLikeAddress = (q) => /^\d+\s+\S/.test(q) || /,/.test(q);
  function showRows(html) {
    resEl.innerHTML = html;
    resEl.hidden = false;
    resEl.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('mousedown', (ev) => { ev.preventDefault(); choose(rows[+b.dataset.i]); }));
  }
  function rowsHtml() {
    return rows.map((r, i) => `<button role="option" data-i="${i}" aria-selected="${i === sel}"${r.geo === 'ask' ? ' class="geo-ask"' : ''}><span>${r.html || esc(r.n)}</span><span class="rk">${esc(r.k)}</span></button>`).join('');
  }
  function search() {
    const raw = qEl.value.trim(), q = raw.toLowerCase();
    if (q.length < 2) { resEl.hidden = true; rows = []; return; }
    // every word typed has to appear in the name, so "pease park" finds Pease District Park
    const words = q.split(/\s+/).filter(Boolean);
    const local = index.filter((e) => words.every((w) => e.l.includes(w)))
      .map((e) => ({ e, s: (e.l.startsWith(q) ? 0 : e.l.includes(' ' + q) ? 1 : e.l.includes(q) ? 1.5 : 2) + e.l.length / 200 }))
      .sort((a, b) => a.s - b.s).slice(0, 8).map((x) => x.e);
    rows = [...local];
    if (raw.length >= 3) rows.push({ geo: 'ask', q: raw, n: `Find the address “${raw}”`, html: `Find the address “${esc(raw)}”`, k: 'Press Enter' });
    sel = rows.length ? (looksLikeAddress(raw) || !local.length ? rows.length - 1 : 0) : -1;
    if (!rows.length) { showRows('<div class="hint" style="padding:10px 12px">No match on the map. Try a park, town, lake or airport name, or a street address.</div>'); return; }
    showRows(rowsHtml());
  }
  // OpenStreetMap's Nominatim, with Photon (also OpenStreetMap data) if Nominatim is busy. Only on an explicit
  // search, never per keystroke, as Nominatim's usage policy asks.
  let geoBusy = false, geoLast = 0;
  const shortAddr = (a, fallback) => {
    if (!a) return fallback;
    const street = [a.house_number || a.housenumber, a.road || a.street].filter(Boolean).join(' ');
    const town = a.city || a.town || a.village || a.hamlet || a.county || a.locality;
    return [street || a.name || a.amenity, town, a.state].filter(Boolean).filter((v, i, s) => s.indexOf(v) === i).join(', ') || fallback;
  };
  async function geocode(q) {
    const [w, s, e, n] = REGION.bounds;
    try {
      const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us&viewbox=${w},${n},${e},${s}&q=${encodeURIComponent(q)}`;
      const r = await fetch(u);
      if (!r.ok) throw new Error(`Nominatim ${r.status}`);
      return (await r.json()).map((x) => ({ la: +x.lat, lo: +x.lon, n: shortAddr(x.address, x.display_name.split(', ').slice(0, 3).join(', ')) }));
    } catch (err) {
      const u = `https://photon.komoot.io/api/?limit=6&lat=${(s + n) / 2}&lon=${(w + e) / 2}&q=${encodeURIComponent(q)}`;
      const r = await fetch(u);
      if (!r.ok) throw err;
      return (await r.json()).features.filter((f) => f.properties.countrycode === 'US')
        .map((f) => ({ la: f.geometry.coordinates[1], lo: f.geometry.coordinates[0], n: shortAddr(f.properties, f.properties.name || q) }));
    }
  }
  async function addressSearch(q) {
    if (geoBusy || Date.now() - geoLast < 1100) return;
    geoBusy = true; geoLast = Date.now();
    showRows('<div class="hint" style="padding:10px 12px">Searching addresses…</div>');
    try {
      // the same address often comes back as both the building and a business inside it
      const found = (await geocode(q)).filter((g, i, all) => !all.slice(0, i).some((o) => o.n === g.n && meters(o.la, o.lo, g.la, g.lo) < 80));
      rows = found.map((g) => {
        const home = Object.values(REGIONS).find((r) => inBounds(r.bounds, g.la, g.lo));
        return { geo: 'hit', ...g, region: home ? home.key : null, k: home ? (home.key === REGION.key ? 'Address' : `Address · ${home.label} map`) : 'Outside the mapped areas' };
      });
      sel = rows.findIndex((r) => r.region);
      if (!rows.length) showRows('<div class="hint" style="padding:10px 12px">No address found. Add the city, like “… Austin TX”.</div>');
      else showRows(rowsHtml());
    } catch {
      // a preview that blocks outside requests (a claude.ai artifact) can't search; the public site can
      showRows(location.hostname === SITE_HOST
        ? '<div class="hint" style="padding:10px 12px">Address search isn’t reachable right now. Try again in a moment.</div>'
        : `<div class="hint" style="padding:10px 12px">Address search can’t run in this preview. <a href="${SITE}" target="_blank" rel="noopener">Open the website</a> to search addresses.</div>`);
    } finally { geoBusy = false; }
  }
  function choose(r) {
    if (!r) return;
    if (r.geo === 'ask') { addressSearch(r.q); return; }
    if (r.geo === 'hit') {
      if (!r.region) return;
      resEl.hidden = true; qEl.value = r.n; qEl.blur();
      if (r.region !== REGION.key) { location.hash = `${r.region}/${r.la.toFixed(5)},${r.lo.toFixed(5)}`; return; }
      goTo(r.la, r.lo, 16, { addr: r.n });
      return;
    }
    pick(r);
  }
  function pick(e) {
    resEl.hidden = true;
    qEl.value = e.n;
    qEl.blur();
    let la = e.la, lo = e.lo, zoom = e.zoom || 13;
    if (e.z) {
      [la, lo] = insidePoint(e.z);
      const b = e.z.bb;
      if (!e.zoom) {
        const span = Math.max(b[2] - b[0], b[3] - b[1]);
        zoom = span > 0.3 ? 10 : span > 0.1 ? 11.5 : span > 0.03 ? 13 : 14.5;
      }
      map.flyToBounds([[b[0], b[1]], [b[2], b[3]]], { maxZoom: zoom, duration: 0.8, padding: [30, 30] });
      setSpot(la, lo);
      return;
    }
    goTo(la, lo, zoom);
  }
  qEl.addEventListener('input', search);
  qEl.addEventListener('focus', search);
  qEl.addEventListener('blur', () => setTimeout(() => { resEl.hidden = true; }, 150));
  qEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { resEl.hidden = true; return; }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const q = qEl.value.trim();
      if (resEl.hidden && q.length >= 3) { addressSearch(q); return; }
      choose(rows[sel] || (q.length >= 3 ? { geo: 'ask', q } : null));
      return;
    }
    if (resEl.hidden || !rows.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      sel = (sel + (ev.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      resEl.querySelectorAll('button[data-i]').forEach((b, i) => b.setAttribute('aria-selected', i === sel));
    }
  });

  // ---------- tabs and reference panes ----------
  const TABS = ['spot', 'pen', 'check'];
  function selectTab(t) {
    for (const k of TABS) {
      document.getElementById(`tab-${k}`).setAttribute('aria-selected', String(k === t));
      document.getElementById(`pane-${k}`).hidden = k !== t;
    }
  }
  for (const k of TABS) document.getElementById(`tab-${k}`).addEventListener('click', () => { selectTab(k); document.getElementById('scroller').scrollTop = 0; });

  const asOf = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  document.getElementById('pane-pen').innerHTML = `
    <h2>Who enforces what</h2>
    <p class="hint">Maximums under current law for one landing by an individual. Several can stack: an FAA certificate action, a state trespass charge and a park citation can all come from the same landing. Most first cases end in far less than the maximum.</p>
    <div class="pen-list">${RB.penalties.map((p) => `<article class="pen"><h3>${esc(p.t)}</h3><div class="agency">${esc(p.who)}</div><ul>${p.items.map((i) => `<li>${esc(i[0])}: <span class="amt">${esc(i[1])}</span>${i[2] ? `<span class="pcite">${esc(i[2])}</span>` : ''}</li>`).join('')}</ul></article>`).join('')}</div>
    <p class="foot">Not legal advice. Penalty amounts are statutory maximums as checked in ${esc(RB.checked)}; FAA figures are adjusted for inflation each year.</p>`;
  document.getElementById('pane-check').innerHTML = `
    <h2>Before an off-airport landing</h2>
    <ol class="checklist">${RB.checklist.map((c) => `<li><div><strong>${esc(c[0])}</strong>${esc(c[1])}</div></li>`).join('')}</ol>
    <h2>Sources</h2>
    <ul class="sources">${RB.sources.map((s) => `<li><a href="${esc(s[1])}" target="_blank" rel="noopener">${esc(s[0])}</a></li>`).join('')}</ul>
    <p class="foot">Map data: ${esc(REGION.dataNote)}${D.zoningDate || D.zoning ? `; Austin zoning as of ${esc(asOf(D.zoningDate || D.zoning.date))}` : ''}. ${PARCELS && PARCELS.note ? `${esc(PARCELS.note)}. ` : ''}Address search uses OpenStreetMap data through Nominatim and Photon. Event TFRs are drawn where the standing stadium TFR would apply; live TFRs are at tfr.faa.gov.</p>`;

  // ---------- examples and first view ----------
  const findLand = (n) => lands.filter((z) => z.n === n).sort((a, b) => b.area - a.area)[0];
  const EXAMPLES = [];
  for (const [n, where, z, lv] of REGION.examples || []) {
    const pt = Array.isArray(where) ? where : (() => { const l = findLand(where.land); return l ? insidePoint(l) : null; })();
    if (pt) EXAMPLES.push({ n, la: pt[0], lo: pt[1], z, lv });
  }

  window.__heliTest = { check, lotAt, nearLot, zLots, toWorld, fromWorld, map, geocode, lookupOwner, ownerKind, current: () => current }; // TEST-ONLY
  const small = matchMedia('(max-width: 860px)').matches;
  zoomClass();
  if (startAt && inBounds(REGION.bounds, startAt[0], startAt[1])) {
    map.setView(startAt, 15);
    zoomClass();
    syncGroups();
    setSpot(startAt[0], startAt[1]);
  } else {
    map.setView(small && REGION.viewSmall ? REGION.viewSmall : REGION.view, small ? REGION.zoomSmall : REGION.zoom);
    zoomClass();
    syncGroups();
    const first = EXAMPLES[0];
    if (first) setSpot(first.la, first.lo, { example: true, initial: true });
  }
}
