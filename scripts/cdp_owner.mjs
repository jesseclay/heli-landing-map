// Opens the page at each spot in headless Chrome, waits for the owner lookup and the property lines, and reports what
// the landowner card shows. Owner names and addresses are masked in the output, so test logs carry no personal data.
// Serve build/ over http first (the parcel services answer pages, not files):
//   python3 -m http.server 8765 --bind 127.0.0.1 --directory build
// Usage: node cdp_owner.mjs <pageUrl> <outDir> <region> lat,lon [lat,lon ...] [--shots] [--zoom 17] [--light]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [page, out, region, ...rest] = process.argv.slice(2);
const shots = rest.includes('--shots');
const zi = rest.indexOf('--zoom'), zoom = zi >= 0 ? +rest[zi + 1] : 0;
const scheme = rest.includes('--light') ? 'light' : 'dark';
const spots = rest.filter((a) => /^-?\d.*,/.test(a)).map((s) => s.split(',').map(Number));
const outDir = path.resolve(out);
const port = 9347;
const prof = path.join(outDir, 'chrome-profile-owner');
fs.mkdirSync(prof, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1;
const pend = new Map(), events = [];
const send = (method, params = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.error || !r.result) return { error: r.error ? r.error.message : 'no result' }; // the page was mid-navigation
  return r.result.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : r.result.result.value;
};
// keep the shape of a value (its first letter and length) without its content
const MASK = `const mask = (s) => String(s).replace(/[A-Za-z0-9]+/g, (w) => w[0] + '·'.repeat(Math.min(w.length - 1, 3)));`;
try {
  let t;
  for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); } catch {} }
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } else if (d.method) events.push(d); };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  for (const [la, lo] of spots) {
    // a fresh load for each spot (a hash change alone would keep the page and its last lookup)
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(300);
    await send('Page.navigate', { url: `${page}#${region}/${la.toFixed(5)},${lo.toFixed(5)}` });
    let r;
    if (zoom) {
      for (let i = 0; i < 30 && (await evaluate('!!(window.__heliMap && document.getElementById("owner"))')) !== true; i++) await sleep(300);
      await evaluate(`window.__heliMap.setView([${la}, ${lo}], ${zoom}, { animate: false })`);
    }
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      r = await evaluate(`(() => { ${MASK}
        const el = document.getElementById('owner'); if (!el) return { state: 'no owner section' };
        const card = el.querySelector('.owner-card'); const txt = card ? card.innerText : '';
        if (/Looking up/.test(txt)) return { state: 'loading' };
        const dts = [...el.querySelectorAll('dt')].map((d) => d.textContent);
        const dds = [...el.querySelectorAll('dd')].map((d) => d.innerText.replace(/\\n/g, ' / '));
        const imgs = [...document.querySelectorAll('.leaflet-p-parcel-pane img')].filter((i) => i.complete && i.naturalWidth > 0).length;
        return { at: document.querySelector('.coords span')?.textContent, verdict: document.querySelector('.v-title')?.textContent, roll: el.querySelector('.group-title .hint')?.textContent || '',
          rows: dts.map((d, i) => d + ': ' + (/Owner|Mail/.test(d) ? mask(dds[i]) : dds[i])),
          how: el.querySelector('.owner-how')?.textContent || el.querySelector('.owner-card p')?.textContent || '',
          links: [...el.querySelectorAll('a.cite, button.cite')].map((a) => a.textContent + (a.href ? ' -> ' + a.href : '')),
          zoom: window.__heliMap.getZoom(), lineImgs: imgs, hl: document.querySelectorAll('.leaflet-p-hl-pane path, .leaflet-p-hl-pane canvas').length };
      })()`);
      if (r && r.state !== 'loading' && (r.lineImgs > 0 || i > 16)) break;
    }
    console.log(JSON.stringify({ spot: [la, lo], ...r }, null, 1));
    if (shots) {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const f = path.join(outDir, `owner-${region}-${la.toFixed(4)}_${lo.toFixed(4)}.png`);
      fs.writeFileSync(f, Buffer.from(s.result.data, 'base64'));
      console.log('screenshot', f);
    }
  }
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && /error/.test(e.params.entry.level)));
  for (const e of errs) console.log('ERR', e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.exception?.description : `${e.params.entry.text} ${e.params.entry.url || ''}`);
  console.log('errors:', errs.length);
} finally { try { ws.close(); } catch {} chrome.kill('SIGTERM'); await sleep(200); }
