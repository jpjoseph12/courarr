import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TZ, VERSION, log } from './config.js';
import * as store from './db.js';
import { SEASONS, getMeta, resolveSeasonFilter, searchStaff, searchStudios } from './anilist.js';
import { arrClient } from './arr.js';
import {
  DEFAULT_FILTERS, SERIES_TYPE, SOURCES, buildItems, createContext, feedFor, isRunning, refresh, seriesTypeFor,
} from './builder.js';
import { ensureMapping, mappingInfo } from './mapping.js';
import {
  MOVIE_STATUSES, SORTS as TMDB_SORTS, getTmdbMeta, networkName, resolveDateFilter, searchTmdbEntity, tmdbClient,
} from './tmdb.js';
import { nextRun, schedule, validateCron } from './scheduler.js';
import { omdbClient, summariseOmdb } from './omdb.js';
import { NOTIFIER_TYPES, SECRET_FIELDS, send as sendNotification } from './notify.js';
import { maintainerrClient, syncMaintainerr } from './maintainerr.js';
import { randomUUID } from 'node:crypto';
import * as auth from './auth.js';

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
const SEASON_MODES = ['current', 'next', 'previous', 'specific', 'year', 'currentYear', 'range', 'lastYears', 'none'];
const DATE_MODES = ['any', 'thisYear', 'year', 'range', 'lastYears', 'lastDays', 'nextDays', 'airing'];

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
const cert = (v) => String(v || '').trim().slice(0, 12);

/** Year range shared by both list types: from <= to, both within sane bounds. */
function yearRange(src) {
  const from = clampInt(src.fromYear, 1900, 2100, year() - 10);
  const to = clampInt(src.toYear, 1900, 2100, year());
  return { fromYear: Math.min(from, to), toYear: Math.max(from, to) };
}

/** Filters every list kind shares: genre match, people/companies/studios, lengths, rating, retention. */
function commonFilters(f) {
  return {
    genreMatch: f.genreMatch === 'any' ? 'any' : 'all',
    people: keywordList(f.people),
    minRuntime: clampInt(f.minRuntime, 0, 1000, 0),
    maxRuntime: clampInt(f.maxRuntime, 0, 1000, 0),
    minEpisodes: clampInt(f.minEpisodes, 0, 10000, 0),
    maxEpisodes: clampInt(f.maxEpisodes, 0, 10000, 0),
    maxCertification: cert(f.maxCertification),
    keepDays: clampInt(f.keepDays, 0, 365, 0),
    minImdb: Math.min(Math.max(Math.round((Number(f.minImdb) || 0) * 10) / 10, 0), 10),
    minRt: clampInt(f.minRt, 0, 100, 0),
    minMetacritic: clampInt(f.minMetacritic, 0, 100, 0),
    keepUnscored: f.keepUnscored !== false,
    dripMax: clampInt(f.dripMax, 0, 500, 0),
    notify: f.notify !== false,
  };
}

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
  if (mode === 'range') Object.assign(season, yearRange(s));
  if (mode === 'lastYears') season.years = clampInt(s.years, 1, 50, 5);

  return {
    ...commonFilters(f),
    streaming: intList(f.streaming),
    studios: keywordList(f.studios),
    keepUnrated: f.keepUnrated !== false,
    ...(target === 'sonarr' ? { seriesType: f.seriesType === 'standard' ? 'standard' : 'anime' } : {}),
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
  if (mode === 'range') Object.assign(date, yearRange(df));
  if (mode === 'lastYears') date.years = clampInt(df.years, 1, 50, 5);
  const tv = target === 'sonarr';
  return {
    ...commonFilters(f),
    companies: keywordList(f.companies),
    keepUnrated: !!f.keepUnrated,
    ...(tv
      ? {
          seriesType: f.seriesType === 'daily' ? 'daily' : 'standard',
          minSeasons: clampInt(f.minSeasons, 0, 100, 0),
          maxSeasons: clampInt(f.maxSeasons, 0, 100, 0),
          upcomingEpisode: !!f.upcomingEpisode,
          sequels: 'include',
          movieStatuses: [],
        }
      : {
          movieStatuses: strList(f.movieStatuses, MOVIE_STATUSES),
          sequels: ['include', 'exclude', 'only'].includes(f.sequels) ? f.sequels : 'include',
        }),
    collection: ['trending', 'arrivals'].includes(f.collection) ? f.collection : 'discover',
    arrivalDays: clampInt(f.arrivalDays, 1, 90, 14),
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
    ...(tv ? {} : { minEpisodes: 0, maxEpisodes: 0 }),
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
    if (list.filters.collection === 'arrivals') return `New on your services · last ${list.filters.arrivalDays || 14} days`;
    const prefix = list.target === 'sonarr' && list.filters.people?.length ? 'Credits' : list.filters.collection === 'trending' ? 'Trending this week' : null;
    return prefix ? `${prefix}${label === 'Any time' ? '' : ` · ${label}`}` : label;
  }
  return resolveSeasonFilter(list.filters.season, settings.seasonRolloverDays).label;
}

const KEYED = ['sonarr', 'radarr', 'tmdb', 'omdb', 'maintainerr'];
const MASK = '••••••••';

function publicSettings() {
  const s = store.getSettings();
  const { authHash, ...out } = s;
  for (const k of KEYED) {
    out[`${k}ApiKey`] = '';
    out[`${k}ApiKeySet`] = !!s[`${k}ApiKey`];
  }
  // Webhook URLs and tokens are secrets: the browser only learns whether one is set.
  out.notifiers = (s.notifiers || []).map((n) => {
    const copy = { ...n };
    for (const f of SECRET_FIELDS) if (f in copy) copy[f] = copy[f] ? MASK : '';
    return copy;
  });
  return out;
}

const httpUrl = (v) => /^https?:\/\/[^\s]+$/i.test(v);

/** Validates notifier settings; a masked or blank secret keeps the saved value. */
function sanitizeNotifiers(list, saved = []) {
  const prev = new Map(saved.map((n) => [n.id, n]));
  if (!Array.isArray(list)) throw bad('notifiers must be a list');
  return list.slice(0, 20).map((n) => {
    const type = n?.type;
    if (!NOTIFIER_TYPES[type]) throw bad(`Unknown notification type "${type}"`);
    const old = prev.get(n.id) || {};
    const out = {
      id: /^[a-z0-9-]{4,40}$/i.test(n.id || '') ? n.id : randomUUID(),
      type,
      name: String(n.name || '').trim().slice(0, 60),
      enabled: n.enabled !== false,
    };
    for (const f of NOTIFIER_TYPES[type].fields) {
      let v = String(n[f] ?? '').trim();
      if (SECRET_FIELDS.includes(f) && (v === MASK || v === '')) v = old[f] || '';
      out[f] = v.slice(0, 500);
    }
    const label = NOTIFIER_TYPES[type].label;
    if (type === 'discord' && !/^https:\/\/(\w+\.)?discord(app)?\.com\/api\/webhooks\//.test(out.webhookUrl)) throw bad(`${label}: paste the channel's webhook URL`);
    if (type === 'telegram' && (!out.botToken || !out.chatId)) throw bad(`${label}: bot token and chat ID are required`);
    if (type === 'ntfy' && (!out.topic || (out.server && !httpUrl(out.server)))) throw bad(`${label}: a topic (and a valid server URL, if set) is required`);
    if (type === 'gotify' && (!httpUrl(out.server) || !out.token)) throw bad(`${label}: server URL and app token are required`);
    if (type === 'webhook' && !httpUrl(out.url)) throw bad(`${label}: a valid http(s) URL is required`);
    return out;
  });
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
  const s = store.getSettings();
  const base = s.feedBaseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/feed/${slug}${s.feedKeyRequired ? `?key=${s.feedKey}` : ''}`;
}

/** Points a list's linked Sonarr/Radarr import list at its current name and feed URL. */
async function syncArrList(req, list) {
  if (!list.arr_list_id) return;
  const client = arrClient(list.target, store.getSettings());
  try {
    const current = client && (await client.getImportList(list.arr_list_id));
    if (current) await client.upsertImportList(list.arr_list_id, { ...current, name: arrListName(list), url: feedUrl(req, list.slug) });
  } catch (e) {
    log(`Could not update ${list.target} import list: ${e.message}`);
  }
}

/** After the feed key or its requirement changes, every linked import list needs the new URL. */
async function syncAllArrLists(req) {
  for (const list of store.listLists()) await syncArrList(req, list);
}
const arrListName = (list) => `Courarr – ${list.name}`;

// ---------- app ----------

/** The Express app: API, feeds and the web UI. index.js starts it; tests import it directly. */
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, version: VERSION }));

// ---------- login ----------

const OPEN_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/logout']);
const sessionToken = (req) => auth.parseCookies(req.headers.cookie)[auth.COOKIE];

/** Who is calling: a logged-in browser session, or a script with the API key. */
function caller(req) {
  const token = sessionToken(req);
  if (token && auth.sessionValid(token)) return { via: 'session', token };
  const key = req.get('x-api-key') || req.query.apikey;
  if (key && auth.apiKeyValid(key)) return { via: 'apikey' };
  return null;
}

app.use('/api', (req, res, next) => {
  if (OPEN_API.has(req.originalUrl.split('?')[0])) return next();
  const who = caller(req);
  if (!who) {
    const configured = auth.isConfigured();
    return res.status(401).json({ error: configured ? 'Log in to continue' : 'Create an account first', code: configured ? 'login' : 'setup' });
  }
  // A browser session can only change things with the header Courarr's own UI sends: a
  // cross-site page can't add it without a CORS preflight, which this server never allows.
  if (who.via === 'session' && !['GET', 'HEAD'].includes(req.method) && req.get('x-courarr') !== '1') {
    return res.status(403).json({ error: 'Request blocked: missing X-Courarr header' });
  }
  req.caller = who;
  next();
});

app.get('/api/auth/status', (req, res) => {
  const s = store.getSettings();
  const who = caller(req);
  res.json({
    configured: !!s.authHash,
    authenticated: !!who,
    user: who ? s.authUser : null,
    setupComplete: !!s.setupComplete,
    version: VERSION,
  });
});

const startSession = (req, res, remember) => {
  const { token, maxAge } = auth.createSession(remember);
  res.set('Set-Cookie', auth.sessionCookie(req, token, maxAge));
};

app.post('/api/auth/setup', (req, res) => {
  if (auth.isConfigured()) throw new HttpError(409, 'An account already exists — log in instead');
  const { username, password } = req.body || {};
  const problem = auth.usernameProblem(username) || auth.passwordProblem(password);
  if (problem) throw bad(problem);
  auth.createAccount(username, password);
  auth.ensureKeys();
  log(`Account "${username.trim()}" created`);
  startSession(req, res, true);
  res.status(201).json({ ok: true, user: username.trim() });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress;
  if (auth.loginBlocked(ip)) throw new HttpError(429, 'Too many failed attempts — wait 10 minutes and try again');
  const { username, password, remember } = req.body || {};
  if (!auth.isConfigured()) throw new HttpError(409, 'No account yet — create one first');
  if (!auth.checkLogin(username || '', password || '')) {
    auth.recordFailure(ip);
    log(`Failed login for "${String(username || '').slice(0, 40)}" from ${ip}`);
    throw new HttpError(401, 'Wrong username or password');
  }
  auth.clearFailures(ip);
  startSession(req, res, !!remember);
  res.json({ ok: true, user: store.getSettings().authUser });
});

app.post('/api/auth/logout', (req, res) => {
  auth.endSession(sessionToken(req));
  res.set('Set-Cookie', auth.sessionCookie(req, '', 0));
  res.status(204).end();
});

app.put('/api/auth/account', (req, res) => {
  const { current, username, password } = req.body || {};
  const s = store.getSettings();
  if (!auth.verifyPassword(current || '', s.authHash)) throw bad('Your current password is wrong');
  const patch = {};
  if (username !== undefined && username.trim() !== s.authUser) {
    const problem = auth.usernameProblem(username);
    if (problem) throw bad(problem);
    patch.authUser = username.trim();
  }
  if (password) {
    const problem = auth.passwordProblem(password);
    if (problem) throw bad(problem);
    patch.authHash = auth.hashPassword(password);
  }
  store.saveSettings(patch);
  // Signing everyone else out is the point of changing a password.
  if (patch.authHash) auth.endOtherSessions(req.caller.token);
  res.json({ ok: true, user: store.getSettings().authUser });
});

app.post('/api/auth/keys/:which', async (req, res) => {
  const which = req.params.which;
  if (!['api', 'feed'].includes(which)) throw new HttpError(404, 'Unknown key');
  store.saveSettings({ [`${which}Key`]: auth.newKey() });
  if (which === 'feed' && store.getSettings().feedKeyRequired) await syncAllArrLists(req);
  res.json(publicSettings());
});

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

// Search boxes: TMDB keywords / people / companies, AniList studios / staff.
app.get('/api/search/:type', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const type = req.params.type;
  if (type === 'studio') return res.json(await searchStudios(q));
  if (type === 'staff') return res.json(await searchStaff(q));
  if (!['keyword', 'person', 'company'].includes(type)) throw new HttpError(404, 'Unknown search type');
  res.json(await searchTmdbEntity(tmdbOr400(), type, q));
});

app.get('/api/tmdb/network/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw bad('Network IDs are whole numbers');
  try {
    res.json({ id, name: await networkName(tmdbOr400(), id) });
  } catch {
    throw new HttpError(404, `TMDB has no network ${id}`);
  }
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
  const before = listOr404(id);
  const list = store.updateList(id, validateList(req.body, id));
  // A "new on my services" list compares against what it saw before; if its scope changed,
  // start tracking afresh or every title in the new scope would look like an arrival.
  const scope = (l) => {
    const { limit, keepDays, dripMax, notify, arrivalDays, sort, ...rest } = l.filters;
    return JSON.stringify([l.target, rest]);
  };
  if (list.filters.collection === 'arrivals' && scope(before) !== scope(list)) store.resetCatalogue(id);
  // Keep the linked Sonarr/Radarr import list's name and URL in step with renames.
  await syncArrList(req, list);
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
  const listId = Number(req.body.listId) || null;
  const { items, label } = await buildItems(source, target, filters, ctx, { listId, record: false });
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
    recommendedSeriesType: seriesTypeFor(list),
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
    cfg.seriesType = ['standard', 'anime', 'daily'].includes(b.seriesType) ? b.seriesType : seriesTypeFor(list);
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

app.put('/api/settings', async (req, res) => {
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
  for (const kind of KEYED) {
    const cap = kind[0].toUpperCase() + kind.slice(1);
    if (['sonarr', 'radarr', 'maintainerr'].includes(kind) && b[`${kind}Url`] !== undefined) {
      patch[`${kind}Url`] = String(b[`${kind}Url`]).trim().replace(/\/+$/, '');
    }
    // Blank means "keep the saved key"; the explicit clear flag removes it.
    if (b[`${kind}ApiKey`]) patch[`${kind}ApiKey`] = String(b[`${kind}ApiKey`]).trim();
    if (b[`clear${cap}ApiKey`]) patch[`${kind}ApiKey`] = '';
  }
  if (b.tmdbRegion !== undefined && /^[A-Z]{2}$/.test(String(b.tmdbRegion))) patch.tmdbRegion = b.tmdbRegion;
  for (const k of ['arrLookupFallback', 'triggerArrSync', 'notifyOnNew', 'notifyOnError', 'maintainerrStopNewSeasons']) {
    if (b[k] !== undefined) patch[k] = !!b[k];
  }
  if (b.defaultLanguages !== undefined) {
    patch.defaultLanguages = strList(b.defaultLanguages).map((c) => c.toLowerCase()).filter((c) => /^[a-z]{2}$/.test(c));
  }
  if (b.maintainerrCollections !== undefined) patch.maintainerrCollections = intList(b.maintainerrCollections);
  if (b.notifiers !== undefined) patch.notifiers = sanitizeNotifiers(b.notifiers, store.getSettings().notifiers);
  if (['english', 'romaji'].includes(b.titleLanguage)) patch.titleLanguage = b.titleLanguage;

  for (const k of ['setupComplete', 'feedKeyRequired']) if (b[k] !== undefined) patch[k] = !!b[k];
  const feedChanged =
    (patch.feedKeyRequired !== undefined && patch.feedKeyRequired !== store.getSettings().feedKeyRequired) ||
    (patch.feedBaseUrl !== undefined && patch.feedBaseUrl !== store.getSettings().feedBaseUrl);

  const before = store.getSettings().schedule;
  const saved = store.saveSettings(patch);
  if (saved.schedule !== before) schedule(saved.schedule);
  if (feedChanged) await syncAllArrLists(req);
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
  if (kind === 'omdb') {
    const client = omdbClient(req.body.apiKey || saved.omdbApiKey);
    if (!client) throw bad('API key is required');
    try {
      const sc = summariseOmdb(await client.get('tt0111161'));
      return res.json({ ok: true, appName: 'OMDb', version: `— The Shawshank Redemption: IMDb ${sc.imdb}, RT ${sc.rt}%` });
    } catch (e) {
      return res.json({ ok: false, error: causeOf(e) });
    }
  }
  if (kind === 'maintainerr') {
    const client = maintainerrClient({
      maintainerrUrl: req.body.url ?? saved.maintainerrUrl,
      maintainerrApiKey: req.body.apiKey || saved.maintainerrApiKey,
    });
    if (!client) throw bad('URL is required');
    try {
      const cols = await client.collections();
      return res.json({ ok: true, appName: 'Maintainerr', version: `— ${cols.length} collections`, collections: cols });
    } catch (e) {
      return res.json({ ok: false, error: causeOf(e) });
    }
  }
  if (!['sonarr', 'radarr'].includes(kind)) throw bad('kind must be sonarr, radarr, tmdb, omdb or maintainerr');
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

// ---------- Maintainerr ----------

app.get('/api/maintainerr/collections', async (req, res) => {
  const client = maintainerrClient(store.getSettings());
  if (!client) throw bad('Connect Maintainerr in Settings first');
  res.json(await client.collections());
});

app.post('/api/maintainerr/sync', async (_req, res) => {
  const settings = store.getSettings();
  const client = maintainerrClient(settings);
  if (!client) throw bad('Connect Maintainerr in Settings first');
  const synced = await syncMaintainerr(client, settings.maintainerrCollections);
  res.json(synced.map(({ collection, titles }) => ({ collection, titles })));
});

app.get('/api/ignored', (_req, res) => res.json(store.listIgnored()));

// ---------- notifications ----------

app.post('/api/notify/test', async (req, res) => {
  const [n] = sanitizeNotifiers([req.body], store.getSettings().notifiers);
  try {
    await sendNotification(n, { kind: 'test' });
    res.json({ ok: true });
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
  if (store.getSettings().feedKeyRequired && !auth.feedKeyValid(req.query.key || req.get('x-api-key'))) {
    return res.status(401).json({ error: 'This feed needs its key (?key=…) — copy the feed URL from Courarr again' });
  }
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

export default app;
