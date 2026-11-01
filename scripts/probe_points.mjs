// Prints what a region's data says at given points (land kinds, water, place, county), and inside points for
// named water bodies. Usage: node scripts/probe_points.mjs <region> [lat,lon ...] [--water]
import fs from 'node:fs';
import vm from 'node:vm';
const [region, ...args] = process.argv.slice(2);
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL(`../docs/data/${region}.js`, import.meta.url), 'utf8'), ctx);
const D = ctx.window.HELI_DATA;
const dec = (a) => { const o = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; o.push([y / 1e5, x / 1e5]); } return o; };
const pip = (la, lo, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [yi, xi] = r[i], [yj, xj] = r[j]; if ((yi > la) !== (yj > la) && lo < ((xj - xi) * (la - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
const inZ = (z, la, lo) => z.g.some((p) => { const rs = p.map(dec); return pip(la, lo, rs[0]) && !rs.slice(1).some((h) => pip(la, lo, h)); });
for (const a of args.filter((s) => /,/.test(s))) {
  const [la, lo] = a.split(',').map(Number);
  const out = {
    place: D.places.filter((z) => inZ(z, la, lo)).map((z) => `${z.n}(${z.reg})`),
    county: D.counties.filter((z) => inZ(z, la, lo)).map((z) => z.n + (z.ic ? ' city' : '') + ' ' + z.st),
    lands: D.lands.filter((z) => inZ(z, la, lo)).map((z) => `${z.n} [${z.k}]`),
    water: D.water.filter((z) => inZ(z, la, lo)).map((z) => `${z.n} [${z.k}]`),
  };
  console.log(a, JSON.stringify(out));
}
if (args.includes('--water')) {
  const best = {};
  for (const w of D.water) { const r = dec(w.g[0][0]); const n = w.n; let s = 90, wv = 180, nn = -90, e = -180; for (const [la, lo] of r) { s = Math.min(s, la); nn = Math.max(nn, la); wv = Math.min(wv, lo); e = Math.max(e, lo); } const area = (nn - s) * (e - wv); if (!best[n] || best[n].area < area) best[n] = { w, area, bb: [s, wv, nn, e] }; }
  for (const [n, { w, bb }] of Object.entries(best)) {
    let pt = null;
    for (let k = 3; k <= 21 && !pt; k += 2) for (let i = 1; i < k && !pt; i++) for (let j = 1; j < k && !pt; j++) { const la = bb[0] + (bb[2] - bb[0]) * i / k, lo = bb[1] + (bb[3] - bb[1]) * j / k; if (inZ(w, la, lo)) pt = [la.toFixed(4), lo.toFixed(4)]; }
    console.log('water', n, w.k, pt && pt.join(','));
  }
}
