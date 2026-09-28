import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import { SEASONS, getMeta, resolveSeasonFilter } from './anilist.js';
import { arrClient } from './arr.js';
import {
  DEFAULT_FILTERS, SERIES_TYPE, SOURCES, buildItems, createContext, feedFor, isRunning, refresh,
} from './builder.js';
import { ensureMapping, mappingInfo } from './mapping.js';
import { SORTS as TMDB_SORTS, getTmdbMeta, resolveDateFilter, searchKeywords, tmdbClient } from './tmdb.js';
import { nextRun, schedule, validateCron } from './scheduler.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

// ---------- validation ----------

const FORMATS = ['TV', 'TV_SHORT', 'ONA', 'OVA', 'MOVIE', 'SPECIAL', 'MUSIC'];
const STATUSES = ['RELEASING', 'NOT_YET_RELEASED', 'FINISHED', 'CANCELLED', 'HIATUS'];
const SORTS = ['POPULARITY_DESC', 'SCORE_DESC', 'TRENDING_DESC', 'FAVOURITES_DESC', 'START_DATE_DESC'];
const SEASON_MODES = ['current', 'next', 'previous', 'specific', 'year', 'currentYear', 'none'];
const DATE_MODES = ['any', 'thisYear', 'year', 'lastDays', 'nextDays', 'airing'];

const strList = (v, allowed) => {
  const arr = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return [...new Set(allowed ? arr.filter((x) => allowed.includes(x)) : arr)];
};
const intList = (v) =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0))] : [];
const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};
const keywordList = (v) =>
  (Array.isArray(v) ? v : [])
    .map((k) => ({ id: Number(k?.id), name: String(k?.name || '').slice(0, 80) }))
    .filter((k) => Number.isInteger(k.id) && k.id > 0);
const year = () => new Date().getFullYear();

function sanitizeAnimeFilters(f, target) {
  const d = DEFAULT_FILTERS.anilist[target];
  const s = f.season || {};
  const mode = SEASON_MODES.includes(s.mode) ? s.mode : d.season.mode;
  const season = { mode };
  if (mode === 'specific') {
    if (!SEASONS.includes(s.season)) throw bad('Pick a season');
    season.season = s.season;
    season.year = clampInt(s.year, 1940, 2100, year());
  }
  if (mode === 'year') season.year = clampInt(s.year, 1940, 2100, year());

  return {
    season,
    formats: strList(f.formats ?? d.formats, FORMATS),
    statuses: strList(f.statuses, STATUSES),
    countries: strList(f.countries).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    genresInclude: strList(f.genresInclude),
    genresExclude: strList(f.genresExclude),
    tagsInclude: strList(f.tagsInclude),
    tagsExclude: strList(f.tagsExclude),
    minPopularity: clampInt(f.minPopularity, 0, 10_000_000, 0),
    minScore: clampInt(f.minScore, 0, 100, 0),
    sequels: ['include', 'exclude', 'only'].includes(f.sequels) ? f.sequels : 'include',
    sort: SORTS.includes(f.sort) ? f.sort : 'POPULARITY_DESC',
    limit: clampInt(f.limit, 1, 500, 50),
  };
}

function sanitizeTmdbFilters(f, target) {
  const d = DEFAULT_FILTERS.tmdb[target];
  const df = f.date || {};
  const mode = DATE_MODES.includes(df.mode) ? df.mode : d.date.mode;
  const date = { mode };
  if (mode === 'year') date.year = clampInt(df.year, 1900, 2100, year());
  if (mode === 'lastDays' || mode === 'nextDays') date.days = clampInt(df.days, 1, 3650, 30);
  const tv = target === 'sonarr';
  return {
    collection: f.collection === 'trending' ? 'trending' : 'discover',
    date,
    releaseType: !tv && ['theatrical', 'digital'].includes(f.releaseType) ? f.releaseType : 'any',
    genresInclude: intList(f.genresInclude),
    genresExclude: intList(f.genresExclude),
    languages: strList(f.languages).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c)),
    countries: strList(f.countries).map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)),
    providers: intList(f.providers),
    region: /^[A-Z]{2}$/.test(String(f.region || '').toUpperCase()) ? String(f.region).toUpperCase() : '',
    networks: tv ? intList(f.networks) : [],
    tvStatuses: tv ? intList(f.tvStatuses).filter((n) => n <= 5) : [],
    tvTypes: tv ? intList(f.tvTypes).filter((n) => n <= 6) : [],
    keywordsInclude: keywordList(f.keywordsInclude),
    keywordsExclude: keywordList(f.keywordsExclude),
    excludeAnime: f.excludeAnime !== false,
    minRating: Math.min(Math.max(Number(f.minRating) || 0, 0), 10),
    minVotes: clampInt(f.minVotes, 0, 1_000_000, 0),
    sort: f.sort in TMDB_SORTS && !(tv && f.sort === 'revenue') ? f.sort : 'popularity',
    limit: clampInt(f.limit, 1, 500, 50),
  };
}

const sanitizeFilters = (source, f = {}, target) =>
  source === 'tmdb' ? sanitizeTmdbFilters(f, target) : sanitizeAnimeFilters(f, target);

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

function validateList(body, id = 0) {
  const name = String(body.name || '').trim();
  if (!name) throw bad('Name is required');
  if (!['sonarr', 'radarr'].includes(body.target)) throw bad('Target must be sonarr or radarr');
  const source = SOURCES.includes(body.source) ? body.source : 'anilist';
  let slug = slugify(body.slug || name);
  if (!slug) throw bad('Name must contain letters or numbers');
  if (body.slug) {
    if (store.slugTaken(slug, id)) throw bad(`The feed name "${slug}" is already used by another list`);
  } else {
    const base = slug;
    for (let i = 2; store.slugTaken(slug, id); i++) slug = `${base}-${i}`;
  }
  return {
    name,
    slug,
    source,
    target: body.target,
    filters: sanitizeFilters(source, body.filters, body.target),
    enabled: body.enabled !== false,
  };
}

function listLabel(list, settings) {
  if (list.source === 'tmdb') {
    const kind = list.target === 'sonarr' ? 'tv' : 'movie';
    const { label } = resolveDateFilter(list.filters.date, kind, list.filters.releaseType);
    return list.filters.collection === 'trending' ? `Trending this week${label === 'Any time' ? '' : ` · ${label}`}` : label;
  }
  return resolveSeasonFilter(list.filters.season, settings.seasonRolloverDays).label;
}

function publicSettings() {
  const s = store.getSettings();
  return {
    ...s,
    sonarrApiKey: '',
    radarrApiKey: '',
    tmdbApiKey: '',
    sonarrApiKeySet: !!s.sonarrApiKey,
    radarrApiKeySet: !!s.radarrApiKey,
    tmdbApiKeySet: !!s.tmdbApiKey,
  };
}

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(404, 'Not found');
  return id;
};
const listOr404 = (id) => {
  const list = store.getList(id);
  if (!list) throw new HttpError(404, 'List not found');
  return list;
};
const arrOr400 = (kind) => {
  const client = arrClient(kind, store.getSettings());
  if (!client) throw bad(`Connect ${kind === 'sonarr' ? 'Sonarr' : 'Radarr'} in Settings first`);
  return client;
};
const tmdbOr400 = () => {
  const client = tmdbClient(store.getSettings().tmdbApiKey);
  if (!client) throw bad('Add a TMDB API key in Settings first');
  return client;
};

/** Where Sonarr/Radarr should fetch a feed from. */
function feedUrl(req, slug) {
  const base = store.getSettings().feedBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/${slug}`;
}
const arrListName = (list) => `Courarr – ${list.name}`;

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));

app.get('/api/status', (_req, res) => {
  const s = store.getSettings();
  res.json({
    version: VERSION,
    timezone: TZ,
    schedule: s.schedule,
    nextRun: nextRun(),
    running: isRunning(),
    mapping: mappingInfo(),
    lastRun: store.listRuns(1)[0] || null,
    currentSeason: resolveSeasonFilter({ mode: 'current' }, s.seasonRolloverDays).label,
    nextSeason: resolveSeasonFilter({ mode: 'next' }, s.seasonRolloverDays).label,
  });
});

app.get('/api/meta', async (_req, res) => {
  let anime = { genres: [], tags: [] };
  try {
    anime = await getMeta();
  } catch (e) {
    log(`AniList meta failed: ${e.message}`);
  }
  res.json({
    ...anime,
    formats: FORMATS,
    statuses: STATUSES,
    sorts: SORTS,
    defaults: DEFAULT_FILTERS,
    seriesType: SERIES_TYPE,
  });
});

app.get('/api/tmdb/meta', async (req, res) => {
  const kind = req.query.kind === 'movie' ? 'movie' : 'tv';
  const region = /^[A-Z]{2}$/.test(String(req.query.region)) ? req.query.region : store.getSettings().tmdbRegion;
  res.json(await getTmdbMeta(tmdbOr400(), kind, region));
});

app.get('/api/tmdb/keywords', async (req, res) => {
  res.json(await searchKeywords(tmdbOr400(), String(req.query.q || '').trim()));
});

app.get('/api/lists', (_req, res) => {
  const s = store.getSettings();
  res.json(
    store.listLists().map((l) => {
      const items = store.getListItems(l.id);
      return {
        ...l,
        label: listLabel(l, s),
        feedCount: feedFor(l, items).length,
        matchedCount: items.filter((i) => i.externalId).length,
        inLibraryCount: items.filter((i) => i.inLibrary).length,
      };
    }),
  );
});

app.post('/api/lists', (req, res) => {
  res.status(201).json(store.createList(validateList(req.body)));
});

app.get('/api/lists/:id', (req, res) => {
  const list = listOr404(idParam(req));
  res.json({
    ...list,
    label: listLabel(list, store.getSettings()),
    items: store.getListItems(list.id),
    exclusions: store.listExclusions(list.id),
  });
});

app.put('/api/lists/:id', async (req, res) => {
  const id = idParam(req);
  listOr404(id);
  const list = store.updateList(id, validateList(req.body, id));
  // Keep the linked Sonarr/Radarr import list's name and URL in step with renames.
  if (list.arr_list_id) {
    const client = arrClient(list.target, store.getSettings());
    try {
      const current = client && (await client.getImportList(list.arr_list_id));
      if (current) {
        await client.upsertImportList(list.arr_list_id, { ...current, name: arrListName(list), url: feedUrl(req, list.slug) });
      }
    } catch (e) {
      log(`Could not update ${list.target} import list: ${e.message}`);
    }
  }
  res.json(list);
});

app.delete('/api/lists/:id', async (req, res) => {
  const list = store.getList(idParam(req));
  if (list?.arr_list_id && req.query.keepArrList !== 'true') {
    await arrClient(list.target, store.getSettings())?.deleteImportList(list.arr_list_id);
  }
  if (list) store.deleteList(list.id);
  res.status(204).end();
});

app.post('/api/lists/:id/refresh', async (req, res) => {
  const list = listOr404(idParam(req));
  res.json(await refresh({ listIds: [list.id], trigger: 'manual' }));
});

app.post('/api/refresh', (_req, res) => {
  refresh({ trigger: 'manual' }).catch((e) => log(`Manual refresh failed: ${e.message}`));
  res.status(202).json({ started: true });
});

app.post('/api/preview', async (req, res) => {
  const target = req.body.target === 'radarr' ? 'radarr' : 'sonarr';
  const source = SOURCES.includes(req.body.source) ? req.body.source : 'anilist';
  const filters = sanitizeFilters(source, req.body.filters, target);
  const ctx = await createContext();
  const { items, label } = await buildItems(source, target, filters, ctx);
  const excluded = req.body.listId ? store.getExclusionIds(Number(req.body.listId)) : new Set();
  for (const it of items) it.excluded = excluded.has(it.key);
  res.json({ items, label, warnings: [...ctx.warnings] });
});

app.post('/api/lists/:id/exclusions', (req, res) => {
  const list = listOr404(idParam(req));
  const key = Number(req.body.key);
  if (!Number.isInteger(key)) throw bad('key is required');
  store.addExclusion(list.id, key, req.body.title);
  res.status(204).end();
});

app.delete('/api/lists/:id/exclusions/:key', (req, res) => {
  store.removeExclusion(idParam(req), Number(req.params.key));
  res.status(204).end();
});

// ---------- Sonarr / Radarr import list for a Courarr list ----------

app.get('/api/arr/:kind/options', async (req, res) => {
  const kind = req.params.kind === 'radarr' ? 'radarr' : 'sonarr';
  res.json(await arrOr400(kind).options());
});

app.get('/api/lists/:id/arr', async (req, res) => {
  const list = listOr404(idParam(req));
  const client = arrClient(list.target, store.getSettings());
  let current = null;
  if (client && list.arr_list_id) {
    current = await client.getImportList(list.arr_list_id);
    if (!current) store.setArrListId(list.id, null); // deleted on the Sonarr/Radarr side
  }
  res.json({
    connected: !!client,
    importList: current,
    recommendedSeriesType: SERIES_TYPE[list.source],
    feedUrl: feedUrl(req, list.slug),
  });
});

app.put('/api/lists/:id/arr', async (req, res) => {
  const list = listOr404(idParam(req));
  const client = arrOr400(list.target);
  const b = req.body;
  if (!b.rootFolderPath) throw bad('Pick a root folder');
  if (!Number.isInteger(Number(b.qualityProfileId))) throw bad('Pick a quality profile');
  const cfg = {
    name: arrListName(list),
    url: feedUrl(req, list.slug),
    rootFolderPath: String(b.rootFolderPath),
    qualityProfileId: Number(b.qualityProfileId),
    tags: intList(b.tags),
    searchOnAdd: !!b.searchOnAdd,
  };
  if (list.target === 'sonarr') {
    cfg.seriesType = ['standard', 'anime', 'daily'].includes(b.seriesType) ? b.seriesType : SERIES_TYPE[list.source];
    cfg.monitor = ['all', 'future', 'missing', 'existing', 'firstSeason', 'lastSeason', 'pilot', 'recent', 'none'].includes(b.monitor)
      ? b.monitor
      : 'all';
    cfg.seasonFolder = b.seasonFolder !== false;
  } else {
    cfg.monitor = ['movieOnly', 'movieAndCollection', 'none'].includes(b.monitor) ? b.monitor : 'movieOnly';
    cfg.minimumAvailability = ['announced', 'inCinemas', 'released'].includes(b.minimumAvailability)
      ? b.minimumAvailability
      : 'released';
  }
  const saved = await client.upsertImportList(list.arr_list_id, cfg);
  store.setArrListId(list.id, saved.id);
  res.json(saved);
});

app.delete('/api/lists/:id/arr', async (req, res) => {
  const list = listOr404(idParam(req));
  if (list.arr_list_id) await arrClient(list.target, store.getSettings())?.deleteImportList(list.arr_list_id);
  store.setArrListId(list.id, null);
  res.status(204).end();
});

// ---------- overrides ----------

app.get('/api/overrides', (_req, res) => res.json(store.listOverrides()));

app.put('/api/overrides/:anilistId', (req, res) => {
  const anilistId = Number(req.params.anilistId);
  if (!Number.isInteger(anilistId)) throw bad('Invalid AniList id');
  const parse = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw bad('IDs must be positive whole numbers');
    return n;
  };
  res.json(
    store.setOverride(anilistId, {
      tvdbId: parse(req.body.tvdbId),
      tmdbId: parse(req.body.tmdbId),
      title: req.body.title,
    }),
  );
});

app.delete('/api/overrides/:anilistId', (req, res) => {
  store.deleteOverride(Number(req.params.anilistId));
  res.status(204).end();
});

// ---------- settings ----------

app.get('/api/settings', (_req, res) => res.json(publicSettings()));

app.put('/api/settings', (req, res) => {
  const b = req.body;
  const patch = {};
  if (b.schedule !== undefined) {
    const expr = String(b.schedule).trim();
    const err = expr && validateCron(expr);
    if (err) throw bad(`Invalid schedule: ${err}`);
    patch.schedule = expr;
  }
  if (b.seasonRolloverDays !== undefined) patch.seasonRolloverDays = clampInt(b.seasonRolloverDays, 0, 45, 14);
  if (b.feedBaseUrl !== undefined) patch.feedBaseUrl = String(b.feedBaseUrl).trim().replace(/\/+$/, '');
  for (const kind of ['sonarr', 'radarr', 'tmdb']) {
    const cap = kind[0].toUpperCase() + kind.slice(1);
    if (kind !== 'tmdb' && b[`${kind}Url`] !== undefined) {
      patch[`${kind}Url`] = String(b[`${kind}Url`]).trim().replace(/\/+$/, '');
    }
    // Blank means "keep the saved key"; the explicit clear flag removes it.
    if (b[`${kind}ApiKey`]) patch[`${kind}ApiKey`] = String(b[`${kind}ApiKey`]).trim();
    if (b[`clear${cap}ApiKey`]) patch[`${kind}ApiKey`] = '';
  }
  if (b.tmdbRegion !== undefined && /^[A-Z]{2}$/.test(String(b.tmdbRegion))) patch.tmdbRegion = b.tmdbRegion;
  for (const k of ['arrLookupFallback', 'triggerArrSync']) if (b[k] !== undefined) patch[k] = !!b[k];
  if (['english', 'romaji'].includes(b.titleLanguage)) patch.titleLanguage = b.titleLanguage;

  const before = store.getSettings().schedule;
  const saved = store.saveSettings(patch);
  if (saved.schedule !== before) schedule(saved.schedule);
  res.json(publicSettings());
});

const causeOf = (e) => {
  const cause = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message;
  return cause ? `${e.message} (${cause})` : e.message;
};

app.post('/api/settings/test', async (req, res) => {
  const kind = req.body.kind;
  const saved = store.getSettings();
  if (kind === 'tmdb') {
    const client = tmdbClient(req.body.apiKey || saved.tmdbApiKey);
    if (!client) throw bad('API key is required');
    try {
      await client.get('/configuration');
      return res.json({ ok: true, appName: 'TMDB', version: 'API v3' });
    } catch (e) {
      return res.json({ ok: false, error: causeOf(e) });
    }
  }
  if (!['sonarr', 'radarr'].includes(kind)) throw bad('kind must be sonarr, radarr or tmdb');
  const client = arrClient(kind, {
    [`${kind}Url`]: req.body.url ?? saved[`${kind}Url`],
    [`${kind}ApiKey`]: req.body.apiKey || saved[`${kind}ApiKey`],
  });
  if (!client) throw bad('URL and API key are required');
  try {
    const st = await client.status();
    res.json({ ok: true, appName: st.appName || kind, version: st.version });
  } catch (e) {
    res.json({ ok: false, error: causeOf(e) });
  }
});

app.post('/api/mapping/update', async (_req, res) => {
  await ensureMapping({ force: true });
  res.json(mappingInfo());
});

app.get('/api/runs', (_req, res) => res.json(store.listRuns(50)));

// The URL Sonarr/Radarr poll. `/feed/<slug>` and `/feed/<slug>.json` both work.
app.get('/feed/:slug', (req, res) => {
  const list = store.getListBySlug(req.params.slug.replace(/\.json$/i, ''));
  if (!list) return res.status(404).json({ error: 'List not found' });
  res.set('Cache-Control', 'no-store').json(feedFor(list, store.getListItems(list.id)));
});

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// index.html references its assets with a per-start version so browsers that cached an older
// app.js/app.css (before an update) always fetch the new ones.
const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const ASSET_VERSION = `${VERSION}-${Date.now().toString(36)}`;
const indexHtml = fs
  .readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
  .replace(/(href|src)="(app\.(?:js|css))"/g, `$1="$2?v=${ASSET_VERSION}"`);
app.get(['/', '/index.html'], (_req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml));

// no-cache = revalidate by ETag on every load, so a container update never serves a stale UI.
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  }),
);

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log(`Error: ${err.stack || err.message}`);
  res.status(status).json({ error: err.message || 'Internal error' });
});

// ---------- start ----------

app.listen(PORT, () => log(`Courarr ${VERSION} listening on :${PORT} (TZ ${TZ})`));
schedule(store.getSettings().schedule);

// Warm the mapping cache in the background so the first anime refresh is quick.
ensureMapping().catch((e) => log(`Initial mapping load failed: ${e.message}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    process.exit(0);
  });
}
