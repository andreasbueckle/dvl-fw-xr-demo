// Extracts the columns the app plots from the raw Spotify CSV into a compact, columnar JSON file
// that the browser can load quickly (the raw CSV is ~20 MB; headsets shouldn't have to parse it).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { csvParse } from 'd3-dsv';

const SRC = 'data/SpotifyAudioFeaturesApril2019.csv';
const OUT = 'public/data/spotify.json';
const round3 = (v) => Math.round(v * 1000) / 1000;

const rows = csvParse(readFileSync(SRC, 'utf8'));
const out = { danceability: [], energy: [], popularity: [], duration_ms: [] };
for (const r of rows) {
  const d = +r.danceability, e = +r.energy, p = +r.popularity, t = +r.duration_ms;
  if ([r.danceability, r.energy, r.popularity, r.duration_ms].includes('') || [d, e, p, t].some(Number.isNaN)) continue;
  out.danceability.push(round3(d));
  out.energy.push(round3(e));
  out.popularity.push(p);
  out.duration_ms.push(t);
}

mkdirSync('public/data', { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`Wrote ${out.popularity.length} of ${rows.length} rows to ${OUT}`);
