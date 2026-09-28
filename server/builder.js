import { searchMedia } from './anilist.js';
import { arrClient, lookupByTitle } from './arr.js';
import { ensureMapping, lookupMapping } from './mapping.js';
import * as store from './db.js';
import { log } from './config.js';

export const DEFAULT_FILTERS = {
  sonarr: {
    season: { mode: 'current' },
    formats: ['TV', 'TV_SHORT', 'ONA'],
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
  },
  radarr: {
    season: { mode: 'currentYear' },
    formats: ['MOVIE'],
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
  },
};

/** Shared state for one refresh/preview pass: settings, overrides, arr clients, caches. */
export async function createContext() {
  await ensureMapping();
  const settings = store.getSettings();
  const ctx = {
    settings,
    overrides: store.getOverrideMap(),
    clients: { sonarr: arrClient('sonarr', settings), radarr: arrClient('radarr', settings) },
    library: {},
    lookupCache: new Map(),
    warnings: new Set(),
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

async function resolve(media, target, ctx) {
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

/** Builds a list's items from its filters. Does not persist anything. */
export async function buildItems(target, filters, ctx) {
  const { media, seasonLabel } = await searchMedia(filters, ctx.settings.seasonRolloverDays);
  const items = [];
  for (const m of media) {
    const match = await resolve(m, target, ctx);
    items.push({
      anilistId: m.id,
      malId: m.idMal,
      title: pickTitle(m, ctx.settings.titleLanguage),
      romaji: m.title.romaji,
      english: m.title.english,
      format: m.format,
      status: m.status,
      season: m.season,
      seasonYear: m.seasonYear,
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
      externalId: match.id,
      matchSource: match.source,
      inLibrary: match.id ? (ctx.library[target]?.has(match.id) ?? null) : null,
    });
  }
  return { items, seasonLabel };
}

/** The JSON body Sonarr / Radarr "Custom List" import expects. */
export function feedFor(list, items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (it.excluded || !it.externalId || seen.has(it.externalId)) continue;
    seen.add(it.externalId);
    out.push(
      list.target === 'sonarr'
        ? { title: it.title, tvdbId: it.externalId }
        : { id: it.externalId, title: it.title },
    );
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
    const lists = store
      .listLists()
      .filter((l) => (listIds ? listIds.includes(l.id) : l.enabled));
    log(`Refresh (${trigger}) started for ${lists.length} list(s)`);
    const ctx = await createContext();
    const touched = new Set();

    for (const list of lists) {
      try {
        const { items, seasonLabel } = await buildItems(list.target, list.filters, ctx);
        store.saveListItems(list.id, items);
        const matched = items.filter((i) => i.externalId).length;
        summary.lists.push({ id: list.id, name: list.name, seasonLabel, total: items.length, matched });
        touched.add(list.target);
        log(`  ${list.name}: ${matched}/${items.length} matched (${seasonLabel})`);
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
    if (status === 'ok' && summary.lists.length && summary.lists.every((l) => l.error)) status = 'error';
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
