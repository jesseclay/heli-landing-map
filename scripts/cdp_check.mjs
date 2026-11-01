// Loads the built page in a throwaway headless Chrome profile, reports console errors,
// runs a few interaction checks and saves screenshots.
// Usage: node cdp_check.mjs <htmlFile> <outDir> [--shots] [--region <key>]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);
const shots = process.argv.includes('--shots');
const ri = process.argv.indexOf('--region');
const region = ri > 0 ? process.argv[ri + 1] : '';
const url = 'file://' + file + (region ? `#${region}` : '');
const tag = region ? `${region}-` : '';
const port = 9339;
const prof = path.join(outDir, 'chrome-profile');
fs.mkdirSync(prof, { recursive: true });
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,900', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, nextId = 1;
const pending = new Map();
const events = [];
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
  console.log('screenshot', path.join(outDir, name));
}

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); target = list.find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    else if (msg.method) events.push(msg);
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url });
  await sleep(4500);

  const report = await evaluate(`(() => {
    const q = (s) => document.querySelector(s);
    return { title: document.title, verdict: q('.v-title')?.textContent, spot: q('.spot-name')?.textContent,
      rules: document.querySelectorAll('#pane-spot .rule').length, leaflet: typeof L, canvases: document.querySelectorAll('#map canvas').length,
      markers: document.querySelectorAll('.leaflet-marker-icon').length, chips: [...document.querySelectorAll('.chip')].map(c => c.textContent) };
  })()`);
  console.log('initial', JSON.stringify(report));
  // click each example chip and read the verdict
  const chips = await evaluate(`document.querySelectorAll('.chip').length`);
  for (let i = 0; i < chips; i++) {
    const r = await evaluate(`(async () => { const c = document.querySelectorAll('.chip')[${i}]; const n = c.textContent; c.click(); await new Promise(r => setTimeout(r, 900));
      return { n, spot: document.querySelector('.spot-name')?.textContent, verdict: document.querySelector('.v-title')?.textContent,
        rules: [...document.querySelectorAll('#pane-spot .rules')[0].querySelectorAll('.rule h3')].map(h => h.textContent) }; })()`);
    console.log('example', JSON.stringify(r));
  }
  if (shots) {
    await evaluate(`document.querySelectorAll('.chip')[0].click()`);
    await sleep(1500);
    await shot(`${tag}desktop-light.png`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(800);
    await shot(`${tag}desktop-dark.png`);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Page.reload');
    await sleep(4500);
    await shot(`${tag}phone-light.png`);
    const ov = await evaluate(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
    console.log('phone overflow check', JSON.stringify(ov));
  }
  const errs = events.filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Runtime.consoleAPICalled' && /error|warn/.test(e.params.type)) || (e.method === 'Log.entryAdded' && /error|warning/.test(e.params.entry.level)) || e.method === 'Network.loadingFailed');
  for (const e of errs) {
    if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    else if (e.method === 'Runtime.consoleAPICalled') console.log('CONSOLE', e.params.type, e.params.args.map((a) => a.value ?? a.description).join(' '));
    else if (e.method === 'Network.loadingFailed') console.log('NETFAIL', e.params.errorText, e.params.blockedReason || '');
    else console.log('LOG', e.params.entry.level, e.params.entry.text, e.params.entry.url || '');
  }
  console.log('errors:', errs.length);
} catch (e) {
  console.error('harness failed:', e.message);
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill('SIGTERM');
  await sleep(300);
}
