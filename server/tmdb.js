import * as store from './db.js';
import { log } from './config.js';

// TMDB_BASE_URL lets tests point at a local mock.
const BASE = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
const PER_PAGE = 20;
const TV_IDS_MAX_AGE_MS = 3 * 86_400_000; // re-check shows that had no TVDB id yet

export const ANIME_KEYWORD = 210024;
const ANIMATION_GENRE = 16;

// Curated because TMDB has no network search endpoint. Any other id can be added by hand.
export const NETWORKS = [
  [213, 'Netflix'], [1024, 'Prime Video'], [2739, 'Disney+'], [2552, 'Apple TV+'], [3186, 'Max'],
  [49, 'HBO'], [453, 'Hulu'], [4330, 'Paramount+'], [3353, 'Peacock'], [88, 'FX'], [174, 'AMC'],
  [67, 'Showtime'], [2, 'ABC'], [6, 'NBC'], [16, 'CBS'], [19, 'FOX'], [4, 'BBC One'], [332, 'BBC Two'],
  [9, 'ITV1'], [26, 'Channel 4'], [1063, 'Sky Atlantic'], [80, 'Adult Swim'],
].map(([id, name]) => ({ id, name }));

export const LANGUAGES = [
  ['en', 'English'], ['ko', 'Korean'], ['ja', 'Japanese'], ['es', 'Spanish'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['pt', 'Portuguese'],
  ['sv', 'Swedish'], ['da', 'Danish'], ['no', 'Norwegian'], ['tr', 'Turkish'],
].map(([code, name]) => ({ code, name }));

export const COUNTRIES = [
  ['US', 'United States'], ['GB', 'United Kingdom'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['IE', 'Ireland'], ['KR', 'South Korea'], ['JP', 'Japan'], ['FR', 'France'], ['DE', 'Germany'],
  ['ES', 'Spain'], ['IT', 'Italy'], ['IN', 'India'], ['SE', 'Sweden'], ['DK', 'Denmark'],
].map(([code, name]) => ({ code, name }));

export const TV_STATUSES = ['Returning', 'Planned', 'In production', 'Ended', 'Cancelled', 'Pilot']
  .map((name, id) => ({ id, name }));
export const TV_TYPES = ['Documentary', 'News', 'Miniseries', 'Reality', 'Scripted', 'Talk show', 'Video']
  .map((name, id) => ({ id, name }));

export const SORTS = {
  popularity: { movie: 'popularity.desc', tv: 'popularity.desc', label: 'Popularity' },
  rating: { movie: 'vote_average.desc', tv: 'vote_average.desc', label: 'Rating' },
  votes: { movie: 'vote_count.desc', tv: 'vote_count.desc', label: 'Most votes' },
  newest: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc', label: 'Newest' },
  revenue: { movie: 'revenue.desc', tv: 'popularity.desc', label: 'Box office' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);
const nonEmpty = (v) => v !== undefined && v !== null && v !== '';

// ---------- client ----------

export function tmdbClient(apiKey) {
  const key = (apiKey || '').trim();
  if (!key) return null;
  // v4 "API Read Access Token" (a JWT) goes in a header; the short v3 key goes in the query.
  const bearer = key.startsWith('eyJ');

  async function get(path, params = {}, attempt = 0) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (nonEmpty(v)) url.searchParams.set(k, v);
    if (!bearer) url.searchParams.set('api_key', key);
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < 3) {
      await sleep((Number(res.headers.get('retry-after')) || 2) * 1000);
      return get(path, params, attempt + 1);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`TMDB: ${body?.status_message || `HTTP ${res.status}`}`);
    return body;
  }

  return { get };
}

// ---------- metadata (cached) ----------

const metaCache = new Map();
async function cached(key, fn) {
  const hit = metaCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.data;
  const data = await fn();
  metaCache.set(key, { at: Date.now(), data });
  return data;
}

export async function getTmdbMeta(client, kind, region) {
  const [genres, providers] = await Promise.all([
    cached(`genres:${kind}`, async () => (await client.get(`/genre/${kind}/list`, { language: 'en' })).genres),
    cached(`providers:${kind}:${region}`, async () =>
      (await client.get(`/watch/providers/${kind}`, { watch_region: region, language: 'en' })).results
        .sort((a, b) => (a.display_priorities?.[region] ?? a.display_priority ?? 999) - (b.display_priorities?.[region] ?? b.display_priority ?? 999))
        .slice(0, 40)
        .map((p) => ({ id: p.provider_id, name: p.provider_name }))),
  ]);
  return {
    genres,
    providers,
    networks: kind === 'tv' ? NETWORKS : [],
    languages: LANGUAGES,
    countries: COUNTRIES,
    tvStatuses: TV_STATUSES,
    tvTypes: TV_TYPES,
    sorts: Object.entries(SORTS)
      .filter(([k]) => kind === 'movie' || k !== 'revenue')
      .map(([id, s]) => ({ id, name: s.label })),
  };
}

export async function searchKeywords(client, q) {
  if (!q || q.length < 2) return [];
  const r = await client.get('/search/keyword', { query: q });
  return r.results.slice(0, 15).map((k) => ({ id: k.id, name: k.name }));
}

// ---------- date windows ----------

/** Turns a list's date filter into discover params plus a label. `kind` is movie | tv. */
export function resolveDateFilter(df = {}, kind, releaseType = 'any', at = new Date()) {
  const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const plus = (n) => new Date(today.getTime() + n * 86_400_000);
  const verb = kind === 'tv' ? 'Premiered' : 'Released';
  let from;
  let to;
  let label;
  switch (df.mode) {
    case 'thisYear':
    case 'year': {
      const y = df.mode === 'year' ? Number(df.year) || at.getUTCFullYear() : at.getUTCFullYear();
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      label = `${verb} in ${y}`;
      break;
    }
    case 'lastDays': {
      const n = Math.max(1, Number(df.days) || 30);
      from = iso(plus(-n));
      to = iso(today);
      label = `${verb} in the last ${n} days`;
      break;
    }
    case 'nextDays': {
      const n = Math.max(1, Number(df.days) || 30);
      from = iso(today);
      to = iso(plus(n));
      label = `Coming in the next ${n} days`;
      break;
    }
    case 'airing':
      if (kind === 'tv') {
        return {
          params: { 'air_date.gte': iso(today), 'air_date.lte': iso(plus(7)) },
          label: 'Airing this week',
          range: null,
        };
      }
      return { params: {}, label: 'Any time', range: null };
    default:
      return { params: {}, label: 'Any time', range: null };
  }

  let params;
  if (kind === 'tv') params = { 'first_air_date.gte': from, 'first_air_date.lte': to };
  else if (releaseType !== 'any') params = { 'release_date.gte': from, 'release_date.lte': to };
  else params = { 'primary_release_date.gte': from, 'primary_release_date.lte': to };
  return { params, label, range: { from, to } };
}

const RELEASE_TYPES = { theatrical: '2|3', digital: '4|5' };

// ---------- discover ----------

export function discoverParams(kind, f, region, at = new Date()) {
  const date = resolveDateFilter(f.date, kind, kind === 'movie' ? f.releaseType : 'any', at);
  const sort = (SORTS[f.sort] || SORTS.popularity)[kind];
  const withoutKeywords = [...(f.keywordsExclude || []).map((k) => k.id), ...(f.excludeAnime ? [ANIME_KEYWORD] : [])];
  const params = {
    ...date.params,
    sort_by: sort,
    include_adult: 'false',
    include_video: 'false',
    language: 'en-US',
    with_genres: f.genresInclude.join(','),
    without_genres: f.genresExclude.join(','),
    with_original_language: f.languages.join('|'),
    with_origin_country: f.countries.join('|'),
    'vote_average.gte': f.minRating > 0 ? f.minRating : undefined,
    'vote_count.gte': f.minVotes > 0 ? f.minVotes : sort.startsWith('vote_average') ? 200 : undefined,
    with_keywords: (f.keywordsInclude || []).map((k) => k.id).join('|'),
    without_keywords: withoutKeywords.join(','),
  };
  if (f.providers.length) {
    params.with_watch_providers = f.providers.join('|');
    params.watch_region = region;
    params.with_watch_monetization_types = 'flatrate|free|ads';
  }
  if (kind === 'movie' && f.releaseType !== 'any') {
    params.with_release_type = RELEASE_TYPES[f.releaseType];
    if (region) params.region = region;
  }
  if (kind === 'tv') {
    params.with_networks = f.networks.join('|');
    params.with_status = f.tvStatuses.join('|');
    params.with_type = f.tvTypes.join('|');
  }
  // "Newest" without a date window would surface far-future placeholders; cap it at today.
  if (f.sort === 'newest' && !date.range && f.date?.mode !== 'airing') {
    params[kind === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = iso(at);
  }
  for (const k of Object.keys(params)) if (!nonEmpty(params[k])) delete params[k];
  return { params, label: date.label, range: date.range };
}

/** Client-side filters for endpoints that don't take discover params (trending). */
function passesLocalFilters(r, kind, f, range) {
  const genres = r.genre_ids || [];
  if (f.genresInclude.some((g) => !genres.includes(g))) return false;
  if (f.genresExclude.some((g) => genres.includes(g))) return false;
  if (f.languages.length && !f.languages.includes(r.original_language)) return false;
  if (f.countries.length && r.origin_country && !r.origin_country.some((c) => f.countries.includes(c))) return false;
  if (f.minRating > 0 && (r.vote_average || 0) < f.minRating) return false;
  if (f.minVotes > 0 && (r.vote_count || 0) < f.minVotes) return false;
  if (range) {
    const d = kind === 'tv' ? r.first_air_date : r.release_date;
    if (!d || d < range.from || d > range.to) return false;
  }
  return true;
}

/** Anime slips through keyword filters when it isn't tagged; catch Japanese animation too. */
const looksLikeAnime = (r) => (r.genre_ids || []).includes(ANIMATION_GENRE) && r.original_language === 'ja';

export async function searchTmdb(client, kind, f, region) {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const { params, label, range } = discoverParams(kind, f, region);
  const trending = f.collection === 'trending';
  const maxPages = trending ? 25 : Math.min(Math.ceil(limit / PER_PAGE) + 5, 100);
  const out = [];
  const seen = new Set();

  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const data = trending
      ? await client.get(`/trending/${kind}/week`, { page, language: 'en-US' })
      : await client.get(`/discover/${kind}`, { ...params, page });
    for (const r of data.results || []) {
      if (seen.has(r.id) || r.adult) continue;
      if (trending && !passesLocalFilters(r, kind, f, range)) continue;
      if (f.excludeAnime && looksLikeAnime(r)) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= limit) break;
    }
    if (page >= (data.total_pages || 1)) break;
  }
  return { results: out, label: trending ? `Trending this week${range ? ` · ${label}` : ''}` : label };
}

// ---------- TV external ids ----------

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

/** TMDB TV id -> { tvdbId, imdbId }, cached in SQLite. */
export async function tvExternalIds(client, tmdbIds) {
  const out = new Map();
  const todo = [];
  for (const id of tmdbIds) {
    const c = store.getTmdbTvIds(id);
    const fresh = c && (c.tvdb_id || Date.now() - new Date(c.fetched_at).getTime() < TV_IDS_MAX_AGE_MS);
    if (fresh) out.set(id, { tvdbId: c.tvdb_id, imdbId: c.imdb_id });
    else todo.push(id);
  }
  await pool(todo, 8, async (id) => {
    try {
      const r = await client.get(`/tv/${id}/external_ids`);
      store.saveTmdbTvIds(id, r.tvdb_id || null, r.imdb_id || null);
      out.set(id, { tvdbId: r.tvdb_id || null, imdbId: r.imdb_id || null });
    } catch (e) {
      log(`TMDB external ids for tv/${id} failed: ${e.message}`);
      out.set(id, { tvdbId: null, imdbId: null });
    }
  });
  return out;
}

export const posterUrl = (p) => (p ? IMAGE_BASE + p : null);
