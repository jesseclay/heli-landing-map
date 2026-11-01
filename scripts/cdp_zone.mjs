// Zoning checks in headless Chrome: projection against Leaflet, tile timing, and verdicts at probe points.
// Usage: node cdp_zone.mjs <htmlFile> <outDir> [lat,lon ...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const file = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);
const pts = process.argv.slice(4).map((s) => s.split(',').map(Number));
const port = 9345;
const prof = path.join(outDir, 'chrome-profile-zone');
fs.mkdirSync(prof, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1; const pending = new Map(); const events = [];
const send = (method, params = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((res, rej) => pending.set(i, { res, rej })); };
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : r.result.value; };
try {
  let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); } catch {} }
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); } else if (msg.method) events.push(msg); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const t0 = Date.now();
  await send('Page.navigate', { url: 'file://' + file });
  await sleep(5000);
  console.log('loaded in about', Date.now() - t0, 'ms (fixed wait)');
  console.log('proj', JSON.stringify(await ev(`(() => { const T = window.__heliTest; const out = []; for (const [la, lo] of [[30.27, -97.74], [30.45, -97.9], [30.1, -97.6]]) { const p = T.map.project([la, lo], 0); const w = T.toWorld(la, lo); const b = T.fromWorld(w[0], w[1]); out.push([+(p.x - w[0]).toExponential(2), +(p.y - w[1]).toExponential(2), +(b[0] - la).toExponential(2), +(b[1] - lo).toExponential(2)]); } return { lots: T.zLots.length, out }; })()`)));
  console.log('tiles', JSON.stringify(await ev(`(async () => { const T = window.__heliTest; const out = {}; for (const z of [10, 12, 14, 16]) { T.map.setView([30.30, -97.74], z, { animate: false }); await new Promise((r) => setTimeout(r, 900)); const tiles = [...document.querySelectorAll('.leaflet-pane canvas.leaflet-tile')].length; out[z] = tiles; } const t = performance.now(); for (let i = 0; i < 200; i++) T.lotAt(30.30 + i * 0.0005, -97.74); return { tilesByZoom: out, lotAtMs: +((performance.now() - t) / 200).toFixed(3) }; })()`)));
  for (const [la, lo] of pts) {
    const r = await ev(`(() => { const r = window.__heliTest.check(${la}, ${lo}); return { verdict: r.verdict, lot: r.lot && r.lot.t.code, cls: r.lot && r.lot.t.cls, gap: r.lotGap && Math.round(r.lotGap.d), place: r.place && r.place.n, lands: r.lands.map((z) => z.n), road: r.road && Math.round(r.road.d), hits: r.hits.filter((h) => !h.r.always).map((h) => h.id + (h.where.length ? ' [' + h.where.join(' | ') + ']' : '')) }; })()`);
    console.log('pt', la, lo, JSON.stringify(r));
  }
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && /error|warn/.test(e.params.type)));
  for (const e of errs) console.log('ERR', e.params.exceptionDetails?.exception?.description || e.params.args?.map((a) => a.value ?? a.description).join(' '));
  console.log('errors:', errs.length);
} catch (e) { console.error('harness failed:', e.message); } finally { try { ws && ws.close(); } catch {} chrome.kill('SIGTERM'); await sleep(300); }
