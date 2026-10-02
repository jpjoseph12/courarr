import * as store from './db.js';
import { log } from './config.js';
import { imdbRatings } from './imdb.js';

// OMDb gives IMDb, Rotten Tomatoes and Metacritic scores in one call per IMDb id.
// OMDB_BASE_URL lets tests point at a local mock.
const BASE = (process.env.OMDB_BASE_URL || 'https://www.omdbapi.com').replace(/\/+$/, '');
const MAX_AGE_MS = 7 * 86_400_000;
const EMPTY_MAX_AGE_MS = 2 * 86_400_000; // titles with no scores yet: check again sooner

export function omdbClient(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) return null;
  let exhausted = false;

  async function get(imdbId) {
    if (exhausted) return null;
    const url = new URL(BASE + '/');
    url.searchParams.set('apikey', key);
    url.searchParams.set('i', imdbId);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = await res.json().catch(() => null);
    if (body?.Response === 'False') {
      if (/limit/i.test(body.Error)) {
        exhausted = true; // stop hammering it for the rest of this run
        throw new Error('OMDb daily request limit reached');
      }
      if (/api key/i.test(body.Error)) throw new Error(`OMDb: ${body.Error}`);
      return {}; // unknown title
    }
    if (!res.ok || !body) throw new Error(`OMDb: HTTP ${res.status}`);
    return body;
  }
  return { get };
}

const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export function summariseOmdb(b) {
  const rt = (b.Ratings || []).find((r) => r.Source === 'Rotten Tomatoes')?.Value;
  return {
    imdb: b.imdbRating && b.imdbRating !== 'N/A' ? num(b.imdbRating) : null,
    imdbVotes: b.imdbVotes && b.imdbVotes !== 'N/A' ? num(b.imdbVotes) : null,
    rt: rt ? num(rt) : null,
    metacritic: b.Metascore && b.Metascore !== 'N/A' ? num(b.Metascore) : null,
  };
}

const hasAny = (s) => s && (s.imdb != null || s.rt != null || s.metacritic != null);

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

const OMDB_KEYS = ['imdb', 'rt', 'metacritic'];

/**
 * IMDb id -> { imdb, imdbVotes, rt, metacritic }. OMDb answers are cached in SQLite; the IMDb
 * rating itself comes from IMDb's daily ratings file when that's loaded (fresher than OMDb's).
 * Titles OMDb couldn't be asked about (quota, outage) carry `unchecked: [keys]`, so filters can
 * tell "no score yet" from "couldn't look". Warnings go to `warn`.
 * `omdb: false` skips OMDb when only the IMDb rating is wanted.
 */
export async function scoresFor(client, imdbIds, warn = () => {}, { omdb = true } = {}) {
  const ids = [...new Set(imdbIds.filter(Boolean))];
  const out = new Map();
  const todo = [];
  for (const id of omdb ? ids : []) {
    const c = store.getOmdb(id);
    const age = c ? Date.now() - new Date(c.fetched_at).getTime() : Infinity;
    if (c && age < (hasAny(c.data) ? MAX_AGE_MS : EMPTY_MAX_AGE_MS)) out.set(id, c.data);
    else if (client) todo.push(id);
  }
  await pool(todo, 4, async (id) => {
    try {
      const body = await client.get(id);
      if (!body) throw new Error('OMDb daily request limit reached');
      const s = summariseOmdb(body);
      store.saveOmdb(id, s);
      out.set(id, s);
    } catch (e) {
      warn(e.message);
      log(`OMDb ${id}: ${e.message}`);
      // An older answer beats none; with nothing at all, say so rather than "no score".
      out.set(id, store.getOmdb(id)?.data || { imdb: null, imdbVotes: null, rt: null, metacritic: null, unchecked: OMDB_KEYS });
    }
  });

  const imdb = imdbRatings(ids);
  if (imdb) {
    for (const id of ids) {
      const prev = out.get(id);
      // Missing from IMDb's file means IMDb has no rating for it yet.
      const s = { rt: null, metacritic: null, ...prev, ...(imdb.get(id) || { imdb: null, imdbVotes: null }) };
      const unchecked = prev?.unchecked?.filter((k) => k !== 'imdb');
      if (unchecked?.length) s.unchecked = unchecked;
      else delete s.unchecked;
      out.set(id, s);
    }
  }
  return out;
}

export const hasScoreFilter = (f) => f.minImdb > 0 || f.minRt > 0 || f.minMetacritic > 0;

/**
 * Score filter: every set minimum must be met. A title with no score passes only with
 * keepUnscored; one whose score couldn't be checked (OMDb quota or outage) never does.
 */
export function scoreCheck(f) {
  const checks = [
    ['imdb', f.minImdb],
    ['rt', f.minRt],
    ['metacritic', f.minMetacritic],
  ].filter(([, min]) => min > 0);
  return (s) =>
    checks.every(([k, min]) => {
      const v = s?.[k];
      if (v != null) return v >= min;
      if (s?.unchecked?.includes(k)) return false;
      return f.keepUnscored !== false;
    });
}
