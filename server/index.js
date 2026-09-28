import express from 'express';
import { fileURLToPath } from 'node:url';
import { PORT, TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import { SEASONS, getMeta, resolveSeasonFilter } from './anilist.js';
import { arrClient } from './arr.js';
import { DEFAULT_FILTERS, buildItems, createContext, feedFor, isRunning, refresh } from './builder.js';
import { ensureMapping, mappingInfo } from './mapping.js';
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

const strList = (v, allowed) => {
  const arr = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  return allowed ? arr.filter((x) => allowed.includes(x)) : [...new Set(arr)];
};
const clampInt = (v, min, max, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
};

function sanitizeFilters(f = {}, target) {
  const d = DEFAULT_FILTERS[target];
  const s = f.season || {};
  const mode = SEASON_MODES.includes(s.mode) ? s.mode : d.season.mode;
  const season = { mode };
  if (mode === 'specific') {
    if (!SEASONS.includes(s.season)) throw bad('Pick a season');
    season.season = s.season;
    season.year = clampInt(s.year, 1940, 2100, new Date().getFullYear());
  }
  if (mode === 'year') season.year = clampInt(s.year, 1940, 2100, new Date().getFullYear());

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
    target: body.target,
    filters: sanitizeFilters(body.filters, body.target),
    enabled: body.enabled !== false,
  };
}

function publicSettings() {
  const s = store.getSettings();
  return {
    ...s,
    sonarrApiKey: '',
    radarrApiKey: '',
    sonarrApiKeySet: !!s.sonarrApiKey,
    radarrApiKeySet: !!s.radarrApiKey,
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
  res.json({ ...(await getMeta()), formats: FORMATS, statuses: STATUSES, sorts: SORTS, defaults: DEFAULT_FILTERS });
});

app.get('/api/lists', (_req, res) => {
  const s = store.getSettings();
  res.json(
    store.listLists().map((l) => {
      const items = store.getListItems(l.id);
      return {
        ...l,
        seasonLabel: resolveSeasonFilter(l.filters.season, s.seasonRolloverDays).label,
        feedCount: feedFor(l, items).length,
        matchedCount: items.filter((i) => i.externalId).length,
        inLibraryCount: items.filter((i) => i.inLibrary).length,
      };
    }),
  );
});

app.post('/api/lists', (req, res) => {
  const list = store.createList(validateList(req.body));
  res.status(201).json(list);
});

app.get('/api/lists/:id', (req, res) => {
  const list = listOr404(idParam(req));
  const s = store.getSettings();
  res.json({
    ...list,
    seasonLabel: resolveSeasonFilter(list.filters.season, s.seasonRolloverDays).label,
    items: store.getListItems(list.id),
    exclusions: store.listExclusions(list.id),
  });
});

app.put('/api/lists/:id', (req, res) => {
  const id = idParam(req);
  listOr404(id);
  res.json(store.updateList(id, validateList(req.body, id)));
});

app.delete('/api/lists/:id', (req, res) => {
  store.deleteList(idParam(req));
  res.status(204).end();
});

app.post('/api/lists/:id/refresh', async (req, res) => {
  const list = listOr404(idParam(req));
  const result = await refresh({ listIds: [list.id], trigger: 'manual' });
  res.json(result);
});

app.post('/api/refresh', (_req, res) => {
  refresh({ trigger: 'manual' }).catch((e) => log(`Manual refresh failed: ${e.message}`));
  res.status(202).json({ started: true });
});

app.post('/api/preview', async (req, res) => {
  const target = req.body.target === 'radarr' ? 'radarr' : 'sonarr';
  const filters = sanitizeFilters(req.body.filters, target);
  const ctx = await createContext();
  const { items, seasonLabel } = await buildItems(target, filters, ctx);
  const excluded = req.body.listId ? store.getExclusionIds(Number(req.body.listId)) : new Set();
  for (const it of items) it.excluded = excluded.has(it.anilistId);
  res.json({ items, seasonLabel, warnings: [...ctx.warnings] });
});

app.post('/api/lists/:id/exclusions', (req, res) => {
  const list = listOr404(idParam(req));
  const anilistId = Number(req.body.anilistId);
  if (!Number.isInteger(anilistId)) throw bad('anilistId is required');
  store.addExclusion(list.id, anilistId, req.body.title);
  res.status(204).end();
});

app.delete('/api/lists/:id/exclusions/:anilistId', (req, res) => {
  store.removeExclusion(idParam(req), Number(req.params.anilistId));
  res.status(204).end();
});

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
  for (const kind of ['sonarr', 'radarr']) {
    if (b[`${kind}Url`] !== undefined) patch[`${kind}Url`] = String(b[`${kind}Url`]).trim().replace(/\/+$/, '');
    // Blank means "keep the saved key"; the explicit clear flag removes it.
    if (b[`${kind}ApiKey`]) patch[`${kind}ApiKey`] = String(b[`${kind}ApiKey`]).trim();
    if (b[`clear${kind[0].toUpperCase()}${kind.slice(1)}ApiKey`]) patch[`${kind}ApiKey`] = '';
  }
  for (const k of ['arrLookupFallback', 'triggerArrSync']) if (b[k] !== undefined) patch[k] = !!b[k];
  if (['english', 'romaji'].includes(b.titleLanguage)) patch.titleLanguage = b.titleLanguage;

  const before = store.getSettings().schedule;
  const saved = store.saveSettings(patch);
  if (saved.schedule !== before) schedule(saved.schedule);
  res.json(publicSettings());
});

app.post('/api/settings/test', async (req, res) => {
  const kind = req.body.kind;
  if (!['sonarr', 'radarr'].includes(kind)) throw bad('kind must be sonarr or radarr');
  const saved = store.getSettings();
  const client = arrClient(kind, {
    [`${kind}Url`]: req.body.url ?? saved[`${kind}Url`],
    [`${kind}ApiKey`]: req.body.apiKey || saved[`${kind}ApiKey`],
  });
  if (!client) throw bad('URL and API key are required');
  try {
    const st = await client.status();
    res.json({ ok: true, appName: st.appName || kind, version: st.version });
  } catch (e) {
    const cause = e.cause?.code || e.cause?.errors?.[0]?.code || e.cause?.message;
    res.json({ ok: false, error: cause ? `${e.message} (${cause})` : e.message });
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

app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: '1h' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) log(`Error: ${err.stack || err.message}`);
  res.status(status).json({ error: err.message || 'Internal error' });
});

// ---------- start ----------

app.listen(PORT, () => log(`Courarr ${VERSION} listening on :${PORT} (TZ ${TZ})`));
schedule(store.getSettings().schedule);

// Warm the mapping cache in the background so the first refresh is quick.
ensureMapping().catch((e) => log(`Initial mapping load failed: ${e.message}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    process.exit(0);
  });
}
