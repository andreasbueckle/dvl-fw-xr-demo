/** Deterministic pseudo-random generator so the demo looks the same on every load. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Columnar Spotify audio features, produced from data/ by scripts/prepare-spotify.mjs. */
export interface SpotifyColumns {
  danceability: number[];
  energy: number[];
  popularity: number[];
  duration_ms: number[];
}

export async function loadSpotify(): Promise<SpotifyColumns> {
  const res = await fetch('data/spotify.json');
  if (!res.ok) throw new Error(`Failed to load Spotify data (${res.status}). Run "npm run data".`);
  return res.json();
}

export interface Bar {
  quarter: string;
  region: string;
  value: number;
}

export const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
export const REGIONS = ['North', 'East', 'South', 'West'];

/** Synthetic sales-by-quarter-and-region values for the bar chart. */
export function generateBars(): Bar[] {
  const rand = mulberry32(7);
  return REGIONS.flatMap((region, r) =>
    QUARTERS.map((quarter, q) => ({ quarter, region, value: Math.round(20 + 10 * q + 8 * r + 25 * rand()) })),
  );
}

/** Samples z = f(x, y) on a regular grid; each inner array is one row of the surface. */
export function generateSurface(steps = 40): { x: number; y: number; z: number }[][] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const y = -3 + (6 * i) / steps;
    return Array.from({ length: steps + 1 }, (_, j) => {
      const x = -3 + (6 * j) / steps;
      return { x, y, z: Math.sin(x) * Math.cos(y) * Math.exp(-(x * x + y * y) / 12) * 4 };
    });
  });
}
