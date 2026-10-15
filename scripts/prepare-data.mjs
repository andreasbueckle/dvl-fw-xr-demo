// Extracts the columns the app plots from the raw CSVs in data/ into compact JSON files that the
// browser can load quickly (the raw CSVs are tens of MB; headsets shouldn't have to parse them).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { csvParse } from 'd3-dsv';

const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;
const read = (path) => csvParse(readFileSync(path, 'utf8'));
mkdirSync('public/data', { recursive: true });

// --- Spotify -----------------------------------------------------------------------------------
{
  const rows = read('data/SpotifyAudioFeaturesApril2019.csv');
  const out = { danceability: [], energy: [], popularity: [], duration_ms: [] };
  // Names are only needed for hover labels, so they go in a separate file the app loads on demand.
  const names = { track: [], artist: [] };
  // Track indices of the artists the app lets you pick out, so filtering doesn't need the names file.
  const FEATURED = ['Taylor Swift', 'Billie Eilish', 'Kacey Musgraves', 'Cardi B', 'Johann Sebastian Bach'];
  const featured = Object.fromEntries(FEATURED.map((a) => [a, []]));
  for (const r of rows) {
    const d = +r.danceability, e = +r.energy, p = +r.popularity, t = +r.duration_ms;
    if ([r.danceability, r.energy, r.popularity, r.duration_ms].includes('') || [d, e, p, t].some(Number.isNaN)) continue;
    out.danceability.push(round(d, 3));
    out.energy.push(round(e, 3));
    out.popularity.push(p);
    out.duration_ms.push(t);
    names.track.push(r.track_name);
    names.artist.push(r.artist_name);
    featured[r.artist_name]?.push(names.artist.length - 1);
  }
  writeFileSync('public/data/spotify.json', JSON.stringify(out));
  writeFileSync('public/data/spotify-names.json', JSON.stringify(names));
  writeFileSync('public/data/spotify-featured.json', JSON.stringify(featured));
  console.log(`Spotify: wrote ${out.popularity.length} of ${rows.length} tracks`);
}

// --- Palmer penguins -------------------------------------------------------------------------
{
  const rows = read('data/palmer-penguins.csv');
  const out = rows
    .filter((r) => [r.bill_length_mm, r.bill_depth_mm, r.flipper_length_mm].every((v) => v !== 'NA' && v !== ''))
    .map((r) => ({
      species: r.species,
      island: r.island,
      sex: r.sex === 'NA' ? 'unknown' : r.sex,
      year: +r.year,
      billLength: +r.bill_length_mm,
      billDepth: +r.bill_depth_mm,
      flipperLength: +r.flipper_length_mm,
    }));
  writeFileSync('public/data/penguins.json', JSON.stringify(out));
  console.log(`Penguins: wrote ${out.length} of ${rows.length} penguins (the rest lack measurements)`);
}

// --- NYC taxi trips (one day, 2015-01-15) -----------------------------------------------------
{
  // Covers Manhattan, most of Brooklyn and Queens, and both airports; the few trips outside it
  // (and GPS glitches at 0,0) would otherwise squash the city into a corner of the chart.
  const LON = [-74.03, -73.77];
  const LAT = [40.63, 40.85];
  // Every Nth trip: ~25k lines still show the patterns without turning into a solid block.
  const STEP = 4;
  const DAY = '2015-01-15';
  const hourOf = (ts) => +ts.slice(11, 13) + +ts.slice(14, 16) / 60 + +ts.slice(17, 19) / 3600;
  const inside = (lon, lat) => lon >= LON[0] && lon <= LON[1] && lat >= LAT[0] && lat <= LAT[1];

  const rows = read('data/nyc-trips.csv');
  const out = { pickupLon: [], pickupLat: [], pickupHour: [], dropoffLon: [], dropoffLat: [], dropoffHour: [], distance: [] };
  let kept = 0;
  for (const r of rows) {
    const [plon, plat, dlon, dlat] = [+r.pickup_longitude, +r.pickup_latitude, +r.dropoff_longitude, +r.dropoff_latitude];
    if (!inside(plon, plat) || !inside(dlon, dlat)) continue;
    // Trips ending after midnight would leave the 24-hour time axis.
    if (!r.tpep_pickup_datetime.startsWith(DAY) || !r.tpep_dropoff_datetime.startsWith(DAY)) continue;
    const [ph, dh] = [hourOf(r.tpep_pickup_datetime), hourOf(r.tpep_dropoff_datetime)];
    if (!(dh > ph) || dh - ph > 3 || !(+r.trip_distance > 0)) continue;
    if (kept++ % STEP) continue;
    out.pickupLon.push(round(plon, 4));
    out.pickupLat.push(round(plat, 4));
    out.pickupHour.push(round(ph, 3));
    out.dropoffLon.push(round(dlon, 4));
    out.dropoffLat.push(round(dlat, 4));
    out.dropoffHour.push(round(dh, 3));
    out.distance.push(round(+r.trip_distance, 2));
  }
  writeFileSync('public/data/nyc-trips.json', JSON.stringify(out));
  console.log(`NYC trips: wrote ${out.distance.length} (every ${STEP}th of ${kept} valid) of ${rows.length} trips`);
}

// --- NYC borough outlines (NYC Open Data borough boundaries, via github.com/dwillis/nyc-maps) ---
{
  const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx']; // Staten Island is outside the trips
  // ~0.0005° ≈ 50 m: keeps the shape of the coast without thousands of tiny wiggles.
  const TOLERANCE = 0.0005;
  // Skip islands smaller than ~0.5 km across; they are clutter at chart scale.
  const MIN_SIZE = 0.005;
  const geo = JSON.parse(readFileSync('data/nyc-boroughs.geojson', 'utf8'));
  const out = [];
  for (const f of geo.features) {
    const name = f.properties.BoroName;
    if (!BOROUGHS.includes(name)) continue;
    const rings = f.geometry.coordinates
      .map((polygon) => polygon[0]) // outer ring only
      .filter((ring) => {
        const lons = ring.map((p) => p[0]), lats = ring.map((p) => p[1]);
        return Math.max(Math.max(...lons) - Math.min(...lons), Math.max(...lats) - Math.min(...lats)) >= MIN_SIZE;
      })
      .map((ring) => simplify(ring, TOLERANCE).map(([lon, lat]) => [round(lon, 4), round(lat, 4)]));
    out.push({ name, rings });
  }
  writeFileSync('public/data/nyc-boroughs.json', JSON.stringify(out));
  console.log(`Boroughs: wrote ${out.map((b) => `${b.name} (${b.rings.reduce((n, r) => n + r.length, 0)} points)`).join(', ')}`);
}

/** Douglas–Peucker line simplification. */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay);
    let farthest = -1, maxDist = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      // Closed rings start and end on the same point; measure from that point instead of a line.
      const dist = len < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (dist > maxDist) [farthest, maxDist] = [i, dist];
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([a, farthest], [farthest, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}
