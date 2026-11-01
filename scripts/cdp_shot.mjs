// Loads the page in headless Chrome, runs a snippet, then saves a screenshot.
// Usage: node cdp_shot.mjs <htmlFile or http URL> <out.png> <width> <height> <light|dark> <snippet>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [file, out, w, h, scheme, snippet] = process.argv.slice(2);
const port = 9343;
const prof = path.join(path.dirname(path.resolve(out)), 'chrome-profile-shot');
fs.mkdirSync(prof, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 1; const pend = new Map();
const send = (method, params = {}) => { const i = id++; ws.send(JSON.stringify({ id: i, method, params })); return new Promise((r) => pend.set(i, r)); };
try {
  let t; for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === 'page'); } catch {} }
  ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: 1, mobile: +w < 600 });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await send('Page.navigate', { url: /^https?:/.test(file) ? file : 'file://' + path.resolve(file) });
  await sleep(4000);
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${snippet} })()`, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) console.log('snippet error', r.result.exceptionDetails.exception?.description);
  await sleep(1200);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
  console.log('saved', out);
} finally { try { ws.close(); } catch {} chrome.kill('SIGTERM'); await sleep(200); }
