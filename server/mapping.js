import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, log } from './config.js';

// Community-maintained AniList/MAL/AniDB -> TVDB/TMDB/IMDb mapping.
// MAPPING_URL lets tests serve a small fixture instead.
const SOURCE = process.env.MAPPING_URL || 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const FILE = path.join(CACHE_DIR, 'anime-list-full.json');
const MAX_AGE_MS = 20 * 3600_000;

let index = null; // Map<anilistId, entry>
let indexMtime = 0;
let lastError = null;

const first = (v) => (Array.isArray(v) ? v[0] : v);
const toInt = (v) => {
  const n = Number(first(v));
  return Number.isInteger(n) && n > 0 ? n : null;
};

function normalise(e) {
  const tmdb = e.themoviedb_id;
  const isObj = tmdb && typeof tmdb === 'object' && !Array.isArray(tmdb);
  return {
    type: e.type,
    tvdbId: toInt(e.tvdb_id),
    tvdbSeason: e.season?.tvdb ?? null,
    tmdbMovieId: isObj ? toInt(tmdb.movie) : e.type === 'MOVIE' ? toInt(tmdb) : null,
    tmdbTvId: isObj ? toInt(tmdb.tv) : null,
    imdbId: first(e.imdb_id) || null,
  };
}

async function download() {
  log('Downloading anime ID mapping…');
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`mapping download failed: HTTP ${res.status}`);
  const text = await res.text();
  JSON.parse(text); // don't replace a good cache with a truncated file
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, FILE);
}

function load() {
  const stat = fs.statSync(FILE);
  if (index && stat.mtimeMs === indexMtime) return;
  const entries = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const next = new Map();
  for (const e of entries) {
    const id = toInt(e.anilist_id);
    if (id) next.set(id, normalise(e));
  }
  index = next;
  indexMtime = stat.mtimeMs;
  log(`Loaded ID mapping: ${index.size} AniList entries`);
}

/** Makes sure a reasonably fresh mapping is loaded; falls back to the cached copy if offline. */
export async function ensureMapping({ force = false } = {}) {
  const exists = fs.existsSync(FILE);
  const stale = !exists || force || Date.now() - fs.statSync(FILE).mtimeMs > MAX_AGE_MS;
  if (stale) {
    try {
      await download();
      lastError = null;
    } catch (e) {
      lastError = e.message;
      log(`Mapping update failed: ${e.message}`);
      if (!exists) throw e;
    }
  }
  load();
  return index;
}

export const lookupMapping = (anilistId) => index?.get(anilistId) || null;

export function mappingInfo() {
  return {
    entries: index?.size ?? 0,
    updatedAt: indexMtime ? new Date(indexMtime).toISOString() : null,
    lastError,
    source: SOURCE,
  };
}
