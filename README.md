# dvl-fw-xr-demo

Minimal Angular + [Babylon.js](https://www.babylonjs.com/) app that renders a 3D scatter plot with
[Anu.js](https://github.com/jpmorganchase/anu) and lets you view it in WebXR (VR headsets).

## Data

The Spotify chart plots danceability (x), energy (y) and popularity (z), coloured by duration (Viridis, 0–10 min; longer tracks clamp to the top colour), for all
~130k tracks in `data/SpotifyAudioFeaturesApril2019.csv`. `npm run data` extracts just those
columns into `public/data/spotify.json` (~1.9 MB, ~0.6 MB gzipped); it runs automatically before
`start`, `start:xr` and `build`, and the output is git-ignored.

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

## Layout

- `src/app/charts-xr.ts` — Babylon scene with Spotify scatter (thin instances), bar and surface charts (Anu), chart switcher (HTML + in-VR panel), WebXR setup
- `src/app/data.ts` — Spotify loader plus synthetic data for the bar and surface charts
- `scripts/prepare-spotify.mjs` — CSV → compact JSON preprocessing
- `src/app/app.ts` — lazy-loads the scene with `@defer` so the initial bundle stays ~125 kB
