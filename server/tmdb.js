import * as store from './db.js';
import { log } from './config.js';

// TMDB_BASE_URL lets tests point at a local mock.
const BASE = (process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3').replace(/\/+$/, '');
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342';
const PER_PAGE = 20;
const DETAILS_MAX_AGE_MS = 7 * 86_400_000;
const NO_TVDB_MAX_AGE_MS = 3 * 86_400_000; // re-check shows that had no TVDB id yet sooner
// Client-side filters need details for every candidate; don't scan forever for a tiny list.
const MAX_CANDIDATES = 200;

export const ANIME_KEYWORD = 210024;
const ANIMATION_GENRE = 16;

// Curated because TMDB has no network search endpoint. Any other id can be added by hand
// (its name is looked up with /network/{id}).
export const NETWORKS = [
  [213, 'Netflix'], [1024, 'Prime Video'], [2739, 'Disney+'], [2552, 'Apple TV+'], [3186, 'Max'],
  [49, 'HBO'], [453, 'Hulu'], [4330, 'Paramount+'], [3353, 'Peacock'], [88, 'FX'], [174, 'AMC'],
  [67, 'Showtime'], [318, 'Starz'], [2, 'ABC'], [6, 'NBC'], [16, 'CBS'], [19, 'FOX'], [71, 'The CW'],
  [4, 'BBC One'], [332, 'BBC Two'], [3, 'BBC Three'], [9, 'ITV1'], [26, 'Channel 4'], [99, 'Channel 5'],
  [136, 'E4'], [1063, 'Sky Atlantic'], [214, 'Sky One'], [80, 'Adult Swim'], [47, 'Comedy Central'],
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
// Index = TMDB with_type id; the string is what /tv/{id} returns in `type`.
const TV_TYPE_NAMES = ['Documentary', 'News', 'Miniseries', 'Reality', 'Scripted', 'Talk Show', 'Video'];
export const TV_TYPES = TV_TYPE_NAMES.map((name, id) => ({ id, name: name === 'Talk Show' ? 'Talk show' : name }));
/** Date-based shows: Sonarr needs the Daily series type for these. */
export const DAILY_TYPES = [1, 5];

export const MOVIE_STATUSES = ['Released', 'Post Production', 'In Production', 'Planned', 'Rumored', 'Canceled'];

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
const inRange = (v, min, max) => v == null || ((!min || v >= min) && (!max || v <= max)); // unknown passes

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

async function certificationList(client, kind, region) {
  const all = await cached(`certs:${kind}`, async () => (await client.get(`/certification/${kind}/list`)).certifications);
  return (all?.[region] || [])
    .filter((c) => c.certification)
    .sort((a, b) => a.order - b.order)
    .map((c) => ({ code: c.certification, order: c.order, meaning: c.meaning }));
}

export async function getTmdbMeta(client, kind, region) {
  const [genres, providers, certifications] = await Promise.all([
    cached(`genres:${kind}`, async () => (await client.get(`/genre/${kind}/list`, { language: 'en' })).genres),
    cached(`providers:${kind}:${region}`, async () =>
      (await client.get(`/watch/providers/${kind}`, { watch_region: region, language: 'en' })).results
        .sort((a, b) => (a.display_priorities?.[region] ?? a.display_priority ?? 999) - (b.display_priorities?.[region] ?? b.display_priority ?? 999))
        .slice(0, 40)
        .map((p) => ({ id: p.provider_id, name: p.provider_name }))),
    certificationList(client, kind, region).catch(() => []),
  ]);
  return {
    genres,
    providers,
    certifications: certifications.map(({ code, meaning }) => ({ code, meaning })),
    networks: kind === 'tv' ? NETWORKS : [],
    languages: LANGUAGES,
    countries: COUNTRIES,
    tvStatuses: TV_STATUSES,
    tvTypes: TV_TYPES,
    movieStatuses: MOVIE_STATUSES,
    sorts: Object.entries(SORTS)
      .filter(([k]) => kind === 'movie' || k !== 'revenue')
      .map(([id, s]) => ({ id, name: s.label })),
  };
}

/** Search box helper for keywords, people (cast & crew) and production companies. */
export async function searchTmdbEntity(client, type, q) {
  if (!q || q.length < 2) return [];
  const r = await client.get(`/search/${type}`, { query: q });
  return r.results.slice(0, 15).map((x) => ({
    id: x.id,
    name:
      type === 'person' && x.known_for_department
        ? `${x.name} (${x.known_for_department})`
        : type === 'company' && x.origin_country
          ? `${x.name} (${x.origin_country})`
          : x.name,
  }));
}

export async function networkName(client, id) {
  return cached(`network:${id}`, async () => (await client.get(`/network/${id}`)).name);
}

// ---------- date windows ----------

/** Turns a list's date filter into discover params plus a label. `kind` is movie | tv. */
export function resolveDateFilter(df = {}, kind, releaseType = 'any', at = new Date()) {
  const today = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const plus = (n) => new Date(today.getTime() + n * 86_400_000);
  const verb = kind === 'tv' ? 'Premiered' : 'Released';
  const year = at.getUTCFullYear();
  let from;
  let to;
  let label;
  switch (df.mode) {
    case 'thisYear':
    case 'year': {
      const y = df.mode === 'year' ? Number(df.year) || year : year;
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      label = `${verb} in ${y}`;
      break;
    }
    case 'range': {
      const a = Number(df.fromYear) || year;
      const b = Math.max(Number(df.toYear) || a, a);
      from = `${a}-01-01`;
      to = `${b}-12-31`;
      label = a === b ? `${verb} in ${a}` : `${verb} ${a}–${b}`;
      break;
    }
    case 'lastYears': {
      const n = Math.max(1, Number(df.years) || 5);
      from = `${year - n + 1}-01-01`;
      to = iso(today);
      label = `${verb} in the last ${n} year${n > 1 ? 's' : ''}`;
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

/** The TV types a list allows, after applying its Sonarr series type. */
export function allowedTvTypes(f) {
  const picked = f.tvTypes?.length ? f.tvTypes : TV_TYPE_NAMES.map((_, i) => i);
  const daily = f.seriesType === 'daily';
  const allowed = picked.filter((t) => DAILY_TYPES.includes(t) === daily);
  // Picking only non-daily types on a Daily list (or vice versa) would match nothing.
  return allowed.length ? allowed : daily ? DAILY_TYPES : picked.filter((t) => !DAILY_TYPES.includes(t));
}

// ---------- discover ----------

export function discoverParams(kind, f, region, at = new Date()) {
  const date = resolveDateFilter(f.date, kind, kind === 'movie' ? f.releaseType : 'any', at);
  const sort = (SORTS[f.sort] || SORTS.popularity)[kind];
  const withoutKeywords = [...(f.keywordsExclude || []).map((k) => k.id), ...(f.excludeAnime ? [ANIME_KEYWORD] : [])];
  const genreJoin = f.genreMatch === 'any' ? '|' : ',';
  const params = {
    ...date.params,
    sort_by: sort,
    include_adult: 'false',
    include_video: 'false',
    language: 'en-US',
    with_genres: f.genresInclude.join(genreJoin),
    without_genres: f.genresExclude.join(','),
    with_original_language: f.languages.join('|'),
    with_origin_country: f.countries.join('|'),
    'vote_average.gte': f.minRating > 0 ? f.minRating : undefined,
    'vote_count.gte': f.minVotes > 0 ? f.minVotes : sort.startsWith('vote_average') ? 200 : undefined,
    'with_runtime.gte': f.minRuntime > 0 ? f.minRuntime : undefined,
    'with_runtime.lte': f.maxRuntime > 0 ? f.maxRuntime : undefined,
    with_keywords: (f.keywordsInclude || []).map((k) => k.id).join('|'),
    without_keywords: withoutKeywords.join(','),
    with_companies: (f.companies || []).map((c) => c.id).join('|'),
  };
  // With "keep unrated" the rating is checked from details instead, since discover drops unrated titles.
  if (f.maxCertification && !f.keepUnrated) {
    params.certification_country = region;
    params['certification.lte'] = f.maxCertification;
  }
  if (f.providers.length) {
    params.with_watch_providers = f.providers.join('|');
    params.watch_region = region;
    params.with_watch_monetization_types = 'flatrate|free|ads';
  }
  if (kind === 'movie') {
    params.with_people = (f.people || []).map((p) => p.id).join('|');
    if (f.releaseType !== 'any') {
      params.with_release_type = RELEASE_TYPES[f.releaseType];
      if (region) params.region = region;
    }
  }
  if (kind === 'tv') {
    params.with_networks = f.networks.join('|');
    params.with_status = f.tvStatuses.join('|');
    params.with_type = allowedTvTypes(f).join('|');
  }
  // "Newest" without a date window would surface far-future placeholders; cap it at today.
  if (f.sort === 'newest' && !date.range && f.date?.mode !== 'airing') {
    params[kind === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte'] = iso(at);
  }
  for (const k of Object.keys(params)) if (!nonEmpty(params[k])) delete params[k];
  return { params, label: date.label, range: date.range };
}

/** Client-side filters for candidates that didn't come from discover (trending, a person's credits). */
function passesLocalFilters(r, kind, f, range) {
  const genres = r.genre_ids || [];
  if (f.genresInclude.length) {
    const ok = f.genreMatch === 'any' ? f.genresInclude.some((g) => genres.includes(g)) : f.genresInclude.every((g) => genres.includes(g));
    if (!ok) return false;
  }
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

// ---------- details (cached) ----------

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

function certsOf(kind, d) {
  const out = {};
  if (kind === 'tv') {
    for (const r of d.content_ratings?.results || []) if (r.rating) out[r.iso_3166_1] = r.rating;
  } else {
    for (const r of d.release_dates?.results || []) {
      // Prefer the theatrical certificate, then any other release that has one.
      const dates = [...(r.release_dates || [])].sort((a, b) => (a.type === 3 ? -1 : b.type === 3 ? 1 : 0));
      const c = dates.find((x) => x.certification)?.certification;
      if (c) out[r.iso_3166_1] = c;
    }
  }
  return out;
}

function summarise(kind, d) {
  if (kind === 'tv') {
    return {
      tvdbId: d.external_ids?.tvdb_id || null,
      imdbId: d.external_ids?.imdb_id || null,
      seasons: d.number_of_seasons ?? null,
      episodes: d.number_of_episodes ?? null,
      runtime: d.episode_run_time?.[0] ?? d.last_episode_to_air?.runtime ?? null,
      status: d.status || null,
      type: TV_TYPE_NAMES.indexOf(d.type),
      nextEpisode: d.next_episode_to_air?.air_date || null,
      certs: certsOf(kind, d),
    };
  }
  return {
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    runtime: d.runtime || null,
    status: d.status || null,
    collectionId: d.belongs_to_collection?.id || null,
    certs: certsOf(kind, d),
  };
}

/** TMDB id -> summarised details for tv or movie, cached in SQLite. */
export async function tmdbDetails(client, kind, ids) {
  const out = new Map();
  const todo = [];
  for (const id of ids) {
    const c = store.getTmdbDetails(kind, id);
    const age = c ? Date.now() - new Date(c.fetched_at).getTime() : Infinity;
    const fresh = c && age < DETAILS_MAX_AGE_MS && (kind !== 'tv' || c.data.tvdbId || age < NO_TVDB_MAX_AGE_MS);
    if (fresh) out.set(id, c.data);
    else todo.push(id);
  }
  const append = kind === 'tv' ? 'external_ids,content_ratings' : 'external_ids,release_dates';
  await pool(todo, 8, async (id) => {
    try {
      const data = summarise(kind, await client.get(`/${kind}/${id}`, { append_to_response: append }));
      store.saveTmdbDetails(kind, id, data);
      out.set(id, data);
    } catch (e) {
      log(`TMDB details for ${kind}/${id} failed: ${e.message}`);
    }
  });
  return out;
}

/** Records a TVDB id found elsewhere (e.g. via Sonarr) on a cached TV entry. */
export function rememberTvdb(tmdbId, tvdbId) {
  const c = store.getTmdbDetails('tv', tmdbId);
  if (c) store.saveTmdbDetails('tv', tmdbId, { ...c.data, tvdbId });
}

/** Ids of a collection's films in release order (cached). */
async function collectionOrder(client, id) {
  return cached(`collection:${id}`, async () => {
    const c = await client.get(`/collection/${id}`);
    return (c.parts || [])
      .filter((p) => p.release_date)
      .sort((a, b) => a.release_date.localeCompare(b.release_date))
      .map((p) => p.id);
  });
}

/** TV shows a person acted in or worked on (incl. as creator), most popular first. */
async function personTvCredits(client, personId) {
  return cached(`person-tv:${personId}`, async () => {
    const r = await client.get(`/person/${personId}/tv_credits`, { language: 'en-US' });
    return [...(r.cast || []), ...(r.crew || [])];
  });
}

/** Age-rating check: `certs` is { region: code }. Unknown ratings pass only with keepUnrated. */
export async function certificationCheck(client, kind, f, region) {
  if (!f.maxCertification) return () => true;
  const list = await certificationList(client, kind, region).catch(() => []);
  const order = new Map(list.map((c) => [c.code, c.order]));
  const max = order.get(f.maxCertification);
  return (certs) => {
    const code = certs?.[region];
    if (!code || !order.has(code) || max == null) return !!f.keepUnrated;
    return order.get(code) <= max;
  };
}

// ---------- search ----------

export async function searchTmdb(client, kind, f, region) {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const { params, label, range } = discoverParams(kind, f, region);
  const trending = f.collection === 'trending';
  const tvPeople = kind === 'tv' && (f.people || []).length > 0;
  // Candidates that bypass discover need the discover-only checks done here instead.
  const local = trending || tvPeople;
  const runtimeLocal = local && (f.minRuntime > 0 || f.maxRuntime > 0);
  // TV always checks ratings from details: discover/tv's certification support is patchy.
  const certOk =
    f.maxCertification && (kind === 'tv' || f.keepUnrated || local) ? await certificationCheck(client, kind, f, region) : null;
  // TV always needs details (TVDB id); movies only when a details-based filter is on.
  const withDetails =
    kind === 'tv' || !!certOk || runtimeLocal || f.sequels !== 'include' || (f.movieStatuses || []).length > 0;
  const tvTypes = kind === 'tv' ? new Set(allowedTvTypes(f)) : null;

  // Candidate pages: discover, trending, or (TV) the chosen people's credits.
  let creditPool = null;
  if (tvPeople) {
    const seen = new Map();
    for (const p of f.people) for (const c of await personTvCredits(client, p.id)) if (!seen.has(c.id)) seen.set(c.id, c);
    creditPool = [...seen.values()].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  }
  const maxPages = trending ? 25 : Math.min(Math.ceil(limit / PER_PAGE) + 5, 100);
  const pageOf = async (page) => {
    if (creditPool) {
      const results = creditPool.slice((page - 1) * PER_PAGE, page * PER_PAGE);
      return { results, total_pages: Math.ceil(creditPool.length / PER_PAGE) };
    }
    return trending
      ? client.get(`/trending/${kind}/week`, { page, language: 'en-US' })
      : client.get(`/discover/${kind}`, { ...params, page });
  };

  const out = [];
  const details = new Map();
  const seen = new Set();
  let examined = 0;
  for (let page = 1; page <= maxPages && out.length < limit && examined < MAX_CANDIDATES; page++) {
    const data = await pageOf(page);
    let batch = (data.results || []).filter((r) => {
      if (seen.has(r.id) || r.adult) return false;
      seen.add(r.id);
      if ((trending || creditPool) && !passesLocalFilters(r, kind, f, range)) return false;
      return !(f.excludeAnime && looksLikeAnime(r));
    });
    examined += batch.length;

    if (withDetails && batch.length) {
      const d = await tmdbDetails(client, kind, batch.map((r) => r.id));
      for (const [id, v] of d) details.set(id, v);
      const keep = [];
      for (const r of batch) {
        const x = details.get(r.id);
        if (!x) {
          keep.push(r); // details unavailable: don't punish the title for it
          continue;
        }
        if (certOk && !certOk(x.certs)) continue;
        if (runtimeLocal && !inRange(x.runtime, f.minRuntime, f.maxRuntime)) continue;
        if (kind === 'tv') {
          if (x.type >= 0 && !tvTypes.has(x.type)) continue;
          if (!inRange(x.seasons, f.minSeasons, f.maxSeasons)) continue;
          if (!inRange(x.episodes, f.minEpisodes, f.maxEpisodes)) continue;
          if (f.upcomingEpisode && !x.nextEpisode) continue;
        } else {
          if ((f.movieStatuses || []).length && x.status && !f.movieStatuses.includes(x.status)) continue;
          if (f.sequels !== 'include' && x.collectionId) {
            const order = await collectionOrder(client, x.collectionId).catch(() => []);
            const isSequel = order.indexOf(r.id) > 0;
            if (f.sequels === 'exclude' && isSequel) continue;
            if (f.sequels === 'only' && !isSequel) continue;
            x.sequel = isSequel;
          } else if (f.sequels === 'only') {
            continue; // standalone films aren't sequels
          }
        }
        keep.push(r);
      }
      batch = keep;
    }

    for (const r of batch) {
      out.push(r);
      if (out.length >= limit) break;
    }
    if (page >= (data.total_pages || 1)) break;
  }
  const prefix = creditPool ? 'Credits' : trending ? 'Trending this week' : null;
  return {
    results: out,
    details,
    label: prefix ? `${prefix}${range ? ` · ${label}` : ''}` : label,
  };
}

export const posterUrl = (p) => (p ? IMAGE_BASE + p : null);
