// Puts the page together from src/: docs/index.html is the full page GitHub Pages serves, build/artifact.html the same
// page as a fragment for a claude.ai artifact (which adds its own document skeleton), and build/test.html the full
// page with its test hooks left in. Region data files are built into docs/data/ by build_data.mjs.
// Usage: node scripts/assemble.mjs
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const r = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
// the researched Texas cities' rules (src/cities_tx.json, keyed by Census GEOID) go in ahead of the rules that read them
const cities = fs.existsSync(path.join(dir, 'src/cities_tx.json'))
  ? Object.fromEntries(JSON.parse(r('src/cities_tx.json')).filter((c) => c.level && c.level !== 'unknown')
    .map((c) => [c.fips, { level: c.level, title: c.title, text: c.text, penalty: c.penalty || '', who: c.who || '', cites: c.cites || [],
      // a green card rests on the zoning code alone, since the code libraries wouldn't let the rest be searched
      note: c.level === 'green' ? 'Based on the city’s zoning code. The rest of the city code wasn’t searched, and a separate landing rule could be there.' : '' }]))
  : {};
const rules = [`window.HELI_CITY_RULES = ${JSON.stringify(cities)};`, ...['src/rules.js', 'src/rules_va.js'].filter((f) => fs.existsSync(path.join(dir, f))).map(r)].join('\n');
const app = r('src/app.js');
const parts = (hooks) => ({
  '/*__LEAFLET_CSS__*/': r('raw/leaflet.css').replace(/url\([^)]*\)/g, 'none'),
  '/*__REGIONS__*/': r('src/regions.js'),
  '/*__RULES__*/': rules,
  '/*__APP__*/': hooks ? app : app.split('\n').filter((l) => !l.includes('TEST-ONLY')).join('\n'),
});
function fill(hooks) {
  let html = r('src/app.html');
  for (const [k, v] of Object.entries(parts(hooks))) {
    if (!html.includes(k)) throw new Error(`missing placeholder ${k}`);
    if (v.includes('</script')) throw new Error(`${k} contains a closing script tag`);
    html = html.split(k).join(v);
  }
  const [head, body] = html.split('<!--__BODY__-->');
  if (body === undefined) throw new Error('missing <!--__BODY__--> marker');
  return { head, body };
}
const DESC = 'Where a private helicopter can and can’t land anywhere in Texas and around Blacksburg, Virginia: every city’s landing rule at a glance, the rules at any spot, who enforces them, and what a prohibited landing can cost.';
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%231d4f9c'/%3E%3Cpath d='M11 9v14M21 9v14M11 16h10' stroke='white' stroke-width='3.2' stroke-linecap='round'/%3E%3C/svg%3E";
const page = (hooks) => {
  const { head, body } = fill(hooks);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="${DESC}">
<meta property="og:title" content="Helicopter Landing Map">
<meta property="og:description" content="${DESC}">
<meta property="og:type" content="website">
<meta name="theme-color" content="#f1f3ee" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0d1318" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${ICON}">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;
};
fs.mkdirSync(path.join(dir, 'docs/data'), { recursive: true });
fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
fs.writeFileSync(path.join(dir, 'docs/index.html'), page(false));
fs.writeFileSync(path.join(dir, 'docs/.nojekyll'), '');
fs.writeFileSync(path.join(dir, 'build/test.html'), page(true));
{ const { head, body } = fill(false); fs.writeFileSync(path.join(dir, 'build/artifact.html'), `${head.trim()}\n${body.trim()}\n`); }
// the test page loads its data from build/data, next to it
fs.cpSync(path.join(dir, 'docs/data'), path.join(dir, 'build/data'), { recursive: true });
const kb = (p) => `${(fs.statSync(path.join(dir, p)).size / 1024).toFixed(0)} KB`;
console.log('docs/index.html', kb('docs/index.html'), '| data:', fs.readdirSync(path.join(dir, 'docs/data')).map((f) => `${f} ${kb(`docs/data/${f}`)}`).join(', '));
