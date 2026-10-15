/** Generated from data/ by scripts/prepare-data.mjs; a missing file means "npm run data" hasn't run. */
async function loadJson<T>(file: string, label: string): Promise<T> {
  const res = await fetch(`data/${file}`);
  if (!res.ok) throw new Error(`Failed to load ${label} (${res.status}). Run "npm run data".`);
  return res.json();
}

/** Columnar Spotify audio features. */
export interface SpotifyColumns {
  danceability: number[];
  energy: number[];
  popularity: number[];
  duration_ms: number[];
}

export const loadSpotify = () => loadJson<SpotifyColumns>('spotify.json', 'Spotify data');

/** Track and artist names, index-aligned with SpotifyColumns. */
export interface SpotifyNames {
  track: string[];
  artist: string[];
}

export const loadSpotifyNames = () => loadJson<SpotifyNames>('spotify-names.json', 'Spotify names');

/** Track indices (into SpotifyColumns) for each featured artist. */
export type SpotifyFeatured = Record<string, number[]>;

export const loadSpotifyFeatured = () => loadJson<SpotifyFeatured>('spotify-featured.json', 'featured Spotify artists');

/** A Palmer penguin; measurements are in millimetres. */
export interface Penguin {
  species: string;
  island: string;
  /** 'male', 'female' or 'unknown'. */
  sex: string;
  year: number;
  billLength: number;
  billDepth: number;
  flipperLength: number;
}

export const loadPenguins = () => loadJson<Penguin[]>('penguins.json', 'penguin data');

/** One day of NYC taxi trips (2015-01-15); hours are fractional hours since midnight. */
export interface TaxiTrips {
  pickupLon: number[];
  pickupLat: number[];
  pickupHour: number[];
  dropoffLon: number[];
  dropoffLat: number[];
  dropoffHour: number[];
  /** Miles. */
  distance: number[];
}

export const loadTaxiTrips = () => loadJson<TaxiTrips>('nyc-trips.json', 'NYC taxi trips');

/** Simplified borough outlines: each ring is a closed list of [lon, lat]. */
export interface Borough {
  name: string;
  rings: [number, number][][];
}

export const loadBoroughs = () => loadJson<Borough[]>('nyc-boroughs.json', 'NYC borough outlines');
