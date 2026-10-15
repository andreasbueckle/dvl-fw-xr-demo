# dvl-fw-xr-demo

Minimal Angular + [Babylon.js](https://www.babylonjs.com/) app that renders three 3D charts with
[Anu.js](https://github.com/jpmorganchase/anu) and lets you view them in WebXR (VR headsets).

## Data

`npm run data` (`scripts/prepare-data.mjs`) turns the CSVs in `data/` into compact JSON in
`public/data/`. It runs automatically before `start`, `start:xr` and `build`, and the output is
git-ignored.

- **Penguins** (`data/palmer-penguins.csv`): a scatter plot of bill length (x), flipper length (y)
  and bill depth (z), coloured by species. With **Details** on, hovering shows species, island, sex
  and year.
- **NYC Taxi** (`data/nyc-trips.csv`, one day: 2015-01-15): each trip arcs from its pickup to its
  dropoff location, higher for longer trips, coloured by pickup time; long trips are drawn fainter
  so they don't hide the dense short ones. Trips within Manhattan, most of Brooklyn and Queens, and
  the airports are kept, and every 4th of those (~24k) is drawn. The floor shows outlines of
  Manhattan, Brooklyn, Queens and the Bronx (`data/nyc-boroughs.geojson`, NYC Open Data borough
  boundaries via [dwillis/nyc-maps](https://github.com/dwillis/nyc-maps), simplified to ~50 m) and
  pins for JFK and LaGuardia.
- **Spotify**: see below.

### Spotify

The Spotify chart plots danceability (x), energy (y) and popularity (z), coloured by duration (Viridis, 0–10 min; longer tracks clamp to the top colour), for all
~130k tracks in `data/SpotifyAudioFeaturesApril2019.csv`. `npm run data` extracts just those
columns into `public/data/spotify.json`, plus track and artist names into
`public/data/spotify-names.json` (~5 MB, ~1.9 MB gzipped), which is only fetched once hover
labels are turned on.

With the **Details** button turned on (it is off by default; there is one in the toolbar and one
on the in-VR panel), hovering over a point with the mouse, or pointing at one with a VR controller,
highlights it and shows the track and artist. A colour legend for duration sits beside the chart.

Checkboxes (and a row on the in-VR panel, while the Spotify chart is shown) pick which songs to
show: **All songs**, and/or the songs of Taylor Swift, Billie Eilish, Kacey Musgraves, Cardi B and
Johann Sebastian Bach. The
artists' songs are drawn 4× larger so they stand out, among all songs or on their own. Their track
indices are precomputed into `public/data/spotify-featured.json`.

## Run

```bash
npm install
npm start          # http://localhost:4200 — desktop view, orbit with mouse
npm run start:xr   # https://<your-LAN-IP>:4200 — for headsets on the same network
```

WebXR only works in a secure context (HTTPS or `localhost`). `start:xr` uses a self-signed
certificate, so accept the browser warning on the headset. Alternatively, plug a Quest in via USB,
run `adb reverse tcp:4200 tcp:4200`, and open `http://localhost:4200` in the headset browser.

When `immersive-vr` is supported, a goggles button appears in the bottom-right corner to enter VR.

## Navigation

- **Scale:** the **Scale** slider (toolbar, and on the in-VR panel) enlarges the charts up to 10×
  around their centre while the Spotify cubes keep their size, so dense regions spread out. Fly
  speed grows with it.

- **Desktop:** the **Orbit / Fly** toggle (top right) switches between orbiting the chart with the
  mouse and flying freely: W A S D or arrow keys to move, E / Q to go up / down, drag to look.
- **VR:** the left thumbstick flies in the direction you are looking (including up and down); the
  right thumbstick turns.

## Layout

- `src/app/charts-xr.ts` — Babylon scene with the penguin scatter, NYC taxi arcs (line system) and Spotify scatter (thin instances), chart switcher (HTML + in-VR panel), WebXR setup
- `src/app/point-grid.ts` — spatial grid for fast ray picking of the ~130k scatter points
- `src/app/data.ts` — data loaders
- `scripts/prepare-data.mjs` — CSV → compact JSON preprocessing
- `src/app/app.ts` — lazy-loads the scene with `@defer` so the initial bundle stays ~125 kB
