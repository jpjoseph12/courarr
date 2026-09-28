import { searchMedia } from './anilist.js';
import { arrClient, lookupByTitle } from './arr.js';
import { ensureMapping, lookupMapping } from './mapping.js';
import { posterUrl, searchTmdb, tmdbClient, tvExternalIds } from './tmdb.js';
import * as store from './db.js';
import { log } from './config.js';

export const SOURCES = ['anilist', 'tmdb'];

const ANIME_BASE = {
  statuses: [],
  countries: ['JP'],
  genresInclude: [],
  genresExclude: [],
  tagsInclude: [],
  tagsExclude: [],
  minPopularity: 0,
  minScore: 0,
  sequels: 'include',
  sort: 'POPULARITY_DESC',
  limit: 50,
};

const TMDB_BASE = {
  collection: 'discover',
  releaseType: 'any',
  genresInclude: [],
  genresExclude: [],
  languages: [],
  countries: [],
  providers: [],
  region: '',
  networks: [],
  tvStatuses: [],
  tvTypes: [],
  keywordsInclude: [],
  keywordsExclude: [],
  excludeAnime: true,
  minRating: 0,
  minVotes: 0,
  sort: 'popularity',
  limit: 50,
};

export const DEFAULT_FILTERS = {
  anilist: {
    sonarr: { ...ANIME_BASE, season: { mode: 'current' }, formats: ['TV', 'TV_SHORT', 'ONA'] },
    radarr: { ...ANIME_BASE, season: { mode: 'currentYear' }, formats: ['MOVIE'] },
  },
  tmdb: {
    sonarr: { ...TMDB_BASE, date: { mode: 'any' }, minVotes: 50 },
    radarr: { ...TMDB_BASE, date: { mode: 'lastDays', days: 90 }, releaseType: 'digital', minVotes: 50 },
  },
};

/** Sonarr series type each list type should be added with. */
export const SERIES_TYPE = { anilist: 'anime', tmdb: 'standard' };

/** Shared state for one refresh/preview pass: settings, overrides, clients, caches. */
export async function createContext() {
  const settings = store.getSettings();
  const ctx = {
    settings,
    overrides: store.getOverrideMap(),
    clients: { sonarr: arrClient('sonarr', settings), radarr: arrClient('radarr', settings) },
    tmdb: tmdbClient(settings.tmdbApiKey),
    library: {},
    lookupCache: new Map(),
    warnings: new Set(),
    mappingReady: false,
  };
  for (const kind of ['sonarr', 'radarr']) {
    const client = ctx.clients[kind];
    if (!client) continue;
    try {
      ctx.library[kind] = await client.libraryIds();
    } catch (e) {
      ctx.warnings.add(`Could not reach ${kind}: ${e.message}`);
      ctx.clients[kind] = null;
    }
  }
  return ctx;
}

function inLibrary(ctx, target, { tvdbId, tmdbId, imdbId }) {
  const lib = ctx.library[target];
  if (!lib) return null;
  return !!((tvdbId && lib.tvdb.has(tvdbId)) || (tmdbId && lib.tmdb.has(tmdbId)) || (imdbId && lib.imdb.has(imdbId)));
}

// ---------- anime (AniList) ----------

function prequelTvdb(media) {
  // AniList gives us two levels of relations; walk PREQUEL edges breadth-first.
  const queue = media.relations.edges.filter((e) => e.relationType === 'PREQUEL').map((e) => e.node);
  for (let i = 0; i < queue.length && i < 20; i++) {
    const node = queue[i];
    const tvdb = lookupMapping(node.id)?.tvdbId;
    if (tvdb) return tvdb;
    for (const e of node.relations?.edges || []) {
      if (e.relationType === 'PREQUEL' && e.node.type === 'ANIME') queue.push(e.node);
    }
  }
  return null;
}

async function resolveAnime(media, target, ctx) {
  const ov = ctx.overrides.get(media.id);
  const map = lookupMapping(media.id);
  const client = ctx.clients[target];
  const useLookup = ctx.settings.arrLookupFallback && client;

  if (target === 'sonarr') {
    if (ov?.tvdb_id) return { id: ov.tvdb_id, source: 'override' };
    if (map?.tvdbId) return { id: map.tvdbId, source: 'mapping' };
    const viaPrequel = prequelTvdb(media);
    if (viaPrequel) return { id: viaPrequel, source: 'prequel' };
  } else {
    if (ov?.tmdb_id) return { id: ov.tmdb_id, source: 'override' };
    if (map?.tmdbMovieId) return { id: map.tmdbMovieId, source: 'mapping' };
    if (useLookup && map?.imdbId) {
      try {
        const hit = (await client.lookup(`imdb:${map.imdbId}`))[0];
        if (hit?.tmdbId) return { id: hit.tmdbId, source: 'imdb' };
      } catch {
        /* fall through to title search */
      }
    }
  }

  if (useLookup) {
    const key = `${target}:${media.id}`;
    if (!ctx.lookupCache.has(key)) ctx.lookupCache.set(key, await lookupByTitle(client, media));
    const id = ctx.lookupCache.get(key);
    if (id) return { id, source: 'lookup' };
  }
  return { id: null, source: null };
}

function pickTitle(media, lang) {
  const t = media.title;
  return (lang === 'romaji' ? t.romaji || t.english : t.english || t.romaji) || t.native;
}

async function buildAnime(target, filters, ctx) {
  if (!ctx.mappingReady) {
    await ensureMapping();
    ctx.mappingReady = true;
  }
  const { media, seasonLabel } = await searchMedia(filters, ctx.settings.seasonRolloverDays);
  const items = [];
  for (const m of media) {
    const match = await resolveAnime(m, target, ctx);
    const ids = target === 'sonarr' ? { tvdbId: match.id } : { tmdbId: match.id };
    items.push({
      key: m.id,
      anilistId: m.id,
      title: pickTitle(m, ctx.settings.titleLanguage),
      subtitle: m.title.romaji,
      format: m.format,
      year: m.startDate?.year || m.seasonYear,
      episodes: m.episodes,
      score: m.averageScore,
      popularity: m.popularity,
      genres: m.genres,
      studio: m.studios?.nodes?.[0]?.name || null,
      cover: m.coverImage?.large,
      color: m.coverImage?.color,
      siteUrl: m.siteUrl,
      sequel: m.isSequel,
      ...ids,
      externalId: match.id,
      matchSource: match.source,
      inLibrary: match.id ? inLibrary(ctx, target, ids) : null,
    });
  }
  return { items, label: seasonLabel };
}

// ---------- normal TV / movies (TMDB) ----------

async function buildTmdb(target, filters, ctx) {
  if (!ctx.tmdb) throw new Error('Add a TMDB API key in Settings to use normal TV / movie lists');
  const kind = target === 'sonarr' ? 'tv' : 'movie';
  const region = filters.region || ctx.settings.tmdbRegion || 'US';
  const { results, label } = await searchTmdb(ctx.tmdb, kind, filters, region);
  const tvIds = kind === 'tv' ? await tvExternalIds(ctx.tmdb, results.map((r) => r.id)) : new Map();

  // Sonarr v4's Custom List only honours TVDB ids. When TMDB doesn't know the TVDB id yet,
  // ask Sonarr (it resolves tmdb:<id> through its own metadata service).
  const sonarr = ctx.clients.sonarr;
  const viaSonarr = new Set();
  if (kind === 'tv' && sonarr) {
    for (const r of results) {
      const ext = tvIds.get(r.id);
      if (ext?.tvdbId) continue;
      try {
        const hit = (await sonarr.lookup(`tmdb:${r.id}`)).find((s) => s.tvdbId);
        if (hit) {
          tvIds.set(r.id, { tvdbId: hit.tvdbId, imdbId: ext?.imdbId || hit.imdbId || null });
          store.saveTmdbTvIds(r.id, hit.tvdbId, ext?.imdbId || hit.imdbId || null);
          viaSonarr.add(r.id);
        }
      } catch {
        /* leave it TMDB-only; the next refresh tries again */
      }
    }
  }

  const items = results.map((r) => {
    const ext = tvIds.get(r.id) || {};
    const ids = { tmdbId: r.id, tvdbId: ext.tvdbId || null, imdbId: ext.imdbId || null };
    const date = kind === 'tv' ? r.first_air_date : r.release_date;
    return {
      key: r.id,
      title: r.title || r.name,
      subtitle: r.original_title || r.original_name,
      format: kind === 'tv' ? 'TV' : 'MOVIE',
      year: date ? Number(date.slice(0, 4)) : null,
      date: date || null,
      rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
      votes: r.vote_count,
      popularity: r.popularity,
      genreIds: r.genre_ids,
      language: r.original_language,
      cover: posterUrl(r.poster_path),
      siteUrl: `https://www.themoviedb.org/${kind}/${r.id}`,
      ...ids,
      // Sonarr v4 needs a TVDB id; shows without one wait (unmatched) until TMDB or Sonarr has it.
      externalId: kind === 'tv' ? ids.tvdbId : r.id,
      matchSource: kind !== 'tv' ? 'tmdb' : !ids.tvdbId ? 'tmdbOnly' : viaSonarr.has(r.id) ? 'sonarr' : 'tmdb',
      inLibrary: inLibrary(ctx, target, ids),
    };
  });
  return { items, label };
}

/** Builds a list's items from its filters. Does not persist anything. */
export function buildItems(source, target, filters, ctx) {
  return source === 'tmdb' ? buildTmdb(target, filters, ctx) : buildAnime(target, filters, ctx);
}

/** The JSON body Sonarr / Radarr "Custom List" import expects. */
export function feedFor(list, items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (it.excluded || !it.externalId || seen.has(it.externalId)) continue;
    seen.add(it.externalId);
    if (list.target === 'radarr') {
      out.push({ id: it.externalId, title: it.title });
    } else if (list.source === 'tmdb') {
      const row = { title: it.title, tvdbId: it.tvdbId, tmdbId: it.tmdbId };
      if (it.imdbId) row.imdbId = it.imdbId;
      out.push(row);
    } else {
      out.push({ title: it.title, tvdbId: it.externalId });
    }
  }
  return out;
}

// ---------- refresh ----------

let queue = Promise.resolve();
let running = false;
export const isRunning = () => running;

/** Refreshes the given lists (default: all enabled). Runs are serialised. */
export function refresh({ listIds = null, trigger = 'manual' } = {}) {
  const job = queue.then(() => doRefresh(listIds, trigger));
  queue = job.catch(() => {});
  return job;
}

async function doRefresh(listIds, trigger) {
  running = true;
  const runId = store.startRun(trigger);
  const summary = { lists: [], warnings: [], synced: [] };
  let status = 'ok';
  try {
    const lists = store.listLists().filter((l) => (listIds ? listIds.includes(l.id) : l.enabled));
    log(`Refresh (${trigger}) started for ${lists.length} list(s)`);
    const ctx = await createContext();
    const touched = new Set();

    for (const list of lists) {
      try {
        const { items, label } = await buildItems(list.source, list.target, list.filters, ctx);
        store.saveListItems(list.id, items);
        const matched = items.filter((i) => i.externalId).length;
        summary.lists.push({ id: list.id, name: list.name, label, total: items.length, matched });
        touched.add(list.target);
        log(`  ${list.name}: ${matched}/${items.length} matched (${label})`);
      } catch (e) {
        status = 'partial';
        store.saveListItems(list.id, [], e.message);
        summary.lists.push({ id: list.id, name: list.name, error: e.message });
        log(`  ${list.name}: FAILED ${e.message}`);
      }
    }

    if (ctx.settings.triggerArrSync) {
      for (const kind of touched) {
        const client = ctx.clients[kind];
        if (!client) continue;
        try {
          await client.syncImportLists();
          summary.synced.push(kind);
        } catch (e) {
          ctx.warnings.add(`Could not trigger ${kind} import list sync: ${e.message}`);
        }
      }
    }
    summary.warnings = [...ctx.warnings];
    if (summary.lists.length && summary.lists.every((l) => l.error)) status = 'error';
  } catch (e) {
    status = 'error';
    summary.error = e.message;
    log(`Refresh failed: ${e.message}`);
  } finally {
    store.finishRun(runId, status, summary);
    running = false;
  }
  return { runId, status, summary };
}
