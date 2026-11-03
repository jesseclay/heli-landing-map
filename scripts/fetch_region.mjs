// Downloads the public data one region's map is built from into raw/<region>/, a page at a time, one GeoJSON file
// per layer. Everything comes from public ArcGIS REST services: FAA ADDS (airspace, airports), US Census TIGERweb
// (state, city limits, counties, roads, water, campuses, prisons), USGS PAD-US 4.1 (protected and public land), the
// Forest Service (wilderness), EIA (power plants) and USACE NID (dams). Austin's zoning comes from the City of
// Austin.
// Usage: node scripts/fetch_region.mjs <region> [layer ...]   (texas, blacksburg; layers default to all)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REGIONS = {
  texas: { bounds: [-106.65, 25.83, -93.5, 36.51], fips: '48', st: 'TX', stName: 'Texas', zoning: true },
  blacksburg: { bounds: [-81.05, 36.8, -79.7, 37.55], fips: null, st: null, minWater: 150000 },
};
const [regionKey, ...only] = process.argv.slice(2);
const R = REGIONS[regionKey];
if (!R) throw new Error(`usage: fetch_region.mjs <${Object.keys(REGIONS).join('|')}> [layer ...]`);
const OUT = path.join(ROOT, 'raw', regionKey);

const FAA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';
const T = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
const AG = 'https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services';
const LAYERS = [
  // [file, layer url, where, outFields, maxAllowableOffset (degrees), page size, id field to page by]
  ['faa/class_airspace2', `${FAA}/Class_Airspace/FeatureServer/0`, "LOCAL_TYPE IN ('CLASS_B','CLASS_C','CLASS_D')", 'NAME,IDENT,LOCAL_TYPE,CLASS,LOWER_VAL,LOWER_CODE,UPPER_VAL,UPPER_CODE,WKHR_CODE,WKHR_RMK', 0.0003, 2000],
  ['faa/sua', `${FAA}/Special_Use_Airspace/FeatureServer/0`, '1=1', '*', 0.0003, 2000],
  ['faa/airports', `${FAA}/US_Airport/FeatureServer/0`, R.st ? `STATE='${R.st}'` : '1=1', '*', 0, 1000],
  ['tiger/state', `${T}/State_County/MapServer/0`, R.fips ? `STATE='${R.fips}'` : '1=0', 'NAME,STATE', 0.002, 100],
  ['tiger/places', `${T}/Places_CouSub_ConCity_SubMCD/MapServer/4`, R.fips ? `STATE='${R.fips}'` : '1=1', 'NAME,BASENAME,GEOID,LSADC,CENTLAT,CENTLON,INTPTLAT,INTPTLON', 0.0004, 2000],
  ['tiger/counties', `${T}/State_County/MapServer/1`, '1=1', 'NAME,BASENAME,GEOID,STATE,LSADC', 0.001, 2000],
  ['tiger/primary', `${T}/Transportation/MapServer/2`, '1=1', 'NAME,MTFCC,RTTYP', 0.0003, 5000],
  ['tiger/secondary', `${T}/Transportation/MapServer/6`, '1=1', 'NAME,MTFCC,RTTYP', 0.0004, 5000],
  ['tiger/areahydro', `${T}/Hydro/MapServer/1`, `AREAWATER>${R.minWater || 400000}`, 'NAME,MTFCC,AREAWATER', 0.0002, 5000],
  ['tiger/prisons', `${T}/Special_Land_Use_Areas/MapServer/1`, '1=1', 'NAME,MTFCC,AREALAND', 0.0001, 5000],
  ['tiger/colleges', `${T}/Special_Land_Use_Areas/MapServer/2`, '1=1', 'NAME,MTFCC,AREALAND', 0.0001, 5000],
  ['padus/fee_0', 'https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/Fee_Managers_PADUS/FeatureServer/0', R.st ? `State_Nm='${R.st}'` : '1=1',
    'Category,Own_Type,Own_Name,Loc_Own,Mang_Type,Mang_Name,Loc_Mang,Des_Tp,Loc_Ds,Unit_Nm,Pub_Access,GIS_Acres', 0.0002, 2000],
  ['usfs/wilderness', 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_Wilderness_01/MapServer/0', '1=1', 'wildernessname,gis_acres', 0.0002, 2000],
  ['eia/plants', `${AG}/Power_Plants_in_the_US/FeatureServer/0`, R.stName ? `State='${R.stName}'` : '1=1', 'Plant_Name,Utility_Na,PrimSource,Total_MW,City,County', 0, 2000, 'FID'],
  ['nid/dams_high', `${AG}/NID_v1/FeatureServer/0`, `HAZARD_POTENTIAL='High'${R.stName ? ` AND STATE='${R.stName}'` : ''}`, 'NAME,OTHER_NAMES,PRIMARY_OWNER_TYPE,HAZARD_POTENTIAL,NID_HEIGHT,RIVER_OR_STREAM,COUNTYSTATE,STATE_REGULATORY_AGENCY,OWNER_TYPES', 0, 2000],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(240000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200));
      return j;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(3000 * i);
    }
  }
}
async function fetchLayer([file, url, where, fields, offset, page, idField = 'OBJECTID']) {
  const [w, s, e, n] = R.bounds;
  const feats = [];
  for (let off = 0; ; off += page) {
    const q = new URLSearchParams({
      where, outFields: fields, f: 'geojson', outSR: '4326', returnGeometry: 'true', geometryPrecision: '5',
      geometry: `${w},${s},${e},${n}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      resultOffset: String(off), resultRecordCount: String(page), orderByFields: idField,
    });
    if (offset) q.set('maxAllowableOffset', String(offset));
    const j = await getJSON(`${url}/query?${q}`);
    const got = (j.features || []).length;
    feats.push(...(j.features || []));
    if (got < page && !j.exceededTransferLimit) break;
    if (!got) break;
  }
  const out = path.join(OUT, `${file}.geojson`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features: feats }));
  console.log(`${file.padEnd(24)} ${String(feats.length).padStart(7)} features ${(fs.statSync(out).size / 1e6).toFixed(1).padStart(7)} MB`);
}

// City of Austin zoning, every lot, generalized to about 2 m by the server
async function fetchZoning() {
  const Z = 'https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0/query';
  fs.mkdirSync(path.join(OUT, 'coa'), { recursive: true });
  for (let off = 0; ; off += 2000) {
    const j = await getJSON(`${Z}?where=1%3D1&outFields=OBJECTID,ZONING_ZTYPE,ZONING_BASE&orderByFields=OBJECTID&resultOffset=${off}&resultRecordCount=2000&outSR=4326&maxAllowableOffset=0.00002&geometryPrecision=6&f=geojson`);
    fs.writeFileSync(path.join(OUT, 'coa', `zoning_${off}.geojson`), JSON.stringify(j));
    if ((j.features || []).length < 2000) break;
  }
  console.log('coa/zoning                 done');
}

for (const L of LAYERS) if (!only.length || only.includes(L[0].split('/')[1]) || only.includes(L[0])) await fetchLayer(L);
if (R.zoning && (!only.length || only.includes('zoning'))) await fetchZoning();
