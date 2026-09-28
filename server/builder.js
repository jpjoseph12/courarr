import { searchMedia, staffMediaIds } from './anilist.js';
import { arrClient, lookupByTitle } from './arr.js';
import { ensureMapping, lookupMapping } from './mapping.js';
import { certificationCheck, posterUrl, rememberTvdb, scanCatalogue, searchTmdb, tmdbClient, tmdbDetails } from './tmdb.js';
import { hasScoreFilter, omdbClient, scoreCheck, scoresFor } from './omdb.js';
import { ignoreIndex, ignoredReason, maintainerrClient, syncMaintainerr } from './maintainerr.js';
import { notifyAll } from './notify.js';
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
  genreMatch: 'all',
  streaming: [],
  studios: [],
  people: [],
  minEpisodes: 0,
  maxEpisodes: 0,
  minRuntime: 0,
  maxRuntime: 0,
  maxCertification: '',
  keepUnrated: true, // many anime have no TMDB rating, so don't drop them by default
  keepDays: 0,
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
  genreMatch: 'all',
  companies: [],
  people: [],
  minRuntime: 0,
  maxRuntime: 0,
  minSeasons: 0,
  maxSeasons: 0,
  minEpisodes: 0,
  maxEpisodes: 0,
  upcomingEpisode: false,
  maxCertification: '',
  keepUnrated: false,
  movieStatuses: [],
  sequels: 'include',
  keepDays: 0,
};

export const DEFAULT_FILTERS = {
  anilist: {
    sonarr: { ...ANIME_BASE, season: { mode: 'current' }, formats: ['TV', 'TV_SHORT', 'ONA'], seriesType: 'anime' },
    radarr: { ...ANIME_BASE, season: { mode: 'currentYear' }, formats: ['MOVIE'] },
  },
  tmdb: {
    sonarr: { ...TMDB_BASE, date: { mode: 'any' }, minVotes: 50, seriesType: 'standard' },
    radarr: { ...TMDB_BASE, date: { mode: 'lastDays', days: 90 }, releaseType: 'digital', minVotes: 50 },
  },
};

/** Sonarr series type each list type defaults to. */
export const SERIES_TYPE = { anilist: 'anime', tmdb: 'standard' };

/** The Sonarr series type a list's shows should be added with. */
export const seriesTypeFor = (list) => list.filters?.seriesType || SERIES_TYPE[list.source];

/** Shared state for one refresh/preview pass: settings, overrides, clients, caches. */
export async function createContext() {
  const settings = store.getSettings();
  const ctx = {
    settings,
    overrides: store.getOverrideMap(),
    clients: { sonarr: arrClient('sonarr', settings), radarr: arrClient('radarr', settings) },
    tmdb: tmdbClient(settings.tmdbApiKey),
    omdb: omdbClient(settings.omdbApiKey),
    ignore: ignoreIndex(),
    arrExcluded: {},
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
      const ex = await client.importExclusions().catch(() => []);
      ctx.arrExcluded[kind] = new Set(ex.map((x) => (kind === 'sonarr' ? x.tvdbId : x.tmdbId)).filter(Boolean));
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
  // People: keep only anime the chosen staff / voice actors worked on.
  let allowedIds = null;
  if (filters.people?.length) {
    allowedIds = new Set();
    for (const p of filters.people) for (const id of await staffMediaIds(p.id)) allowedIds.add(id);
  }

  // Age rating: AniList has none, so borrow TMDB's through the id mapping.
  const checks = [];
  const certs = new Map();
  if (filters.maxCertification) {
    if (!ctx.tmdb) {
      ctx.warnings.add('Age rating filter skipped: it needs a TMDB API key (Settings)');
    } else {
      const region = ctx.settings.tmdbRegion || 'US';
      const check = {
        tv: await certificationCheck(ctx.tmdb, 'tv', filters, region),
        movie: await certificationCheck(ctx.tmdb, 'movie', filters, region),
      };
      checks.push(async (batch) => {
        const refs = batch.map((m) => {
          const map = lookupMapping(m.id);
          return m.format === 'MOVIE' ? ['movie', map?.tmdbMovieId] : ['tv', map?.tmdbTvId];
        });
        const details = {};
        for (const kind of ['tv', 'movie']) {
          const ids = refs.filter(([k, id]) => k === kind && id).map(([, id]) => id);
          details[kind] = ids.length ? await tmdbDetails(ctx.tmdb, kind, ids) : new Map();
        }
        return batch.map((m, i) => {
          const [kind, id] = refs[i];
          const c = id ? details[kind].get(id)?.certs : null;
          if (c?.[region]) certs.set(m.id, c[region]);
          return check[kind](c);
        });
      });
    }
  }
  // Critic / audience scores, via the IMDb id in the mapping.
  if (hasScoreFilter(filters)) {
    if (!ctx.omdb) ctx.warnings.add('Score filters skipped: they need an OMDb API key (Settings)');
    else {
      const ok = scoreCheck(filters);
      checks.push(async (batch) => {
        const imdb = batch.map((m) => lookupMapping(m.id)?.imdbId || null);
        const scores = await scoresFor(ctx.omdb, imdb, (w) => ctx.warnings.add(w));
        return batch.map((_, i) => ok(imdb[i] ? scores.get(imdb[i]) : null));
      });
    }
  }
  const acceptBatch = checks.length
    ? async (batch) => {
        let ok = batch.map(() => true);
        for (const check of checks) {
          const r = await check(batch.filter((_, i) => ok[i]));
          let j = 0;
          ok = ok.map((v) => (v ? r[j++] : false));
        }
        return ok;
      }
    : null;

  const { media, seasonLabel } = await searchMedia(filters, ctx.settings.seasonRolloverDays, { allowedIds, acceptBatch });
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
      runtime: m.duration,
      certification: certs.get(m.id) || null,
      score: m.averageScore,
      popularity: m.popularity,
      genres: m.genres,
      studio: m.studios?.nodes?.[0]?.name || null,
      cover: m.coverImage?.large,
      color: m.coverImage?.color,
      siteUrl: m.siteUrl,
      sequel: m.isSequel,
      imdbId: lookupMapping(m.id)?.imdbId || null,
      ...ids,
      externalId: match.id,
      matchSource: match.source,
      inLibrary: match.id ? inLibrary(ctx, target, ids) : null,
    });
  }
  await attachScores(items, ctx);
  return { items, label: seasonLabel };
}

// ---------- normal TV / movies (TMDB) ----------

/**
 * "New on my services": scan the catalogue the list's filters describe, remember what's in it,
 * and return titles that appeared after tracking started, newest first.
 */
async function arrivals(kind, filters, region, ctx, { listId, record }) {
  if (!filters.providers?.length) throw new Error('Pick at least one streaming service for a “new on my services” list');
  const scan = await scanCatalogue(ctx.tmdb, kind, filters, region);
  if (scan.truncated) {
    ctx.warnings.add('This catalogue is bigger than the 2,000 titles Courarr can track — narrow it (e.g. original language or genre) so arrivals are spotted reliably.');
  }
  let state = { firstSeen: new Map(), baseline: null };
  if (listId) state = record ? store.recordCatalogue(listId, scan.results.map((r) => r.id)) : store.catalogueState(listId);
  const days = filters.arrivalDays || 14;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const fresh = scan.results
    .filter((r) => {
      const seen = state.firstSeen.get(r.id);
      return seen && state.baseline && seen > state.baseline && seen >= cutoff;
    })
    .sort((a, b) => state.firstSeen.get(b.id).localeCompare(state.firstSeen.get(a.id)) || (b.popularity || 0) - (a.popularity || 0));
  if (!state.baseline || (listId && !fresh.length && [...state.firstSeen.values()].every((v) => v === state.baseline))) {
    ctx.warnings.add(
      listId
        ? 'Tracking started: Courarr has recorded what’s on these services now. Titles that arrive from the next refresh on will show up here.'
        : 'Save the list to start tracking. The first refresh records what’s on these services; new arrivals show from the next one.',
    );
  }
  return { candidates: fresh, firstSeen: state.firstSeen, label: `New on your services · last ${days} days` };
}

async function buildTmdb(target, filters, ctx, opts = {}) {
  if (!ctx.tmdb) throw new Error('Add a TMDB API key in Settings to use normal TV / movie lists');
  const kind = target === 'sonarr' ? 'tv' : 'movie';
  const region = filters.region || ctx.settings.tmdbRegion || 'US';
  const arr = filters.collection === 'arrivals' ? await arrivals(kind, filters, region, ctx, opts) : null;

  let acceptBatch = null;
  if (hasScoreFilter(filters)) {
    if (!ctx.omdb) ctx.warnings.add('Score filters skipped: they need an OMDb API key (Settings)');
    else {
      const ok = scoreCheck(filters);
      acceptBatch = async (batch, details) => {
        const imdb = batch.map((r) => details.get(r.id)?.imdbId || null);
        const scores = await scoresFor(ctx.omdb, imdb, (w) => ctx.warnings.add(w));
        return batch.map((_, i) => ok(imdb[i] ? scores.get(imdb[i]) : null));
      };
    }
  }
  const { results, details, label } = await searchTmdb(ctx.tmdb, kind, filters, region, {
    candidates: arr?.candidates || null,
    candidateLabel: arr?.label,
    needImdb: !!ctx.omdb, // IMDb ids let scores show on every title
    acceptBatch,
  });
  const tvIds = new Map(results.map((r) => [r.id, details.get(r.id) || {}]));

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
          tvIds.set(r.id, { ...ext, tvdbId: hit.tvdbId, imdbId: ext?.imdbId || hit.imdbId || null });
          rememberTvdb(r.id, hit.tvdbId);
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
    const d = details.get(r.id) || {};
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
      seasons: d.seasons ?? null,
      episodes: d.episodes ?? null,
      runtime: d.runtime ?? null,
      status: d.status ?? null,
      nextEpisode: d.nextEpisode ?? null,
      certification: d.certs?.[region] || null,
      sequel: d.sequel ?? null,
      arrivedAt: arr?.firstSeen.get(r.id) || null,
      cover: posterUrl(r.poster_path),
      siteUrl: `https://www.themoviedb.org/${kind}/${r.id}`,
      ...ids,
      // Sonarr v4 needs a TVDB id; shows without one wait (unmatched) until TMDB or Sonarr has it.
      externalId: kind === 'tv' ? ids.tvdbId : r.id,
      matchSource: kind !== 'tv' ? 'tmdb' : !ids.tvdbId ? 'tmdbOnly' : viaSonarr.has(r.id) ? 'sonarr' : 'tmdb',
      inLibrary: inLibrary(ctx, target, ids),
    };
  });
  await attachScores(items, ctx);
  return { items, label };
}

/** Adds IMDb / RT / Metacritic scores to items for display (cached; needs an OMDb key). */
async function attachScores(items, ctx) {
  if (!ctx.omdb) return;
  const scores = await scoresFor(ctx.omdb, items.map((i) => i.imdbId), (w) => ctx.warnings.add(w));
  for (const it of items) {
    const sc = it.imdbId && scores.get(it.imdbId);
    if (sc && (sc.imdb != null || sc.rt != null || sc.metacritic != null)) it.scores = sc;
  }
}

/** Marks titles every feed must skip: Maintainerr collections and Sonarr/Radarr exclusions. */
export function markIgnored(items, target, ctx) {
  const kind = target === 'sonarr' ? 'show' : 'movie';
  const arr = target === 'sonarr' ? 'Sonarr' : 'Radarr';
  for (const it of items) {
    it.ignored =
      ignoredReason(ctx.ignore, kind, it) ||
      (it.externalId && ctx.arrExcluded[target]?.has(it.externalId) ? `On ${arr}’s import list exclusions` : null);
  }
  return items;
}

/**
 * Builds a list's items from its filters. `opts.listId` / `opts.record` let "new on my
 * services" lists read (and, during a refresh, update) their catalogue history.
 */
export async function buildItems(source, target, filters, ctx, opts = {}) {
  const built = source === 'tmdb' ? await buildTmdb(target, filters, ctx, opts) : await buildAnime(target, filters, ctx);
  markIgnored(built.items, target, ctx);
  return built;
}

/** The JSON body Sonarr / Radarr "Custom List" import expects. */
export function feedFor(list, items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (it.excluded || it.ignored || it.queued || !it.externalId || seen.has(it.externalId)) continue;
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

// ---------- keep after drop-off ----------

/**
 * Stamps the fresh results with lastSeen and carries over earlier items that dropped out of
 * the results less than `keepDays` ago, so a title doesn't flicker in and out of the feed.
 */
export function mergeRetained(prev, next, keepDays, now = new Date()) {
  const stamp = now.toISOString();
  const current = next.map((it) => ({ ...it, lastSeen: stamp, retained: false }));
  if (!(keepDays > 0)) return current;
  const keys = new Set(current.map((i) => i.key));
  const cutoff = now.getTime() - keepDays * 86_400_000;
  const kept = prev
    .filter((p) => !keys.has(p.key) && p.lastSeen && new Date(p.lastSeen).getTime() >= cutoff)
    .map(({ excluded, ...p }) => ({ ...p, retained: true }));
  return [...current, ...kept];
}

// ---------- drip-feed ----------

/**
 * Lets at most `maxNew` titles per refresh into the feed, highest-ranked first, so a new list
 * doesn't make Sonarr/Radarr grab everything at once. Titles already in the feed stay; titles
 * already in the library don't use up the allowance (nothing gets downloaded for them).
 */
export function applyDrip(prev, items, maxNew, now = new Date()) {
  const stamp = now.toISOString();
  // Anything that was in the feed before (incl. lists saved before drip existed) counts as fed.
  const fed = new Map(prev.filter((p) => p.fedAt || (p.externalId && !p.queued)).map((p) => [p.key, p.fedAt || p.lastSeen || stamp]));
  // A sequel shares its series' id: once the series is in the feed, the sequel is free.
  const fedIds = new Set(prev.filter((p) => fed.has(p.key) && p.externalId).map((p) => p.externalId));
  let budget = maxNew > 0 ? maxNew : Infinity;
  return items.map((it) => {
    if (fed.has(it.key)) return { ...it, fedAt: fed.get(it.key), queued: false };
    if (!it.externalId || it.excluded || it.ignored) return { ...it, queued: false };
    if (it.inLibrary || fedIds.has(it.externalId) || budget > 0) {
      if (!it.inLibrary && !fedIds.has(it.externalId)) budget--;
      fedIds.add(it.externalId);
      return { ...it, fedAt: stamp, queued: false };
    }
    return { ...it, queued: true };
  });
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
    const settings = store.getSettings();

    // Maintainerr first, so its collections apply to this run's feeds.
    const mt = maintainerrClient(settings);
    let abandonedShows = null;
    if (mt && settings.maintainerrCollections.length) {
      try {
        const synced = await syncMaintainerr(mt, settings.maintainerrCollections);
        summary.maintainerr = synced.map(({ collection, titles }) => ({ collection, titles }));
        abandonedShows = new Set(synced.flatMap((x) => x.rows.filter((r) => r.kind === 'show' && r.tvdbId).map((r) => r.tvdbId)));
      } catch (e) {
        summary.warnings.push(`Maintainerr: ${e.message} (using its last known collections)`);
      }
    }

    const ctx = await createContext();
    const touched = new Set();
    const notifications = [];

    if (abandonedShows && settings.maintainerrStopNewSeasons && ctx.clients.sonarr) {
      try {
        summary.stoppedNewSeasons = await ctx.clients.sonarr.stopNewSeasons(abandonedShows);
        if (summary.stoppedNewSeasons.length) log(`  Stopped new seasons in Sonarr: ${summary.stoppedNewSeasons.join(', ')}`);
      } catch (e) {
        ctx.warnings.add(`Could not update Sonarr monitoring: ${e.message}`);
      }
    }

    for (const list of lists) {
      try {
        const built = await buildItems(list.source, list.target, list.filters, ctx, { listId: list.id, record: true });
        const { label } = built;
        const prev = store.getListItems(list.id);
        const excluded = store.getExclusionIds(list.id);
        const merged = mergeRetained(prev, built.items, list.filters.keepDays).map((it) => ({ ...it, excluded: excluded.has(it.key) }));
        const items = applyDrip(prev, merged, list.filters.dripMax);
        store.saveListItems(list.id, items.map(({ excluded: _x, ...it }) => it));

        const matched = items.filter((i) => i.externalId).length;
        const queued = items.filter((i) => i.queued).length;
        const prevFeed = new Set(feedFor(list, prev).map((x) => x.id ?? x.tvdbId));
        // One entry per new series/movie: a sequel sharing its series' id isn't news twice.
        const addedIds = new Set();
        const added = items.filter((i) => {
          if (!feedFor(list, [i]).length || prevFeed.has(i.externalId) || i.inLibrary || addedIds.has(i.externalId)) return false;
          addedIds.add(i.externalId);
          return true;
        });
        summary.lists.push({ id: list.id, name: list.name, label, total: items.length, matched, queued, added: added.length });
        touched.add(list.target);
        log(`  ${list.name}: ${matched}/${items.length} matched, ${added.length} new${queued ? `, ${queued} queued` : ''} (${label})`);
        // A brand-new list would announce its whole first page; only drip-fed lists do that.
        if (added.length && list.filters.notify !== false && (prev.length || list.filters.dripMax > 0)) {
          notifications.push({
            kind: 'new',
            list: { name: list.name, target: list.target },
            titles: added.map((i) => ({ title: i.title, year: i.year, cover: i.cover, siteUrl: i.siteUrl })),
          });
        }
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
    summary.warnings.push(...ctx.warnings);
    if (summary.lists.length && summary.lists.every((l) => l.error)) status = 'error';

    // Notifications last, so a slow webhook never holds up the feeds.
    const notifiers = settings.notifiers || [];
    if (notifiers.length) {
      const events = settings.notifyOnNew ? [...notifications] : [];
      const failed = summary.lists.filter((l) => l.error);
      if (settings.notifyOnError && failed.length) events.push({ kind: 'error', lists: failed });
      for (const evt of events) {
        const failures = await notifyAll(notifiers, evt);
        summary.warnings.push(...failures.map((f) => `Notification failed: ${f}`));
      }
      if (events.length) summary.notified = events.length;
    }
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
