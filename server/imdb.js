import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { CACHE_DIR, log } from './config.js';

// IMDb publishes every title's rating and vote count once a day (free for personal,
// non-commercial use). It's fresher than OMDb's copy and needs no API key or daily quota.
// IMDB_RATINGS_URL lets tests serve a fixture; set it to "off" to rely on OMDb alone.
const SOURCE = (process.env.IMDB_RATINGS_URL ?? 'https://datasets.imdbws.com/title.ratings.tsv.gz').trim();
export const IMDB_ENABLED = !/^(off|false|no|0)?$/i.test(SOURCE);
const MAX_AGE_MS = 20 * 3600_000;
const RETRY_MS = 3600_000; // after a failed download, wait before trying again
const HEADER = 'tconst\taverageRating\tnumVotes';

let db = null;
function open() {
  if (db) return db;
  db = new DatabaseSync(path.join(CACHE_DIR, 'imdb-ratings.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- id is the number in "tt0903747"; rating is ×10 (7.4 → 74).
    CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY, rating INTEGER NOT NULL, votes INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

const meta = (key) => open().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (key, value) => open().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));

let inflight = null;
let lastError = null;
let lastAttempt = 0;

const loaded = () => IMDB_ENABLED && Number(meta('titles')) > 0;
const fresh = () => Date.now() - new Date(meta('checked_at') || 0).getTime() < MAX_AGE_MS;

async function download() {
  const headers = {};
  const lm = loaded() && meta('last_modified');
  if (lm) headers['If-Modified-Since'] = lm;
  const res = await fetch(SOURCE, { headers, signal: AbortSignal.timeout(300_000) });
  if (res.status === 304) {
    setMeta('checked_at', new Date().toISOString());
    return;
  }
  if (!res.ok || !res.body) throw new Error(`IMDb ratings download failed: HTTP ${res.status}`);
  log('Downloading IMDb ratings…');

  const d = open();
  const insert = d.prepare('INSERT OR REPLACE INTO ratings (id, rating, votes) VALUES (?, ?, ?)');
  const lines = readline.createInterface({ input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let count = 0;
  let header = null;
  // One transaction: readers keep the previous day's ratings until the new set is complete.
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM ratings');
    for await (const line of lines) {
      if (header === null) {
        header = line;
        if (header !== HEADER) throw new Error('IMDb ratings file has an unexpected format');
        continue;
      }
      const [tconst, rating, votes] = line.split('\t');
      const id = Number(tconst.slice(2));
      const r = Number(rating);
      if (!tconst.startsWith('tt') || !Number.isInteger(id) || !Number.isFinite(r)) continue;
      insert.run(id, Math.round(r * 10), Number(votes) || 0);
      count++;
    }
    if (!count) throw new Error('IMDb ratings file was empty');
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
  setMeta('titles', count);
  setMeta('updated_at', new Date().toISOString());
  setMeta('checked_at', new Date().toISOString());
  if (res.headers.get('last-modified')) setMeta('last_modified', res.headers.get('last-modified'));
  log(`Loaded IMDb ratings: ${count} titles`);
}

/**
 * Keeps the ratings at most a day old. Resolves once ratings are usable: an older copy counts
 * unless `wait` is set, so callers only wait when there's nothing yet. Never throws; see imdbInfo().error.
 */
export function ensureImdb({ force = false, wait = false } = {}) {
  if (!IMDB_ENABLED) return Promise.resolve(false);
  if (!inflight && (force || (!fresh() && Date.now() - lastAttempt > RETRY_MS))) {
    lastAttempt = Date.now();
    inflight = download()
      .then(() => {
        lastError = null;
      })
      .catch((e) => {
        lastError = e.message;
        log(`IMDb ratings update failed: ${e.message}`);
      })
      .finally(() => {
        inflight = null;
      });
  }
  if (loaded() && !force && !wait) return Promise.resolve(true);
  return (inflight || Promise.resolve()).then(() => loaded());
}

/** IMDb id → { imdb, imdbVotes } for the ids IMDb has rated; null when the ratings aren't available. */
export function imdbRatings(imdbIds) {
  if (!loaded()) return null;
  const get = open().prepare('SELECT rating, votes FROM ratings WHERE id = ?');
  const out = new Map();
  for (const tt of imdbIds) {
    const id = /^tt\d+$/.test(tt || '') ? Number(tt.slice(2)) : null;
    const row = id && get.get(id);
    if (row) out.set(tt, { imdb: row.rating / 10, imdbVotes: row.votes });
  }
  return out;
}

export function imdbInfo() {
  if (!IMDB_ENABLED) return { enabled: false };
  return {
    enabled: true,
    titles: Number(meta('titles')) || 0,
    updatedAt: meta('updated_at'),
    updating: !!inflight,
    error: lastError,
  };
}
