// Picks a region from the URL hash (#austin, #blacksburg/37.22900,-80.41400), loads that region's data file,
// then builds the map and the briefing panel for it.
(function () {
  'use strict';
  const REGIONS = window.HELI_REGIONS;
  function parseHash() {
    const m = /^#([a-z]+)(?:\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?))?/.exec(location.hash || '');
    const key = m && REGIONS[m[1]] ? m[1] : Object.keys(REGIONS)[0];
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
  s.src = REGION.data;
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
  const placeKind = (p) => ({ town: 'Town', village: 'Village' }[p.lsad] || 'City');

  // ---------- what each kind of zone means (kinds come from the build; rule ids from the region's state) ----------
  const LAND = {
    military_federal: { s: 'red', label: 'Military installation', rules: ['military_fed'] },
    military_guard: { s: 'red', label: 'National Guard installation', rules: ['military_guard'] },
    nwr: { s: 'red', label: 'National wildlife refuge', rules: ['nwr', 'esa'] },
    nps: { s: 'red', label: 'National Park Service land', rules: ['nps'] },
    usace: { s: 'red', label: 'Army Corps of Engineers lake land', rules: ['usace'] },
    federal_other: { s: 'red', label: 'Federal land', rules: ['federal_land'] },
    usfs: { s: 'amber', label: 'National forest', rules: ['usfs'] },
    wilderness: { s: 'red', label: 'National forest wilderness', rules: ['wilderness'] },
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
  const CITY_NOTES = REGION.cityNotes || {};
  const MAJOR = new Set(REGION.major || []);
  const WATER_LABELS = REGION.waterLabels || [];

  // ---------- decode the bundle ----------
  const zone = (o) => { const polys = decG(o.g); const bb = bbOf(polys); return { ...o, polys, bb, area: (bb[2] - bb[0]) * (bb[3] - bb[1]) }; };
  const lands = D.lands.map(zone).map((z) => ({ ...z, def: LAND[z.k] || LAND.unknown }));
  const water = D.water.map(zone).map((z) => ({ ...z, def: WATER[z.k] || WATER.lake_other }));
  const places = D.places.map(zone);
  const counties = D.counties.map(zone);
  const airspace = D.airspace.map(zone);
  const sua = D.sua.map(zone);
  const roads = D.roads.map((r) => {
    const line = dec(r.g);
    let s = 90, w = 180, n = -90, e = -180;
    for (const c of line) { if (c[0] < s) s = c[0]; if (c[0] > n) n = c[0]; if (c[1] < w) w = c[1]; if (c[1] > e) e = c[1]; }
    return { ...r, line, bb: [s, w, n, e] };
  });
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
  const zTypes = (D.zoning ? D.zoning.types : []).map(([code, base]) => {
    const b = ZBASE[base] || ZBASE.UNK;
    return { code, base, cls: b[1], name: (/^(I-)?CS-1\b/.test(code) ? 'Commercial-liquor sales' : b[0]) + (code.startsWith('I-') ? ' (interim)' : '') };
  });
  // Lots are kept in Web Mercator world units (256 to the world at zoom 0): tiles draw them as they are, and
  // lookups convert the clicked point instead.
  const WU = 256;
  const mercY = (la) => { const s = Math.sin(la * Math.PI / 180); return WU / 2 - (WU / (4 * Math.PI)) * Math.log((1 + s) / (1 - s)); };
  const toWorld = (la, lo) => [(lo + 180) * WU / 360, mercY(la)];
  const fromWorld = (x, y) => [(2 * Math.atan(Math.exp((WU / 2 - y) * 2 * Math.PI / WU)) - Math.PI / 2) * 180 / Math.PI, x * 360 / WU - 180];
  const zLots = (() => {
    const Z = D.zoning;
    if (!Z) return [];
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
    return lots;
  })();
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
  document.getElementById('tagline').textContent = `Where a private helicopter can and can't put down around ${REGION.name}, and what a prohibited landing can cost. Click any spot on the map, or search an address.`;
  const regionsEl = document.getElementById('regions');
  const regionKeys = Object.keys(REGIONS);
  if (regionKeys.length > 1) {
    regionsEl.innerHTML = regionKeys.map((k) => `<button type="button" data-region="${k}" aria-pressed="${k === REGION.key}">${esc(REGIONS[k].label)}</button>`).join('');
    regionsEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { if (b.dataset.region !== REGION.key) location.hash = b.dataset.region; }));
  } else regionsEl.hidden = true;
  if (!zLots.length) document.getElementById('zoneLegend').hidden = true;

  // ---------- map ----------
  const map = L.map('map', {
    minZoom: 8, maxZoom: 16, zoomSnap: 0.5, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
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
      red: g('--s-red'), amber: g('--s-amber'), green: g('--s-green'), blue: g('--s-blue'), ink: g('--ink'), panel: g('--panel'),
      fillRed: num('--fill-red', 0.26), fillAmber: num('--fill-amber', 0.2), cityTint: num('--city-tint', 0.14),
      zoneHatch: num('--zone-hatch', 0.5), zoneRes: num('--zone-res-fill', 0.08), zoneOk: num('--zone-ok-fill', 0.12),
    };
  }
  readColors();

  const G = {};
  ['counties', 'cities', 'zone', 'water', 'roads', 'red', 'amber', 'airspace', 'sua', 'tfr', 'ap', 'priv', 'infra', 'labels', 'hl', 'pin'].forEach((k) => { G[k] = L.layerGroup(); });
  const styled = []; // [layer, fn] pairs, restyled on theme change
  function add(group, layer, styleFn) { layer.setStyle(styleFn()); styled.push([layer, styleFn]); group.addLayer(layer); return layer; }
  const noI = { interactive: false };

  for (const z of counties) add(G.counties, L.polygon(z.polys, { ...noI, renderer: rBase }), () => ({ color: C.county, weight: 1, dashArray: '5 4', opacity: 0.7, fill: false }));
  for (const z of places) {
    const tint = (CITY[z.reg] || {}).tint;
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rBase }), () => ({ color: C.city, weight: 1, opacity: 0.5, fillColor: C.cityFill, fillOpacity: 0.55 }));
    if (!tint) continue;
    // a city that restricts landings gets a wash under its zoning and water and a bold border above them,
    // so the whole area it covers reads at a glance
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rTint }), () => ({ stroke: false, fillColor: C[tint], fillOpacity: C.cityTint }));
    add(G.cities, L.polygon(z.polys, { ...noI, renderer: rLand }), () => ({ color: C[tint], weight: 2.4, opacity: 0.95, dashArray: '9 4', fill: false }));
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
  const zoneLayer = zLots.length ? (() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { bb } of zLots) { x0 = Math.min(x0, bb[0]); y0 = Math.min(y0, bb[1]); x1 = Math.max(x1, bb[2]); y1 = Math.max(y1, bb[3]); }
    return new ZoneTiles({ pane: 'p-zone', updateWhenZooming: false, keepBuffer: 3, bounds: L.latLngBounds([fromWorld(x0, y1), fromWorld(x1, y0)]) });
  })() : null;
  if (zoneLayer) G.zone.addLayer(zoneLayer);
  for (const z of water) add(G.water, L.polygon(z.polys, { ...noI, renderer: rWater }), () => ({ color: C.waterEdge, weight: 0.8, opacity: 0.9, fillColor: C.water, fillOpacity: 1 }));
  for (const r of roads) {
    const p = r.c === 'P';
    add(G.roads, L.polyline(r.line, { ...noI, renderer: rRoad }), () => ({ color: p ? C.road : C.roadMinor, weight: p ? 2.4 : 1.4, opacity: 0.9, lineCap: 'round' }));
  }
  for (const z of lands) {
    if (z.def.s !== 'red' && z.def.s !== 'amber') continue;
    add(z.def.s === 'red' ? G.red : G.amber, L.polygon(z.polys, { ...noI, renderer: rLand }), () => ({ color: C[z.def.s], weight: 0.9, opacity: 0.9, fillColor: C[z.def.s], fillOpacity: z.def.s === 'red' ? C.fillRed : C.fillAmber }));
  }
  for (const z of airspace) {
    const c = z.c === 'C';
    add(G.airspace, L.polygon(z.polys, { ...noI, renderer: rAir }), () => ({ color: c ? C.c : C.d, weight: c ? (z.sfc ? 2.6 : 1.6) : 2, dashArray: c ? null : '7 5', opacity: 0.95, fill: c && z.sfc, fillColor: C.c, fillOpacity: 0.05 }));
  }
  for (const z of sua) {
    const r = z.t === 'R';
    add(G.sua, L.polygon(z.polys, { ...noI, renderer: rAir }), () => ({ color: r ? C.r : C.c, weight: r ? 2.2 : 1.6, dashArray: r ? '2 4' : '1 5', opacity: 0.95, fillColor: r ? C.r : C.c, fillOpacity: r ? 0.12 : 0.05 }));
  }
  for (const s of D.stadiums) {
    add(G.tfr, L.circle([s.lat, s.lon], { ...noI, radius: 3 * NM, renderer: rAir }), () => ({ color: C.tfr, weight: 2, dashArray: '8 6', opacity: 0.95, fillColor: C.tfr, fillOpacity: 0.05 }));
  }

  // labels
  const label = (lat, lon, cls, text) => L.marker([lat, lon], { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl ${cls}">${esc(text)}</div>` }), interactive: false, keyboard: false, pane: 'p-label' });
  for (const z of counties) if (!z.ic) G.labels.addLayer(label(z.l[0], z.l[1], 'lbl-county', `${z.n} Co.`));
  for (const z of places) G.labels.addLayer(label(z.l[0], z.l[1], `lbl-city${MAJOR.has(z.n) ? ' major' : ''}`, z.n));
  for (const [n, la, lo, m] of WATER_LABELS) G.labels.addLayer(label(la, lo, `lbl-water ${m}`, n));
  const hideAir = new Set(REGION.hideAirspaceLabels || []);
  for (const z of airspace) {
    if (hideAir.has(z.id)) continue;
    const top = z.bb[2] - (z.bb[2] - z.bb[0]) * 0.07;
    const mid = (z.bb[1] + z.bb[3]) / 2;
    const ceil = String(parseInt(z.hi, 10) / 100 | 0);
    const floor = z.sfc ? 'SFC' : String(parseInt(z.lo, 10) / 100 | 0);
    const txt = z.c === 'C' ? `${ceil}/${floor}` : `[${ceil}]`;
    G.labels.addLayer(L.marker([top, mid], { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl" style="position:absolute;transform:translate(-50%,-50%);font:600 12px var(--font-mono);color:${z.c === 'C' ? 'var(--air-c)' : 'var(--air-d)'}">${txt}</div>` }), interactive: false, keyboard: false, pane: 'p-label' }));
  }
  for (const z of sua) {
    const p = insidePoint(z);
    G.labels.addLayer(L.marker(p, { icon: L.divIcon({ className: 'lbl-wrap', iconSize: [0, 0], html: `<div class="lbl" style="position:absolute;transform:translate(-50%,-50%);font:600 12px var(--font-mono);color:${z.t === 'R' ? 'var(--air-r)' : 'var(--air-c)'}">${esc(z.n)}</div>` }), interactive: false, keyboard: false, pane: 'p-label' }));
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

  const ORDER = ['counties', 'cities', 'zone', 'water', 'roads', 'red', 'amber', 'airspace', 'sua', 'tfr', 'labels', 'priv', 'ap', 'infra', 'hl', 'pin'];
  ORDER.forEach((k) => G[k].addTo(map));
  const TOGGLES = { 't-red': ['red'], 't-amber': ['amber'], 't-city': ['cities'], 't-zone': ['zone'], 't-infra': ['infra'], 't-airspace': ['airspace'], 't-sua': ['sua'], 't-tfr': ['tfr'], 't-ap': ['ap'], 't-priv': ['priv'] };
  for (const [id, groups] of Object.entries(TOGGLES)) {
    const el = document.getElementById(id);
    el.addEventListener('change', () => groups.forEach((g) => (el.checked ? map.addLayer(G[g]) : map.removeLayer(G[g]))));
  }
  const layersEl = document.getElementById('layers');
  const layersHint = document.getElementById('layersHint');
  const syncHint = () => { layersHint.textContent = layersEl.open ? 'hide' : 'show'; };
  if (matchMedia('(max-width: 860px)').matches) layersEl.open = false;
  syncHint();
  layersEl.addEventListener('toggle', syncHint);

  function zoomClass() {
    const z = map.getZoom();
    const el = map.getContainer();
    el.classList.toggle('map-z-lo', z < 10);
    el.classList.toggle('map-z-mid', z >= 10 && z < 12);
    el.classList.toggle('map-z-hi', z >= 12);
  }
  map.on('zoomend', zoomClass);

  // theme changes repaint the canvas layers
  function restyle() { readColors(); for (const [l, f] of styled) l.setStyle(f()); if (zoneLayer) zoneLayer.redraw(); drawHighlight(); }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
  new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });

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

  function check(la, lo) {
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
    res.lands = lands.filter((z) => z.def.s !== 'none' && inZone(z, la, lo)).sort((a, b) => a.area - b.area);
    res.water = water.filter((z) => inZone(z, la, lo)).map((z) => {
      if (z.k === 'lake_austin_city' && lo > -97.7135) return { ...z, n: 'Colorado River (below Longhorn Dam)', def: WATER.river };
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

    // land and water
    for (const z of res.lands) for (const id of z.def.rules) add(id, `${z.n}${z.m && z.m !== z.n ? ` · ${z.m}` : ''}`);
    for (const z of res.water) for (const id of z.def.rules) add(id, z.n);
    for (const x of res.infra) add(x.i.k === 'power' ? 'critical_infra' : 'dam', `${x.i.n}${x.i.k === 'power' ? ` (${x.i.op}, ${x.i.mw} MW)` : ` (${x.i.h} ft)`}, ${nmStr(x.d)} away`);
    if (res.road) add('roadway', `${res.road.r.n || 'Highway'}, about ${Math.round(res.road.d / 0.3048 / 10) * 10} ft away (map roads are simplified)`);
    // airspace
    for (const z of res.sua) add(z.t === 'R' ? 'restricted' : 'alert', `${z.n}, SFC to ${z.hi} · ${z.tm}`);
    for (const z of res.air) {
      if (z.c === 'C') add(z.sfc ? 'class_c' : 'class_c_shelf', `${(REGION.airspaceNames || {})[z.id] || airportName(z.id)} Class C, ${z.lo} to ${z.hi}${z.hrs ? `; ${z.hrs}` : ''}`);
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
    // jurisdiction
    if (res.place) {
      const cr = CITY[res.place.reg];
      const note = CITY_NOTES[res.place.n];
      add(cr ? cr.rule : 'city_other', note ? `${res.place.n}: ${note}` : `${placeKind(res.place)} of ${res.place.n}`);
    } else add('unincorporated', `${res.county ? countyName(res.county) : 'County'}, outside city and town limits`);
    if (res.county && !res.place && (REGION.countyRules || {})[res.county.n]) add(REGION.countyRules[res.county.n], countyName(res.county));
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
    if (res.lot) return `${LOT_NAME[res.lot.t.base] || LOT_NAME[res.lot.t.cls]} in ${res.place.n}`;
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
  const spotPane = document.getElementById('pane-spot');
  let current = null;
  function render(res, opts) {
    const [vt, vs] = VERDICT[res.verdict];
    const main = res.hits.filter((h) => !RULES[h.id].always);
    const always = res.hits.filter((h) => RULES[h.id].always);
    const nRed = main.filter((h) => h.level === 'red').length;
    const air = res.air.filter((z) => z.sfc || z.c === 'D');
    const airTxt = air.length
      ? air.map((z) => (z.c === 'C' ? `Class C surface area, SFC–${z.hi}` : `Class D (${z.id}), SFC–${z.hi}${z.hrs ? `; ${z.hrs}` : ''}`)).join('; ')
      : (res.air.length ? `Under the Class C shelf (floor ${res.air[0].lo})` : 'Class G (uncontrolled) near the ground');
    const jur = res.place
      ? `${placeKind(res.place)} of ${res.place.n}${res.county && !res.county.ic ? `, ${res.county.n} County` : ''}`
      : res.county ? (res.county.ic ? `City of ${res.county.n}` : `Unincorporated ${res.county.n} County`) : 'Unincorporated';
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
        <dt>Jurisdiction</dt><dd>${esc(jur)}</dd>
        ${zoneTxt ? `<dt>Zoning</dt><dd>${zoneTxt}</dd>` : ''}
        <dt>Airspace</dt><dd>${esc(airTxt)}</dd>
        ${np ? `<dt>Nearest airport</dt><dd>${np}</dd>` : ''}
      </dl>
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
    for (const z of res.lands) G.hl.addLayer(L.polygon(z.polys, { interactive: false, renderer: rHl, color: col(z.def.s), weight: 3, opacity: 1, fill: false }));
    for (const z of res.water) G.hl.addLayer(L.polygon(z.polys, { interactive: false, renderer: rHl, color: C.waterEdge, weight: 2.5, opacity: 1, fill: false }));
    if (res.lands.length || res.water.length) return;
    if (res.lot) {
      const rings = res.lot.rings.map((a) => { const o = []; for (let i = 0; i < a.length; i += 2) o.push(fromWorld(a[i], a[i + 1])); return o; });
      G.hl.addLayer(L.polygon(rings, { interactive: false, renderer: rHl, color: res.lot.t.cls === 'res' ? C.red : res.lot.t.cls === 'unz' ? C.ink : C.amber, weight: 2.5, opacity: 1, fill: false }));
    } else if (res.place) G.hl.addLayer(L.polygon(res.place.polys, { interactive: false, renderer: rHl, color: C.city, weight: 2.4, opacity: 0.9, fill: false, dashArray: '6 4' }));
  }

  const pinIcon = L.divIcon({ className: 'pin', iconSize: [30, 30], iconAnchor: [15, 15], html: '<svg viewBox="0 0 30 30"><circle class="ring" cx="15" cy="15" r="11" fill="none" style="stroke:var(--accent)" stroke-width="2"/><circle cx="15" cy="15" r="6.5" style="fill:var(--accent)" /><circle cx="15" cy="15" r="2.4" style="fill:var(--panel)"/><path d="M15 0v6M15 24v6M0 15h6M24 15h6" style="stroke:var(--accent)" stroke-width="2"/></svg>' });
  const pin = L.marker([0, 0], { icon: pinIcon, interactive: false, keyboard: false, pane: 'p-pin' });
  function setSpot(la, lo, opts) {
    current = check(la, lo);
    pin.setLatLng([la, lo]);
    if (!G.pin.hasLayer(pin)) G.pin.addLayer(pin);
    drawHighlight();
    if (!(opts && opts.example)) {
      try { history.replaceState(null, '', `#${REGION.key}/${la.toFixed(5)},${lo.toFixed(5)}`); } catch { /* a sandboxed frame can refuse */ }
    }
    render(current, opts);
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
    if (best) txt = `${esc(best.n)} <span class="z">· ${best.def.s === 'red' ? 'off-limits' : 'ask first'}</span>`;
    else {
      const w = water.find((z) => inZone(z, la, lo));
      const p = places.find((z) => inZone(z, la, lo));
      const lot = zoned(p) && !w ? lotAt(la, lo) : null;
      const cityNote = p && CITY[p.reg] && CITY[p.reg].tint ? ` <span class="z">· ${CITY[p.reg].tint === 'red' ? 'landings banned' : 'permit needed'}</span>` : '';
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
    const local = index.filter((e) => e.l.includes(q))
      .map((e) => ({ e, s: (e.l.startsWith(q) ? 0 : e.l.includes(' ' + q) ? 1 : 2) + e.l.length / 200 }))
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
      const found = await geocode(q);
      rows = found.map((g) => {
        const home = Object.values(REGIONS).find((r) => inBounds(r.bounds, g.la, g.lo));
        return { geo: 'hit', ...g, region: home ? home.key : null, k: home ? (home.key === REGION.key ? 'Address' : `Address · ${home.label} map`) : 'Outside the mapped areas' };
      });
      sel = rows.findIndex((r) => r.region);
      if (!rows.length) showRows('<div class="hint" style="padding:10px 12px">No address found. Add the city, like “… Austin TX”.</div>');
      else showRows(rowsHtml());
    } catch {
      showRows('<div class="hint" style="padding:10px 12px">Address search isn’t reachable right now. Try again in a moment.</div>');
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
    <p class="foot">Map data: ${esc(REGION.dataNote)}${D.zoning ? `; zoning as of ${esc(asOf(D.zoning.date))}` : ''}. Address search uses OpenStreetMap data through Nominatim and Photon. Event TFRs are drawn where the standing stadium TFR would apply; live TFRs are at tfr.faa.gov.</p>`;

  // ---------- examples and first view ----------
  const findLand = (n) => lands.filter((z) => z.n === n).sort((a, b) => b.area - a.area)[0];
  const EXAMPLES = [];
  for (const [n, where, z, lv] of REGION.examples || []) {
    const pt = Array.isArray(where) ? where : (() => { const l = findLand(where.land); return l ? insidePoint(l) : null; })();
    if (pt) EXAMPLES.push({ n, la: pt[0], lo: pt[1], z, lv });
  }

  window.__heliTest = { check, lotAt, nearLot, zLots, toWorld, fromWorld, map, geocode }; // TEST-ONLY
  const small = matchMedia('(max-width: 860px)').matches;
  zoomClass();
  if (startAt && inBounds(REGION.bounds, startAt[0], startAt[1])) {
    map.setView(startAt, 15);
    zoomClass();
    setSpot(startAt[0], startAt[1]);
  } else {
    map.setView(REGION.view, small ? REGION.zoomSmall : REGION.zoom);
    zoomClass();
    const first = EXAMPLES[0];
    if (first) setSpot(first.la, first.lo, { example: true });
  }
}
