# dvl-fw-xr-demo

Minimal Angular + [Babylon.js](https://www.babylonjs.com/) app that renders a 3D scatter plot with
[Anu.js](https://github.com/jpmorganchase/anu) and lets you view it in WebXR (VR headsets).

## Data

The Spotify chart plots danceability (x), energy (y) and popularity (z), coloured by duration (Viridis, 0–10 min; longer tracks clamp to the top colour), for all
~130k tracks in `data/SpotifyAudioFeaturesApril2019.csv`. `npm run data` extracts just those
columns into `public/data/spotify.json`, plus track and artist names into
`public/data/spotify-names.json` (~5 MB, ~1.9 MB gzipped), which is loaded after first render for
hover labels. It runs automatically before `start`, `start:xr` and `build`, and the output is
git-ignored.

Hovering over a sphere with the mouse, or pointing at one with a VR controller, highlights it and
shows the track and artist. A colour legend for duration sits beside the chart.

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

- **Desktop:** the **Orbit / Fly** toggle (top right) switches between orbiting the chart with the
  mouse and flying freely: W A S D or arrow keys to move, E / Q to go up / down, drag to look.
- **VR:** the left thumbstick flies in the direction you are looking (including up and down); the
  right thumbstick turns.

## Layout

- `src/app/charts-xr.ts` — Babylon scene with Spotify scatter (thin instances), bar and surface charts (Anu), chart switcher (HTML + in-VR panel), WebXR setup
- `src/app/point-grid.ts` — spatial grid for fast ray picking of the ~130k scatter points
- `src/app/data.ts` — Spotify loader plus synthetic data for the bar and surface charts
- `scripts/prepare-spotify.mjs` — CSV → compact JSON preprocessing
- `src/app/app.ts` — lazy-loads the scene with `@defer` so the initial bundle stays ~125 kB
