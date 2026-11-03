// Merges the city-code research (one JSON array per batch, as BRIEF.md in the research folder describes) into
// src/cities_tx.json, which the build reads to give each researched city its own rule card and map color.
// Later batches replace earlier entries for the same city, so a second pass on the unknowns can be merged on top.
// Usage: node scripts/merge_cities.mjs <batch.json> [batch.json ...]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'src', 'cities_tx.json');
const LEVELS = new Set(['red', 'amber', 'green', 'unknown']);
const byFips = new Map(fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).map((c) => [c.fips, c]) : []);

// corrections after reading the researchers' notes: a code that makes every unlisted use conditional, or bars every
// unlisted use, does reach heliports even where it never names them
const OVERRIDES = {
  Kerrville: { level: 'amber', title: 'Kerrville: a helipad needs a conditional use permit',
    text: 'The zoning code doesn’t name heliports, but any use it doesn’t list needs a conditional use permit in every district, so a landing site would need one.' },
  // the town pass missed Sunnyvale's helicopter article (§8.09), read in its eCode360 code on 2026-11-03
  Sunnyvale: { level: 'amber', title: 'Sunnyvale: approved heliports or the town manager’s permission',
    text: 'Helicopters may land or take off only at a heliport the town council has approved, or elsewhere with the town manager’s written permission and the landowner’s written consent. Away from such a site, flying below 1,000 ft above the ground is barred.',
    penalty: 'Misdemeanor fine under §1.01.009; each day is a separate offense', who: 'Town manager; Sunnyvale Police',
    cites: [{ t: 'Sunnyvale Code §8.09.002', u: 'https://ecode360.com/39446610' }], confidence: 'high', note: '' },
  // the town pass read McLendon-Chisholm's use table as silent; it lists heliports (zoning §3-1, read 2026-11-03)
  'McLendon-Chisholm': { level: 'amber', title: 'McLendon-Chisholm: heliports by specific use permit in most districts',
    text: 'The zoning use table lists heliports: a specific use permit is needed in three districts, and they are allowed by right in one. A helistop is a pad for occasional, infrequent use.',
    cites: [{ t: 'McLendon-Chisholm Zoning §3-1 (use table)', u: 'https://ecode360.com/40127646' }], confidence: 'medium', note: '' },
  Henderson: { level: 'amber', title: 'Henderson’s zoning allows heliports in no district',
    text: 'The code defines heliports but lists them in no zoning district, and it bars uses it doesn’t list, so a landing site can’t be set up without a zoning change. A one-off landing isn’t addressed.' },
};
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s || ''));
let read = 0;
for (const f of process.argv.slice(2)) {
  for (const c of JSON.parse(fs.readFileSync(f, 'utf8'))) {
    read++;
    if (!c.fips || !LEVELS.has(c.level)) { console.warn('skipped', c.city, c.level); continue; }
    const o = { ...c, ...(OVERRIDES[c.city] || {}) };
    byFips.set(c.fips, {
      city: o.city, fips: o.fips, level: o.level, title: clip(o.title, 70), text: clip(o.text, 450), penalty: clip(o.penalty, 140), who: clip(o.who, 120),
      cites: (o.cites || []).filter((x) => x && x.t).slice(0, 4).map((x) => ({ t: clip(x.t, 80), u: /^https?:\/\//.test(x.u || '') ? x.u : '' })),
      zoning: o.zoning ?? null, confidence: o.confidence || '', note: clip(o.note, 220),
    });
  }
}
const all = [...byFips.values()].sort((a, b) => a.city.localeCompare(b.city));
fs.writeFileSync(OUT, `${JSON.stringify(all, null, 1)}\n`);
const n = {};
for (const c of all) n[c.level] = (n[c.level] || 0) + 1;
console.log(`read ${read}, ${all.length} cities in ${path.relative(ROOT, OUT)}:`, n);
