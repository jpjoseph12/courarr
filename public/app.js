// Courarr web UI — plain ES modules, no build step.

const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The server build this page was loaded from (see X-Courarr-Build on every response).
const PAGE_BUILD = document.querySelector('meta[name="courarr-build"]')?.content || '';
let reloading = false;

/** Courarr was updated (or restarted) since this page loaded: reload to get the new UI. */
function checkBuild(res) {
  const build = res.headers.get('x-courarr-build');
  if (!build || !PAGE_BUILD || build === PAGE_BUILD || reloading) return false;
  reloading = true;
  toast('Courarr was updated — reloading…');
  setTimeout(() => location.reload(), 800);
  return true;
}

async function api(path, opts = {}) {
  // X-Courarr: the server only accepts changes from a logged-in browser that sends it.
  const init = { ...opts, headers: { 'Content-Type': 'application/json', 'X-Courarr': '1', ...(opts.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  // A write from an out-of-date page may have been refused or misread: stop and reload instead.
  if (checkBuild(res) && (init.method || 'GET') !== 'GET') throw new Error('Courarr was updated — reloading the page');
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data?.code && !path.startsWith('/api/auth/')) {
    clearTimeout(pollTimer);
    if (data.code === 'setup') viewCreateAccount();
    else viewLogin('Your session ended — please log in again.');
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), isError ? 7000 : 3500);
}

const ICONS = {
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  hash: '<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>',
  ext: '<path d="M14 4h6v6M20 4 10 14M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24">${ICONS[n]}</svg>`;

function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtNext = (iso) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs HTTPS; Unraid UIs are usually plain HTTP on the LAN.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// ---------- vocabulary ----------

const ARR = { sonarr: 'Sonarr', radarr: 'Radarr' };
const SOURCE_NAMES = { anilist: 'Anime', tmdb: 'TV & movies' };
const SERIES_TYPES = { standard: 'Standard', anime: 'Anime', daily: 'Daily' };

const FORMAT_NAMES = { TV: 'TV', TV_SHORT: 'TV Short', ONA: 'ONA', OVA: 'OVA', MOVIE: 'Movie', SPECIAL: 'Special', MUSIC: 'Music' };
const STATUS_NAMES = { RELEASING: 'Airing', NOT_YET_RELEASED: 'Upcoming', FINISHED: 'Finished', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
const ANIME_SORTS = { POPULARITY_DESC: 'Popularity', SCORE_DESC: 'Score', TRENDING_DESC: 'Trending', FAVOURITES_DESC: 'Favourites', START_DATE_DESC: 'Newest' };
const ANIME_COUNTRIES = { JP: 'Japan', CN: 'China', KR: 'Korea', TW: 'Taiwan' };
const SEASON_MODES = {
  current: 'This season',
  next: 'Next season',
  previous: 'Last season',
  specific: 'A specific season',
  currentYear: 'This year',
  year: 'A specific year',
  range: 'A range of years',
  lastYears: 'In the last … years',
  none: 'Any time',
};
const DATE_MODES = {
  any: 'Any time',
  airing: 'Airing this week',
  lastDays: 'In the last … days',
  nextDays: 'In the next … days',
  thisYear: 'This year',
  year: 'A specific year',
  range: 'A range of years',
  lastYears: 'In the last … years',
};
const LANG_CHOICES = [
  ['en', 'English'], ['ko', 'Korean'], ['ja', 'Japanese'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['it', 'Italian'], ['hi', 'Hindi'], ['zh', 'Chinese'], ['pt', 'Portuguese'], ['sv', 'Swedish'], ['da', 'Danish'],
  ['no', 'Norwegian'], ['tr', 'Turkish'],
];
const NOTIFIER_TYPES = {
  discord: { label: 'Discord', fields: [['webhookUrl', 'Webhook URL', 'https://discord.com/api/webhooks/…', true]] },
  telegram: { label: 'Telegram', fields: [['botToken', 'Bot token', '123456:ABC…', true], ['chatId', 'Chat ID', '-1001234567890']] },
  ntfy: { label: 'ntfy', fields: [['server', 'Server', 'https://ntfy.sh'], ['topic', 'Topic', 'courarr'], ['token', 'Access token (optional)', '', true]] },
  gotify: { label: 'Gotify', fields: [['server', 'Server URL', 'http://192.168.1.10:8070'], ['token', 'App token', '', true]] },
  webhook: { label: 'Webhook (JSON)', fields: [['url', 'URL', 'http://…']] },
};
const SECRET_MASK = '••••••••';
const REGIONS = ['US', 'GB', 'CA', 'AU', 'IE', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI', 'BR', 'MX', 'IN', 'JP', 'KR'];

const MATCH = {
  mapping: ['Mapped', 'ID from the anime mapping database'],
  prequel: ['Via prequel', 'Sequel — uses the earlier season’s series'],
  imdb: ['Via IMDb', 'Found in Radarr by IMDb ID'],
  lookup: ['Title match', 'Found by exact title search in Sonarr/Radarr'],
  override: ['Manual', 'ID you set by hand'],
  tmdb: ['TMDB', 'TMDB title (with its TVDB id for Sonarr)'],
  sonarr: ['Via Sonarr', 'TVDB id found by Sonarr from the TMDB id'],
  tmdbOnly: ['No TVDB yet', 'Neither TMDB nor Sonarr knows its TVDB id yet — left out until one appears'],
};
const FALLBACK_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];

const TEMPLATES = [
  {
    name: 'Popular anime this season',
    source: 'anilist',
    target: 'sonarr',
    desc: 'Top 50 TV & ONA anime airing this season.',
    filters: { season: { mode: 'current' }, formats: ['TV', 'TV_SHORT', 'ONA'], countries: ['JP'], limit: 50 },
  },
  {
    name: 'New anime next season',
    source: 'anilist',
    target: 'sonarr',
    desc: 'Upcoming season, first seasons only — no sequels.',
    filters: { season: { mode: 'next' }, formats: ['TV', 'ONA'], countries: ['JP'], sequels: 'exclude', limit: 30 },
  },
  {
    name: 'Anime movies this year',
    source: 'anilist',
    target: 'radarr',
    desc: 'Popular anime films released this year.',
    filters: { season: { mode: 'currentYear' }, formats: ['MOVIE'], countries: ['JP'], limit: 25 },
  },
  {
    name: 'Trending TV',
    source: 'tmdb',
    target: 'sonarr',
    desc: 'What everyone is watching this week. No anime.',
    filters: { collection: 'trending', minVotes: 20, limit: 30 },
  },
  {
    name: 'New series premieres',
    source: 'tmdb',
    target: 'sonarr',
    desc: 'Scripted shows and miniseries that premiered in the last 30 days.',
    filters: { date: { mode: 'lastDays', days: 30 }, tvTypes: [4, 2], minVotes: 10, limit: 30 },
  },
  {
    name: 'New movies on digital',
    source: 'tmdb',
    target: 'radarr',
    desc: 'Out on streaming/rental in the last 60 days, rated 6.5+.',
    filters: { date: { mode: 'lastDays', days: 60 }, releaseType: 'digital', minRating: 6.5, minVotes: 100, limit: 40 },
  },
  {
    name: 'New on my streaming services',
    source: 'tmdb',
    target: 'sonarr',
    desc: 'Series that just arrived on the services you pick — in your languages.',
    filters: { collection: 'arrivals', arrivalDays: 14, minVotes: 20, limit: 30 },
  },
];

// ---------- global state ----------

const state = { settings: null, meta: null, status: null, tmdbMeta: {} };

async function loadSettings() {
  state.settings = await api('/api/settings');
}

async function ensureMeta() {
  if (state.meta) return state.meta;
  state.meta = await api('/api/meta');
  if (!state.meta.genres.length) state.meta.genres = FALLBACK_GENRES;
  return state.meta;
}

async function loadTmdbMeta(kind, region) {
  const key = `${kind}:${region}`;
  if (!state.tmdbMeta[key]) state.tmdbMeta[key] = await api(`/api/tmdb/meta?kind=${kind}&region=${region}`);
  return state.tmdbMeta[key];
}

const feedUrl = (slug) =>
  `${state.settings?.feedBaseUrl || location.origin}/feed/${slug}${state.settings?.feedKeyRequired ? `?key=${state.settings.feedKey}` : ''}`;
const arrConnected = (target) => !!(state.settings?.[`${target}Url`] && state.settings?.[`${target}ApiKeySet`]);
const tmdbKind = (target) => (target === 'sonarr' ? 'tv' : 'movie');

// ---------- status bar & polling ----------

const statusEl = document.getElementById('status');
const refreshAllBtn = document.getElementById('refresh-all');
let pollTimer = null;
let wasRunning = false;

function renderStatus() {
  const s = state.status;
  if (!s) return;
  let dot = 'dot';
  let text;
  if (s.running) {
    dot += ' run';
    text = 'Refreshing lists…';
  } else {
    if (s.lastRun) dot += s.lastRun.status === 'ok' ? ' ok' : s.lastRun.status === 'error' ? ' err' : '';
    text = s.nextRun ? `Next refresh ${fmtNext(s.nextRun)}` : 'Scheduled refresh off';
  }
  statusEl.innerHTML = `<span class="${dot}"></span><span>${esc(text)}</span>`;
  statusEl.title = `Anime mapping: ${s.mapping.entries.toLocaleString()} entries, updated ${ago(s.mapping.updatedAt)}\nTimezone: ${s.timezone}`;
  refreshAllBtn.disabled = s.running;
  refreshAllBtn.classList.toggle('loading', s.running);
}

async function pollStatus() {
  clearTimeout(pollTimer);
  try {
    state.status = await api('/api/status');
    renderStatus();
    if (wasRunning && !state.status.running) {
      const r = state.status.lastRun;
      toast(r?.status === 'ok' ? 'Refresh finished' : `Refresh finished with problems (${r?.status})`, r?.status !== 'ok');
      if (/^#\/?$|^#\/activity|^$/.test(location.hash)) route();
    }
    wasRunning = state.status.running;
  } catch {
    statusEl.innerHTML = '<span class="dot err"></span><span>Server unreachable</span>';
  }
  pollTimer = setTimeout(pollStatus, state.status?.running ? 2500 : 60_000);
}

refreshAllBtn.addEventListener('click', async () => {
  try {
    await api('/api/refresh', { method: 'POST' });
    toast('Refreshing all enabled lists…');
    wasRunning = true;
    setTimeout(pollStatus, 800);
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------- router ----------

let renderToken = 0;
const routes = [
  [/^#?\/?$/, () => viewLists()],
  [/^#\/lists\/new(?:\?(.*))?$/, (m, t) => viewEditor(null, new URLSearchParams(m[1] || ''), t)],
  [/^#\/lists\/(\d+)(?:\?(.*))?$/, (m, t) => viewEditor(Number(m[1]), new URLSearchParams(m[2] || ''), t)],
  [/^#\/settings$/, () => viewSettings()],
  [/^#\/setup(?:\/(\w+))?$/, (m) => viewSetup(m[1] || 'arr')],
  [/^#\/activity$/, () => viewActivity()],
];

async function route() {
  const hash = location.hash || '#/';
  const section = hash.startsWith('#/settings') ? 'settings' : hash.startsWith('#/activity') ? 'activity' : 'lists';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const token = ++renderToken;
  view.onclick = null;
  bare(false);
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    try {
      await fn(m, token);
    } catch (e) {
      if (token === renderToken) view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
    }
    return;
  }
  view.innerHTML = '<div class="empty"><h2>Page not found</h2><p><a href="#/">Back to lists</a></p></div>';
}
window.addEventListener('hashchange', route);

const loadingBlock = (msg) => `<div class="loading-block"><div class="spinner"></div><div>${esc(msg)}</div></div>`;

// ---------- lists view ----------

function describe(l) {
  const f = l.filters;
  const parts = [l.label];
  const who = (f.people?.length || 0) + (f.studios?.length || 0) + (f.companies?.length || 0);
  if (l.target === 'sonarr' && f.seriesType && f.seriesType !== (l.source === 'tmdb' ? 'standard' : 'anime')) {
    parts.push(`${SERIES_TYPES[f.seriesType]} series`);
  }
  if (who) parts.push(`${who} ${who > 1 ? 'people/studios' : 'person/studio'}`);
  if (f.maxCertification) parts.push(`≤ ${f.maxCertification}`);
  if (f.minRuntime > 0 || f.maxRuntime > 0) parts.push(`${f.minRuntime || 0}–${f.maxRuntime || '∞'} min`);
  if (f.maxSeasons > 0) parts.push(`≤ ${f.maxSeasons} seasons`);
  if (f.keepDays > 0) parts.push(`kept ${f.keepDays}d`);
  if (f.dripMax > 0) parts.push(`${f.dripMax} new per refresh`);
  const sc = [f.minImdb > 0 && `IMDb ≥ ${f.minImdb}`, f.minRt > 0 && `RT ≥ ${f.minRt}%`, f.minMetacritic > 0 && `MC ≥ ${f.minMetacritic}`].filter(Boolean);
  if (sc.length) parts.push(sc.join(', '));
  // "Leaves out …" for every picker that has a left-out list.
  const out = [
    [f.studiosExclude, 'studio'],
    [f.peopleExclude, 'person', 'people'],
    [f.companiesExclude, 'company', 'companies'],
    [f.streamingExclude, 'streaming site'],
    [f.providersExclude, 'streaming service'],
    [f.networksExclude, 'network'],
  ]
    .filter(([a]) => a?.length)
    .map(([a, one, many]) => `${a.length} ${a.length > 1 ? many || `${one}s` : one}`);
  if (out.length) parts.push(`leaves out ${out.join(', ')}`);
  if (l.source === 'tmdb') {
    const n = f.genresInclude.length + f.genresExclude.length + f.keywordsInclude.length + f.keywordsExclude.length;
    if (f.providers.length) parts.push(`${f.providers.length} streaming service${f.providers.length > 1 ? 's' : ''}`);
    if (f.networks.length) parts.push(`${f.networks.length} network${f.networks.length > 1 ? 's' : ''}`);
    if (n) parts.push(`${n} genre/keyword filter${n > 1 ? 's' : ''}`);
    if (f.excludeAnime) parts.push('no anime');
    parts.push(`top ${f.limit}`);
  } else {
    parts.push(f.formats.length ? f.formats.map((x) => FORMAT_NAMES[x] || x).join(', ') : 'All formats');
    if (f.sequels === 'exclude') parts.push('no sequels');
    if (f.sequels === 'only') parts.push('sequels only');
    if (f.streaming?.length) parts.push(`${f.streaming.length} streaming site${f.streaming.length > 1 ? 's' : ''}`);
    const n = f.genresInclude.length + f.genresExclude.length + f.tagsInclude.length + f.tagsExclude.length;
    if (n) parts.push(`${n} genre/tag filter${n > 1 ? 's' : ''}`);
    parts.push(`top ${f.limit} by ${ANIME_SORTS[f.sort].toLowerCase()}`);
  }
  return parts.join(' · ');
}

function templatesHtml() {
  return `<div class="templates">
    ${TEMPLATES.map(
      (t, i) => `<div class="template" data-template="${i}" role="button" tabindex="0">
        <span class="row" style="flex:none;gap:6px">
          <span class="pill ${t.source === 'anilist' ? 'anime' : 'normal'}" style="flex:none">${SOURCE_NAMES[t.source]}</span>
          <span class="pill ${t.target}" style="flex:none">${t.target}</span>
        </span>
        <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`,
    ).join('')}
  </div>`;
}

async function viewLists() {
  const [lists] = await Promise.all([api('/api/lists'), state.settings ? null : loadSettings()]);
  if (!state.status) state.status = await api('/api/status');
  const st = state.status;

  const head = `
    <div class="page-head">
      <div>
        <h1>Lists</h1>
        <p>Anime season: <b>${esc(st.currentSeason)}</b> · next up: ${esc(st.nextSeason)}</p>
      </div>
      <div class="page-actions">
        <a class="btn btn-primary" href="#/lists/new">${icon('plus')}New list</a>
      </div>
    </div>`;

  const finish = state.settings?.setupComplete
    ? ''
    : '<div class="notice info">Setup isn’t finished — <a href="#/setup/arr">connect Sonarr, Radarr and TMDB</a> to unlock one-click adding and TV & movie lists.</div>';
  if (!lists.length) {
    view.innerHTML = `${head}${finish}
      <div class="empty">
        <h2>No lists yet</h2>
        <p>Each list is a saved search — anime from AniList, or regular TV & movies from TMDB.<br>
        Courarr turns the results into a feed that Sonarr or Radarr imports. Start from a template or build your own.</p>
        ${templatesHtml()}
      </div>`;
  } else {
    view.innerHTML = `${head}${finish}<div class="cards">${lists.map(listCard).join('')}</div>`;
  }

  view.onclick = async (e) => {
    const t = e.target.closest('[data-template],[data-copy],[data-refresh]');
    if (!t) return;
    if (t.dataset.template) location.hash = `#/lists/new?template=${t.dataset.template}`;
    if (t.dataset.copy) copyText(t.dataset.copy);
    if (t.dataset.refresh) {
      t.disabled = true;
      t.classList.add('loading');
      try {
        const r = await api(`/api/lists/${t.dataset.refresh}/refresh`, { method: 'POST' });
        const l = r.summary.lists[0];
        if (l?.error) toast(`Refresh failed: ${l.error}`, true);
        else toast(`${l.name}: ${l.matched}/${l.total} matched`);
        viewLists();
        pollStatus();
      } catch (err) {
        toast(err.message, true);
        t.disabled = false;
        t.classList.remove('loading');
      }
    }
  };
}

function listCard(l) {
  const url = feedUrl(l.slug);
  const connected = arrConnected(l.target);
  return `
    <article class="card${l.enabled ? '' : ' disabled'}">
      <div class="card-top">
        <div class="card-title">
          <span class="pill ${l.source === 'anilist' ? 'anime' : 'normal'}">${SOURCE_NAMES[l.source]}</span>
          <span class="pill ${l.target}">${l.target}</span>
          ${l.enabled ? '' : '<span class="pill off">Paused</span>'}
        </div>
        <a class="card-name" href="#/lists/${l.id}">${esc(l.name)}</a>
        <div class="card-meta">${esc(describe(l))}</div>
      </div>
      ${l.last_error ? `<div class="card-error">Last refresh failed: ${esc(l.last_error)}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${l.feedCount}</b><span>in feed</span></div>
        <div class="stat"><b>${l.matchedCount}<span class="faint" style="font-size:15px">/${l.item_count}</span></b><span>matched</span></div>
        <div class="stat" title="${connected ? '' : `Connect ${ARR[l.target]} in Settings to see this`}">
          <b>${connected ? l.inLibraryCount : '—'}</b><span>in ${ARR[l.target]}</span></div>
      </div>
      <div class="feed">
        <code title="${esc(url)}">${esc(url)}</code>
        <button class="btn btn-ghost btn-sm btn-icon" data-copy="${esc(url)}" title="Copy feed URL" type="button">${icon('copy')}</button>
      </div>
      <div class="card-foot">
        <span class="when">${l.last_refresh ? `Refreshed ${ago(l.last_refresh)}` : 'Not refreshed yet'}${
          l.arr_list_id ? ` · <span class="linked">${icon('link')}In ${ARR[l.target]}</span>` : ''
        }</span>
        <button class="btn btn-sm" data-refresh="${l.id}" type="button">${icon('refresh')}Refresh</button>
        <a class="btn btn-sm btn-ghost" href="#/lists/${l.id}">${icon('edit')}Edit</a>
      </div>
    </article>`;
}

// ---------- editor ----------

/** New TV & movie lists start with the original languages chosen in Settings. */
function withDefaultLanguages(source, filters) {
  if (source === 'tmdb' && !filters.languages?.length) filters.languages = [...(state.settings?.defaultLanguages || [])];
  return filters;
}

async function viewEditor(id, params, token) {
  view.innerHTML = loadingBlock('Loading…');
  const [meta] = await Promise.all([ensureMeta(), state.settings ? null : loadSettings()]);
  let saved = null;
  if (id) saved = await api(`/api/lists/${id}`);
  if (token !== renderToken) return;

  let draft;
  if (saved) {
    draft = {
      name: saved.name,
      slug: saved.slug,
      source: saved.source,
      target: saved.target,
      filters: structuredClone(saved.filters),
      enabled: saved.enabled,
    };
  } else {
    // Number(null) is 0, so only look a template up when one was actually asked for.
    const tpl = params.has('template') ? TEMPLATES[Number(params.get('template'))] : null;
    const source = tpl?.source || (params.get('source') === 'tmdb' ? 'tmdb' : 'anilist');
    const target = tpl?.target || (params.get('target') === 'radarr' ? 'radarr' : 'sonarr');
    draft = {
      name: tpl?.name || '',
      slug: '',
      source,
      target,
      filters: withDefaultLanguages(source, { ...structuredClone(meta.defaults[source][target]), ...structuredClone(tpl?.filters || {}) }),
      enabled: true,
    };
  }

  const ed = {
    id,
    saved,
    draft,
    meta,
    tmeta: null,
    tmetaError: null,
    entResults: {},
    networkNames: {},
    open: new Set(['when', 'what']),
    modes: {}, // per field: does clicking a chip include it or leave it out?
    items: saved?.items?.length ? saved.items : null,
    label: saved?.label || null,
    mode: saved?.items?.length ? 'saved' : 'none',
    warnings: [],
    tab: 'all',
    arr: null,
  };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="btn btn-ghost btn-sm" href="#/" style="margin-left:-10px;margin-bottom:6px">${icon('back')}Lists</a>
        <h1>${saved ? esc(saved.name) : 'New list'}</h1>
      </div>
      ${
        saved
          ? ''
          : `<select class="select" id="tpl-pick" style="width:auto;min-width:230px">
              <option value="">Start from a template…</option>
              ${TEMPLATES.map((t, i) => `<option value="${i}">${esc(SOURCE_NAMES[t.source])} · ${esc(t.name)}</option>`).join('')}
            </select>`
      }
    </div>
    ${saved ? '<div id="arr-bar" class="arr-bar"></div>' : ''}
    <div class="editor">
      <form class="form" id="ed-form" autocomplete="off"></form>
      <section id="ed-results"></section>
    </div>
    <datalist id="tag-list">${meta.tags.map((t) => `<option value="${esc(t.name)}">${esc(t.category)}</option>`).join('')}</datalist>`;

  const form = document.getElementById('ed-form');
  const results = document.getElementById('ed-results');
  const arrBar = document.getElementById('arr-bar');

  view.querySelector('#tpl-pick')?.addEventListener('change', (e) => {
    if (e.target.value !== '') location.hash = `#/lists/new?template=${e.target.value}`;
  });

  const renderForm = () => {
    form.innerHTML = ed.draft.source === 'tmdb' ? tmdbFormHtml(ed) : animeFormHtml(ed);
  };
  const renderRes = () => {
    results.innerHTML = resultsHtml(ed);
  };

  async function loadTmeta() {
    // Anime lists only use TMDB for age ratings, so skip it quietly when there's no key.
    if (ed.draft.source !== 'tmdb' && !state.settings.tmdbApiKeySet) {
      ed.tmeta = null;
      return;
    }
    const region = ed.draft.filters.region || state.settings.tmdbRegion || 'US';
    ed.tmetaError = null;
    try {
      ed.tmeta = await loadTmdbMeta(tmdbKind(ed.draft.target), region);
    } catch (e) {
      ed.tmeta = null;
      ed.tmetaError = e.message;
    }
  }

  // Names for network ids that aren't in the curated list.
  async function resolveNetworkNames() {
    const known = new Set((ed.tmeta?.networks || []).map((x) => x.id));
    const fl = ed.draft.filters;
    const todo = [...(fl.networks || []), ...(fl.networksExclude || [])].filter((id) => !known.has(id) && !ed.networkNames[id]);
    if (!todo.length) return;
    await Promise.all(
      todo.map((id) =>
        api(`/api/tmdb/network/${id}`).then((r) => (ed.networkNames[id] = r.name)).catch(() => {}),
      ),
    );
    if (token === renderToken) renderForm();
  }

  // Keep the active-filter badges on section headers current without re-rendering the form.
  function updateCounts() {
    const counts = sectionCounts(ed.draft);
    form.querySelectorAll('details.sec').forEach((el) => {
      const c = counts[el.dataset.sec] || 0;
      let badge = el.querySelector('summary .sec-count');
      if (!c) return badge?.remove();
      if (!badge) {
        badge = Object.assign(document.createElement('span'), { className: 'sec-count' });
        el.querySelector('summary').append(badge);
      }
      badge.textContent = c;
    });
  }

  await loadTmeta();
  if (token !== renderToken) return;
  renderForm();
  resolveNetworkNames();
  renderRes();
  if (saved) renderArrBar();

  // --- form events ---

  const setPath = (path, value) => {
    const keys = path.split('.');
    let o = ed.draft;
    while (keys.length > 1) o = o[keys.shift()];
    o[keys[0]] = value;
  };

  form.addEventListener('input', async (e) => {
    const t = e.target;
    if (t.dataset.entType) return searchEntity(t);
    const f = t.dataset.f;
    if (!f) return;
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.type === 'number') v = t.value === '' ? 0 : Number(t.value);
    setPath(f, v);
    const fl = ed.draft.filters;
    if (f === 'filters.season.mode') {
      if (v === 'specific' && !fl.season.season) {
        fl.season.season = 'WINTER';
        fl.season.year = new Date().getFullYear();
      }
      if (v === 'year' && !fl.season.year) fl.season.year = new Date().getFullYear();
      renderForm();
    }
    if (f === 'filters.date.mode') {
      if (v === 'year' && !fl.date.year) fl.date.year = new Date().getFullYear();
      if ((v === 'lastDays' || v === 'nextDays') && !fl.date.days) fl.date.days = 30;
      renderForm();
    }
    for (const w of ['season', 'date']) {
      if (f !== `filters.${w}.mode`) continue;
      const o = fl[w];
      if (v === 'range' && !o.fromYear) Object.assign(o, { fromYear: new Date().getFullYear() - 10, toYear: new Date().getFullYear() });
      if (v === 'lastYears' && !o.years) o.years = 5;
      renderForm();
    }
    if (f === 'filters.maxCertification') renderForm();
    else updateCounts();
    if (/^filters\.min(Imdb|Rt|Metacritic|Score|Rating)$/.test(f)) {
      const keep = form.querySelector('#keep-unscored');
      if (keep) keep.hidden = !scoreMinimums(fl);
    }
    if (f === 'filters.region') {
      fl.providers = [];
      await loadTmeta();
      renderForm();
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('button,[data-chip],[data-pair]');
    if (!b) return;
    const f = ed.draft.filters;
    if ((b.dataset.target && b.dataset.target !== ed.draft.target) || (b.dataset.source && b.dataset.source !== ed.draft.source)) {
      if (b.dataset.target) ed.draft.target = b.dataset.target;
      if (b.dataset.source) ed.draft.source = b.dataset.source;
      ed.draft.filters = withDefaultLanguages(ed.draft.source, structuredClone(meta.defaults[ed.draft.source][ed.draft.target]));
      ed.items = null;
      ed.mode = 'none';
      await loadTmeta();
      renderForm();
      renderRes();
      resolveNetworkNames();
      return;
    }
    if (b.dataset.chip) {
      const arr = f[b.dataset.chip];
      const v = b.dataset.num ? Number(b.dataset.v) : b.dataset.v;
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(v);
      b.classList.toggle('on', i < 0);
      updateCounts();
      return;
    }
    if (b.dataset.modeFor) {
      ed.modes[b.dataset.modeFor] = b.dataset.mode;
      b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      return;
    }
    if (b.dataset.pair) {
      // Clicking adds the value to the list the field's switch points at (moving it out of
      // the other one), or clears it if it's already there.
      const inc = b.dataset.pair;
      const exc = PAIRS[inc];
      const v = b.dataset.num ? Number(b.dataset.v) : b.dataset.v;
      const [mine, other] = ed.modes[inc] === 'exclude' ? [exc, inc] : [inc, exc];
      f[mine] ||= [];
      f[other] ||= [];
      const i = f[mine].indexOf(v);
      if (i >= 0) f[mine].splice(i, 1);
      else {
        f[mine].push(v);
        f[other] = f[other].filter((x) => x !== v);
      }
      b.classList.toggle('on', f[inc].includes(v));
      b.classList.toggle('not', f[exc].includes(v));
      updateCounts();
      return;
    }
    if (b.dataset.decade) {
      const y = Number(b.dataset.decade);
      setPath(`${b.dataset.path}.fromYear`, y);
      setPath(`${b.dataset.path}.toYear`, y + 9);
      renderForm();
      return;
    }
    if (b.dataset.seg) {
      // Show types differ between Standard and Daily lists, so start the picks afresh.
      if (b.dataset.seg === 'filters.seriesType' && f.tvTypes) f.tvTypes = [];
      setPath(b.dataset.seg, b.dataset.v);
      if (b.dataset.rerender) renderForm();
      else {
        b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        updateCounts();
      }
      return;
    }
    if (b.dataset.tagAdd) return addTag(b.dataset.tagAdd);
    if (b.dataset.entAdd) return addEntity(b.dataset.entAdd, form.querySelector(`#${b.dataset.entInput}`));
    if (b.dataset.remove) {
      const key = b.dataset.remove;
      f[key] = f[key].filter((t) => String(t.id ?? t) !== b.dataset.v);
      renderForm();
      return;
    }
    if (b.id === 'net-add') {
      const input = form.querySelector('#net-input');
      const id = Number(input.value);
      if (!Number.isInteger(id) || id <= 0) return toast('Network IDs are whole numbers (from the TMDB network page URL)', true);
      try {
        ed.networkNames[id] = (await api(`/api/tmdb/network/${id}`)).name;
      } catch (err) {
        return toast(err.message, true);
      }
      const [inc, exc] = pairKeys('networks');
      const key = ed.modes.networks === 'exclude' ? exc : inc;
      f[inc] = (f[inc] || []).filter((x) => x !== id);
      f[exc] = (f[exc] || []).filter((x) => x !== id);
      f[key].push(id);
      toast(`${key === exc ? 'Leaving out' : 'Added'} ${ed.networkNames[id]}`);
      renderForm();
      return;
    }
    if (b.id === 'ed-preview') runPreview();
    if (b.id === 'ed-delete') deleteList();
  });

  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'tag-input') {
      e.preventDefault();
      addTag('tagsInclude');
    }
    if (e.target.dataset.entType) {
      e.preventDefault();
      form.querySelector(`[data-ent-input="${e.target.id}"]`)?.click();
    }
    if (e.target.id === 'net-input') {
      e.preventDefault();
      form.querySelector('#net-add').click();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  // 'toggle' doesn't bubble; capture it to remember which sections are open across re-renders.
  form.addEventListener(
    'toggle',
    (e) => {
      const sec = e.target.dataset?.sec;
      if (!sec) return;
      if (e.target.open) ed.open.add(sec);
      else ed.open.delete(sec);
    },
    true,
  );

  function addTag(key) {
    const input = form.querySelector('#tag-input');
    const val = input.value.trim();
    if (!val) return;
    const known = meta.tags.find((t) => t.name.toLowerCase() === val.toLowerCase());
    if (meta.tags.length && !known) return toast(`"${val}" isn't an AniList tag`, true);
    const name = known?.name || val;
    const f = ed.draft.filters;
    f.tagsInclude = f.tagsInclude.filter((t) => t !== name);
    f.tagsExclude = f.tagsExclude.filter((t) => t !== name);
    f[key].push(name);
    renderForm();
    form.querySelector('#tag-input')?.focus();
  }

  const searchEntity = debounce(async (input) => {
    const q = input.value.trim();
    if (q.length < 2) return;
    try {
      const results = await api(`/api/search/${input.dataset.entType}?q=${encodeURIComponent(q)}`);
      ed.entResults[input.id] = results;
      const list = document.getElementById(input.getAttribute('list'));
      if (list) list.innerHTML = results.map((k) => `<option value="${esc(k.name)}"></option>`).join('');
    } catch {
      /* search is best-effort */
    }
  }, 250);

  /** Adds the {id,name} matching the search box text to filters[key] (keywords, people, studios…). */
  async function addEntity(key, input) {
    const val = input.value.trim().toLowerCase();
    if (!val) return;
    const find = () => (ed.entResults[input.id] || []).find((k) => k.name.toLowerCase() === val);
    let hit = find();
    if (!hit) {
      try {
        ed.entResults[input.id] = await api(`/api/search/${input.dataset.entType}?q=${encodeURIComponent(val)}`);
        hit = find() || ed.entResults[input.id][0];
      } catch (err) {
        return toast(err.message, true);
      }
    }
    if (!hit) return toast(`Nothing matches "${input.value.trim()}"`, true);
    const f = ed.draft.filters;
    // Included or left out, not both.
    for (const k of pairKeys(key)) f[k] = (f[k] || []).filter((x) => x.id !== hit.id);
    f[key].push(hit);
    renderForm();
    form.querySelector(`#${input.id}`)?.focus();
  }

  const setBusy = (busy, label) => {
    form.querySelectorAll('.form-foot button').forEach((b) => (b.disabled = busy));
    if (busy) results.innerHTML = loadingBlock(label);
  };

  async function runPreview() {
    setBusy(true, ed.draft.source === 'tmdb' ? 'Searching TMDB…' : 'Searching AniList and matching IDs…');
    try {
      const r = await api('/api/preview', {
        method: 'POST',
        body: { source: ed.draft.source, target: ed.draft.target, filters: ed.draft.filters, listId: ed.id },
      });
      if (token !== renderToken) return;
      Object.assign(ed, { items: r.items, label: r.label, warnings: r.warnings, mode: 'preview' });
    } catch (e) {
      toast(e.message, true);
    }
    setBusy(false);
    renderRes();
  }

  async function save() {
    if (!ed.draft.name.trim()) {
      toast('Give the list a name first', true);
      form.querySelector('[data-f="name"]').focus();
      return;
    }
    setBusy(true, 'Saving and refreshing the feed…');
    try {
      const body = { ...ed.draft, slug: ed.draft.slug || undefined };
      const list = ed.id
        ? await api(`/api/lists/${ed.id}`, { method: 'PUT', body })
        : await api('/api/lists', { method: 'POST', body });
      const r = await api(`/api/lists/${list.id}/refresh`, { method: 'POST' });
      const l = r.summary.lists[0];
      if (l?.error) toast(`Saved, but the refresh failed: ${l.error}`, true);
      else toast(`Saved — ${l.matched}/${l.total} titles in the feed`);
      pollStatus();
      if (ed.id) route();
      // New list: offer to add it to Sonarr/Radarr straight away.
      else location.hash = `#/lists/${list.id}${arrConnected(list.target) ? '?connect=1' : ''}`;
    } catch (e) {
      toast(e.message, true);
      setBusy(false);
      renderRes();
    }
  }

  async function deleteList() {
    const linked = ed.saved.arr_list_id ? ` The “Courarr – ${ed.saved.name}” import list in ${ARR[ed.saved.target]} is removed too.` : '';
    if (!confirm(`Delete "${ed.saved.name}"? Its feed URL will stop working.${linked}`)) return;
    try {
      await api(`/api/lists/${ed.id}`, { method: 'DELETE' });
      toast('List deleted');
      location.hash = '#/';
    } catch (e) {
      toast(e.message, true);
    }
  }

  // --- Sonarr / Radarr link ---

  async function renderArrBar() {
    const target = ed.saved.target;
    const name = ARR[target];
    try {
      ed.arr = await api(`/api/lists/${ed.id}/arr`);
    } catch (e) {
      arrBar.innerHTML = `<span class="muted">Couldn’t check ${name}: ${esc(e.message)}</span>`;
      return;
    }
    const a = ed.arr;
    const il = a.importList;
    if (!a.connected) {
      arrBar.innerHTML = `
        <span class="pill ${target}">${target}</span>
        <span class="muted">Add this feed in ${name} → Settings → Import Lists → ${target === 'sonarr' ? 'Custom List' : 'Custom Lists'}${
          target === 'sonarr' ? ` with <b>Series Type: ${SERIES_TYPES[a.recommendedSeriesType]}</b>` : ''
        }, or <a href="#/settings">connect ${name}</a> to do it from here.</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" type="button" data-copy="${esc(a.feedUrl)}">${icon('copy')}Copy feed URL</button>`;
    } else if (il) {
      const bits = [il.rootFolderPath];
      if (target === 'sonarr') bits.unshift(`Series type: <b>${SERIES_TYPES[il.seriesType] || il.seriesType}</b>`);
      arrBar.innerHTML = `
        <span class="pill ${target}">${target}</span>
        <span>${icon('link')} Added as <b>${esc(il.name)}</b> · ${bits.map((x) => (x.startsWith('Series') ? x : esc(x))).join(' · ')}</span>
        ${
          target === 'sonarr' && il.seriesType !== a.recommendedSeriesType
            ? `<span class="warn-text">${SOURCE_NAMES[ed.saved.source]} lists usually use ${SERIES_TYPES[a.recommendedSeriesType]}</span>`
            : ''
        }
        <span class="spacer"></span>
        <button class="btn btn-sm" type="button" data-arr="edit">${icon('edit')}Edit</button>`;
    } else {
      arrBar.innerHTML = `
        <span class="pill ${target}">${target}</span>
        <span class="muted">Not added to ${name} yet.</span>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-primary" type="button" data-arr="edit">${icon('plus')}Add to ${name}</button>`;
    }
  }

  arrBar?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-arr],[data-copy]');
    if (!b) return;
    if (b.dataset.copy) return copyText(b.dataset.copy);
    if (await arrDialog(ed.saved, ed.arr)) {
      const fresh = await api(`/api/lists/${ed.id}`);
      ed.saved = fresh;
      renderArrBar();
    }
  });

  // --- results events ---

  results.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tab],[data-exclude],[data-override],#res-preview');
    if (!b) return;
    if (b.id === 'res-preview') return runPreview();
    if (b.dataset.tab) {
      ed.tab = b.dataset.tab;
      renderRes();
      return;
    }
    const item = ed.items?.find((i) => i.key === Number(b.dataset.exclude || b.dataset.override));
    if (!item) return;
    if (b.dataset.exclude) {
      try {
        if (item.excluded) await api(`/api/lists/${ed.id}/exclusions/${item.key}`, { method: 'DELETE' });
        else await api(`/api/lists/${ed.id}/exclusions`, { method: 'POST', body: { key: item.key, title: item.title } });
        item.excluded = !item.excluded;
        toast(item.excluded ? `Excluded ${item.title} from the feed` : `${item.title} is back in the feed`);
        renderRes();
      } catch (err) {
        toast(err.message, true);
      }
    }
    if (b.dataset.override) {
      const changed = await overrideDialog(item, ed.draft.target);
      if (!changed) return;
      if (ed.id && ed.mode === 'saved') {
        setBusy(true, 'Refreshing with the new ID…');
        await api(`/api/lists/${ed.id}/refresh`, { method: 'POST' }).catch((err) => toast(err.message, true));
        const fresh = await api(`/api/lists/${ed.id}`);
        Object.assign(ed, { items: fresh.items, saved: fresh });
        setBusy(false);
      }
      renderRes();
    }
  });

  if (!saved) runPreview();
  if (saved && params?.get('connect') === '1' && arrConnected(saved.target)) {
    history.replaceState(null, '', `#/lists/${saved.id}`);
    setTimeout(() => arrBar.querySelector('[data-arr]')?.click(), 400);
  }
}

// --- form pieces shared by both list types ---

const n = (v) => Number(v) > 0;

/** Active-filter counts per section, shown on the collapsed section headers. */
function sectionCounts(d) {
  const f = d.filters;
  const len = (a) => (a || []).length;
  const tmdb = d.source === 'tmdb';
  return {
    what:
      len(f.genresInclude) + len(f.genresExclude) + len(f.tagsInclude) + len(f.tagsExclude) +
      len(f.keywordsInclude) + len(f.keywordsExclude) + len(f.statuses) + len(f.tvStatuses) + len(f.tvTypes) +
      len(f.movieStatuses) + (f.sequels && f.sequels !== 'include' ? 1 : 0) + (tmdb && !f.excludeAnime ? 1 : 0),
    where:
      len(f.countries) + len(f.languages) + len(f.streaming) + len(f.streamingExclude) + len(f.providers) + len(f.providersExclude) +
      len(f.networks) + len(f.networksExclude),
    who: len(f.people) + len(f.peopleExclude) + len(f.studios) + len(f.studiosExclude) + len(f.companies) + len(f.companiesExclude),
    length:
      (n(f.minRuntime) || n(f.maxRuntime) ? 1 : 0) + (n(f.minEpisodes) || n(f.maxEpisodes) ? 1 : 0) +
      (n(f.minSeasons) || n(f.maxSeasons) ? 1 : 0) + (f.maxCertification ? 1 : 0) + (f.upcomingEpisode ? 1 : 0) +
      (n(f.minRating) || n(f.minVotes) || n(f.minScore) || n(f.minPopularity) ? 1 : 0) +
      (n(f.minImdb) || n(f.minRt) || n(f.minMetacritic) ? 1 : 0),
    output: (n(f.keepDays) ? 1 : 0) + (n(f.dripMax) ? 1 : 0),
  };
}

const SECTION_TITLES = {
  when: 'When',
  what: 'What',
  where: 'Where to watch & origin',
  who: 'People & studios',
  length: 'Length & rating',
  output: 'Ranking & output',
};

function section(ed, id, body) {
  const count = id === 'when' ? 0 : sectionCounts(ed.draft)[id] || 0;
  const open = ed.open.has(id) || count > 0;
  return `
    <details class="form-sec sec" data-sec="${id}"${open ? ' open' : ''}>
      <summary><span>${SECTION_TITLES[id]}</span>${count ? `<span class="sec-count">${count}</span>` : ''}</summary>
      <div class="sec-body">${body}</div>
    </details>`;
}

function typeSection(d) {
  const tv = d.target === 'sonarr';
  const st = d.filters.seriesType;
  return `
    <div class="form-sec">
      <div class="field">
        <label for="ed-name">Name</label>
        <input class="input" id="ed-name" data-f="name" value="${esc(d.name)}" placeholder="${d.source === 'tmdb' ? 'e.g. New Netflix series' : 'e.g. Fall simulcasts'}" maxlength="80" />
      </div>
      <div class="field">
        <span class="label">List type</span>
        <div class="seg">
          <button type="button" class="anime${d.source === 'anilist' ? ' on' : ''}" data-source="anilist">Anime · AniList</button>
          <button type="button" class="normal${d.source === 'tmdb' ? ' on' : ''}" data-source="tmdb">TV & movies · TMDB</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Send to</span>
        <div class="seg">
          <button type="button" class="sonarr${tv ? ' on' : ''}" data-target="sonarr">Sonarr · series</button>
          <button type="button" class="radarr${!tv ? ' on' : ''}" data-target="radarr">Radarr · movies</button>
        </div>
      </div>
      ${
        tv
          ? `<div class="field">
              <span class="label">Sonarr series type</span>
              ${segHtml(
                'filters.seriesType',
                st,
                d.source === 'tmdb' ? [['standard', 'Standard'], ['daily', 'Daily']] : [['anime', 'Anime'], ['standard', 'Standard']],
                true,
              )}
              <span class="hint">${
                d.source === 'tmdb'
                  ? st === 'daily'
                    ? 'Only date-based shows (talk shows, news), added as <b>Daily</b> series.'
                    : 'Added as <b>Standard</b> series. Talk shows and news are left out — they need a Daily list.'
                  : st === 'standard'
                    ? 'Added as <b>Standard</b> series (season/episode numbering) instead of absolute anime numbering.'
                    : 'Added as <b>Anime</b> series (absolute episode numbering).'
              }${d.source === 'tmdb' ? ' Anime is left out so it can’t land with the wrong type.' : ''}</span>
            </div>`
          : ''
      }
    </div>`;
}

function yearRangeHtml(path, from, to) {
  const decades = [1970, 1980, 1990, 2000, 2010, 2020];
  return `
    <div class="row">
      <input class="input" type="number" min="1900" max="2100" data-f="${path}.fromYear" value="${esc(from)}" aria-label="From year" />
      <span class="muted" style="flex:none">to</span>
      <input class="input" type="number" min="1900" max="2100" data-f="${path}.toYear" value="${esc(to)}" aria-label="To year" />
    </div>
    <div class="chips">${decades
      .map((y) => `<button type="button" class="chip${Number(from) === y && Number(to) === y + 9 ? ' on' : ''}" data-decade="${y}" data-path="${path}">${y}s</button>`)
      .join('')}</div>`;
}

function rangeRow(label, minPath, maxPath, f, minKey, maxKey, unit) {
  return `
    <div class="field">
      <span class="label">${label}${unit ? ` <span class="label-note">— ${unit}</span>` : ''}</span>
      <div class="row">
        <input class="input" type="number" min="0" data-f="${minPath}" value="${n(f[minKey]) ? esc(f[minKey]) : ''}" placeholder="min" />
        <span class="muted" style="flex:none">–</span>
        <input class="input" type="number" min="0" data-f="${maxPath}" value="${n(f[maxKey]) ? esc(f[maxKey]) : ''}" placeholder="max" />
      </div>
    </div>`;
}

/** A search box that adds {id,name} chips (keywords, people, studios, companies). */
function entityField(ed, { type, keys, label, placeholder, hint }) {
  const f = ed.draft.filters;
  const [incKey, excKey] = keys;
  const chips = [
    ...removableChips(f[incKey] || [], incKey, 'on'),
    ...(excKey ? removableChips(f[excKey] || [], excKey, 'not') : []),
  ].join('');
  return `
    <div class="field">
      <label for="ent-${incKey}">${label}</label>
      <div class="tag-add">
        <input class="input" id="ent-${incKey}" list="dl-${incKey}" data-ent-type="${type}" placeholder="${esc(placeholder)}" />
        <button type="button" class="btn btn-sm" data-ent-add="${incKey}" data-ent-input="ent-${incKey}">${excKey ? 'Include' : 'Add'}</button>
        ${excKey ? `<button type="button" class="btn btn-sm" data-ent-add="${excKey}" data-ent-input="ent-${incKey}">Leave out</button>` : ''}
      </div>
      <datalist id="dl-${incKey}"></datalist>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      ${hint ? `<span class="hint">${hint}</span>` : ''}
    </div>`;
}

function certField(ed, certs) {
  const f = ed.draft.filters;
  const region = f.region || state.settings?.tmdbRegion || 'US';
  if (!certs) {
    return `<div class="field"><span class="label">Age rating</span>
      <span class="hint">${ed.draft.source === 'anilist' ? 'Uses TMDB’s ratings — add a TMDB key in <a href="#/settings">Settings</a> to use it.' : 'Loading…'}</span></div>`;
  }
  return `
    <div class="field">
      <label for="ed-cert">Max age rating <span class="label-note">— ${esc(region)}</span></label>
      <select class="select" id="ed-cert" data-f="filters.maxCertification">
        <option value="">Any</option>
        ${certs.map((c) => `<option value="${esc(c.code)}"${f.maxCertification === c.code ? ' selected' : ''}>${esc(c.code)}</option>`).join('')}
      </select>
      ${
        f.maxCertification
          ? `<label class="check"><input type="checkbox" data-f="filters.keepUnrated"${f.keepUnrated ? ' checked' : ''} />
              <span><b>Keep titles with no rating</b><span class="hint">${
                ed.draft.source === 'anilist' ? 'Many anime have no TMDB rating for your region.' : 'Otherwise unrated titles are left out.'
              }</span></span></label>`
          : ''
      }
    </div>`;
}

function scoresFields(ed) {
  const f = ed.draft.filters;
  const has = state.settings?.omdbApiKeySet;
  return `
    <div class="field">
      <span class="label">Critic & audience scores</span>
      <span class="hint">IMDb ratings come from IMDb’s own daily ratings file, so they’re current and need no key.${
        has ? '' : ' Rotten Tomatoes and Metacritic need a free OMDb key in <a href="#/settings">Settings</a>.'
      }</span>
      <div class="row">
        <input class="input" type="number" min="0" max="10" step="0.1" data-f="filters.minImdb" value="${n(f.minImdb) ? esc(f.minImdb) : ''}" placeholder="IMDb ≥" title="Minimum IMDb rating (0–10)" />
        <input class="input" type="number" min="0" max="100" data-f="filters.minRt" value="${n(f.minRt) ? esc(f.minRt) : ''}" placeholder="RT % ≥" title="Minimum Rotten Tomatoes critics score" />
        <input class="input" type="number" min="0" max="100" data-f="filters.minMetacritic" value="${n(f.minMetacritic) ? esc(f.minMetacritic) : ''}" placeholder="Metacritic ≥" title="Minimum Metascore" />
      </div>
    </div>`;
}

/** Any score minimum set? (IMDb, RT, Metacritic, plus AniList score or TMDB rating.) */
const scoreMinimums = (f) => [f.minImdb, f.minRt, f.minMetacritic, f.minScore, f.minRating].some((v) => Number(v) > 0);

/** One switch for every score minimum: what happens to titles nobody has scored yet. */
function keepUnscoredField(f, source) {
  const where =
    source === 'anilist'
      ? 'AniList shows no score until enough members rate a show — early in a season that’s most of them.'
      : 'A TMDB rating only counts once the title has your minimum votes; until then it’s not rated yet (except when ranking by rating or votes).';
  return `
    <label class="check" id="keep-unscored"${scoreMinimums(f) ? '' : ' hidden'}><input type="checkbox" data-f="filters.keepUnscored"${f.keepUnscored !== false ? ' checked' : ''} />
      <span><b>Keep titles without a score yet</b><span class="hint">Applies to every score minimum above. ${where} New releases often have no IMDb rating for a few days, and most TV never gets a Rotten Tomatoes or Metacritic score. Untick to drop them. A score Courarr couldn’t check (e.g. OMDb’s daily limit) never passes.</span></span></label>`;
}

function outputExtras(f) {
  return `
    <div class="field">
      <label for="ed-drip">Drip-feed</label>
      <div class="row"><span class="muted" style="flex:none">At most</span><input class="input" id="ed-drip" type="number" min="0" max="500" data-f="filters.dripMax" value="${esc(f.dripMax || 0)}" /><span class="muted" style="flex:none">new titles per refresh</span></div>
      <span class="hint">0 = no limit. The rest wait in a queue, best-ranked first. Titles you already have don’t count.</span>
    </div>
    <label class="check"><input type="checkbox" data-f="filters.notify"${f.notify !== false ? ' checked' : ''} />
      <span><b>Notify me about new titles</b><span class="hint">Uses the notifications set up in Settings.</span></span></label>`;
}

function keepDaysField(f) {
  return `
    <div class="field">
      <label for="ed-keep">Keep titles after they drop off</label>
      <div class="row"><input class="input" id="ed-keep" type="number" min="0" max="365" data-f="filters.keepDays" value="${esc(f.keepDays || 0)}" /><span class="muted" style="flex:none">days</span></div>
      <span class="hint">0 = off. Stops titles flickering in and out of the feed when they hover around the cut-off.</span>
    </div>`;
}

function advancedSection(d) {
  return `
    <div class="form-sec">
      <details class="adv">
        <summary>Advanced</summary>
        <div>
          <div class="field">
            <label for="ed-slug">Feed name</label>
            <input class="input mono" id="ed-slug" data-f="slug" value="${esc(d.slug)}" placeholder="generated from the name" />
            <span class="hint">Part of the feed URL: /feed/<b>${esc(d.slug || 'name')}</b></span>
          </div>
          <label class="check">
            <input type="checkbox" data-f="enabled"${d.enabled ? ' checked' : ''} />
            <span><b>Include in scheduled refreshes</b><span class="hint">When off, the feed keeps its last results.</span></span>
          </label>
        </div>
      </details>
    </div>`;
}

function footSection(ed) {
  return `
    <div class="form-foot">
      <button type="button" class="btn" id="ed-preview">${icon('play')}Preview</button>
      <span class="spacer"></span>
      ${ed.saved ? '<button type="button" class="btn btn-ghost btn-danger" id="ed-delete">Delete</button>' : ''}
      <button type="submit" class="btn btn-primary">${ed.saved ? 'Save & refresh' : 'Create list'}</button>
    </div>`;
}

const chipHtml = (arr, key, v, label, num = false) =>
  `<button type="button" class="chip${arr.includes(v) ? ' on' : ''}" data-chip="${key}" data-v="${esc(v)}"${num ? ' data-num="1"' : ''}>${esc(label)}</button>`;

/** Include / leave-out pairs: a value can be in one list or the other, never both. */
const PAIRS = {
  genresInclude: 'genresExclude',
  keywordsInclude: 'keywordsExclude',
  tagsInclude: 'tagsExclude',
  people: 'peopleExclude',
  studios: 'studiosExclude',
  companies: 'companiesExclude',
  streaming: 'streamingExclude',
  providers: 'providersExclude',
  networks: 'networksExclude',
};
const pairKeys = (key) => {
  const inc = PAIRS[key] ? key : Object.keys(PAIRS).find((k) => PAIRS[k] === key);
  return inc ? [inc, PAIRS[inc]] : [key];
};

/** A chip that's included (on), left out (not) or neither; clicking follows the field's Include / Leave out toggle. */
const pairChip = (f, inc, v, label, num = false) =>
  `<button type="button" class="chip${(f[inc] || []).includes(v) ? ' on' : ''}${(f[PAIRS[inc]] || []).includes(v) ? ' not' : ''}" data-pair="${inc}" data-v="${esc(v)}"${num ? ' data-num="1"' : ''}>${esc(label)}</button>`;

/** The Include / Leave out switch for a pair of lists (editor-only state, not saved). */
const modeToggle = (ed, inc) =>
  `<div class="seg" style="flex:none;width:190px">${[
    ['include', 'Include'],
    ['exclude', 'Leave out'],
  ]
    .map(([v, l]) => `<button type="button" data-mode-for="${inc}" data-mode="${v}" class="${(ed.modes[inc] || 'include') === v ? 'on' : ''}">${l}</button>`)
    .join('')}</div>`;

/** Field heading with the Include / Leave out switch on the right. */
const pickHead = (ed, inc, label) => `
      <div class="row" style="align-items:center">
        <span class="label" style="flex:1">${label}</span>
        ${modeToggle(ed, inc)}
      </div>`;

const segHtml = (path, current, options, rerender = false) =>
  `<div class="seg">${options
    .map(([v, l]) => `<button type="button" data-seg="${path}" data-v="${v}"${rerender ? ' data-rerender="1"' : ''} class="${current === v ? 'on' : ''}">${l}</button>`)
    .join('')}</div>`;

const removableChips = (list, key, cls) =>
  list.map((t) => `<button type="button" class="chip ${cls}" data-remove="${key}" data-v="${esc(t.id ?? t)}">${esc(t.name ?? t)} <span class="x">×</span></button>`);

function genresField(ed, genres, num) {
  const f = ed.draft.filters;
  return `
    <div class="field">
      ${pickHead(ed, 'genresInclude', 'Genres')}
      <span class="hint">Pick <b>Include</b> or <b>Leave out</b>, then click genres. Click one again to clear it. Titles with any left-out genre are dropped.</span>
      <div class="chips">${genres.map((g) => (num ? pairChip(f, 'genresInclude', g.id, g.name, true) : pairChip(f, 'genresInclude', g, g))).join('')}</div>
      <div class="row" style="align-items:center">
        <span class="hint" style="flex:1">Included genres: titles need</span>
        <div style="flex:none;width:190px">${segHtml('filters.genreMatch', f.genreMatch || 'all', [['all', 'All of them'], ['any', 'Any of them']])}</div>
      </div>
    </div>`;
}

// --- anime form ---

function animeFormHtml(ed) {
  const d = ed.draft;
  const f = d.filters;
  const s = f.season;
  const tv = d.target === 'sonarr';
  const year = new Date().getFullYear();
  const formats = tv ? ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL', 'MOVIE'] : ['MOVIE', 'SPECIAL', 'OVA', 'ONA'];
  const certs = ed.tmeta?.certifications;

  const when = `
    <div class="field">
      <select class="select" id="ed-season" data-f="filters.season.mode" aria-label="When">
        ${Object.entries(SEASON_MODES).map(([k, v]) => `<option value="${k}"${s.mode === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      ${
        s.mode === 'specific'
          ? `<div class="row">
              <select class="select" data-f="filters.season.season">
                ${['WINTER', 'SPRING', 'SUMMER', 'FALL'].map((x) => `<option value="${x}"${s.season === x ? ' selected' : ''}>${x[0] + x.slice(1).toLowerCase()}</option>`).join('')}
              </select>
              <input class="input" type="number" min="1940" max="${year + 2}" data-f="filters.season.year" value="${esc(s.year)}" />
            </div>`
          : ''
      }
      ${s.mode === 'year' ? `<input class="input" type="number" min="1940" max="${year + 2}" data-f="filters.season.year" value="${esc(s.year)}" />` : ''}
      ${s.mode === 'range' ? yearRangeHtml('filters.season', s.fromYear, s.toYear) : ''}
      ${s.mode === 'lastYears' ? `<div class="row"><input class="input" type="number" min="1" max="50" data-f="filters.season.years" value="${esc(s.years)}" /><span class="muted" style="flex:none">years</span></div>` : ''}
      ${
        ['current', 'next', 'previous', 'currentYear', 'lastYears'].includes(s.mode)
          ? `<span class="hint">Rolls forward automatically${['currentYear', 'lastYears'].includes(s.mode) ? ' each January' : ` — switches ${state.settings?.seasonRolloverDays ?? 14} days before a season starts`}.</span>`
          : ''
      }
    </div>`;

  const what = `
    <div class="field">
      <span class="label">Format</span>
      <div class="chips">${formats.map((x) => chipHtml(f.formats, 'formats', x, FORMAT_NAMES[x])).join('')}</div>
    </div>
    ${genresField(ed, ed.meta.genres, false)}
    <div class="field">
      <label for="tag-input">Tags</label>
      <div class="tag-add">
        <input class="input" id="tag-input" list="tag-list" placeholder="Isekai, Iyashikei, Time Skip…" />
        <button type="button" class="btn btn-sm" data-tag-add="tagsInclude">Include</button>
        <button type="button" class="btn btn-sm" data-tag-add="tagsExclude">Leave out</button>
      </div>
      ${
        f.tagsInclude.length + f.tagsExclude.length
          ? `<div class="chips">${removableChips(f.tagsInclude, 'tagsInclude', 'on').join('')}${removableChips(f.tagsExclude, 'tagsExclude', 'not').join('')}</div>`
          : ''
      }
    </div>
    <div class="field">
      <span class="label">Status <span class="label-note">— none = any</span></span>
      <div class="chips">${Object.entries(STATUS_NAMES).map(([k, v]) => chipHtml(f.statuses, 'statuses', k, v)).join('')}</div>
    </div>
    <div class="field">
      <span class="label">Sequels</span>
      ${segHtml('filters.sequels', f.sequels, [['include', 'Include'], ['exclude', 'New only'], ['only', 'Sequels only']])}
    </div>`;

  const where = `
    <div class="field">
      ${pickHead(ed, 'streaming', 'Streaming on <span class="label-note">— none = any</span>')}
      <div class="chips">${(ed.meta.streaming || []).map((x) => pairChip(f, 'streaming', x.id, x.name, true)).join('')}</div>
    </div>
    <div class="field">
      <span class="label">Country of origin</span>
      <div class="chips">${Object.entries(ANIME_COUNTRIES).map(([k, v]) => chipHtml(f.countries, 'countries', k, v)).join('')}</div>
    </div>`;

  const who = `
    ${entityField(ed, { type: 'studio', keys: ['studios', 'studiosExclude'], label: 'Studios', placeholder: 'MAPPA, Kyoto Animation, ufotable…', hint: 'Matches the main animation studio. Included: any of them. Left out: anime from any of them are dropped.' })}
    ${entityField(ed, { type: 'staff', keys: ['people', 'peopleExclude'], label: 'People', placeholder: 'Director, composer or voice actor…', hint: 'Included: anime any of them worked on or voiced. Left out: anime any of them worked on are dropped.' })}`;

  const length = `
    ${rangeRow(tv ? 'Episode length' : 'Runtime', 'filters.minRuntime', 'filters.maxRuntime', f, 'minRuntime', 'maxRuntime', 'minutes')}
    ${tv ? rangeRow('Episodes', 'filters.minEpisodes', 'filters.maxEpisodes', f, 'minEpisodes', 'maxEpisodes') : ''}
    <span class="hint">Titles whose length isn’t announced yet are kept.</span>
    ${scoresFields(ed)}
    ${certField(ed, certs)}
    <div class="row">
      <div class="field">
        <label for="ed-pop">Min popularity</label>
        <input class="input" id="ed-pop" type="number" min="0" step="500" data-f="filters.minPopularity" value="${esc(f.minPopularity)}" />
      </div>
      <div class="field">
        <label for="ed-score">Min score</label>
        <input class="input" id="ed-score" type="number" min="0" max="100" data-f="filters.minScore" value="${esc(f.minScore)}" />
      </div>
    </div>
    <span class="hint">Popularity = AniList members who added it. Score is AniList members’ weighted average, 0–100.</span>
    ${keepUnscoredField(f, 'anilist')}`;

  const output = `
    <div class="row">
      <div class="field">
        <label for="ed-sort">Rank by</label>
        <select class="select" id="ed-sort" data-f="filters.sort">
          ${Object.entries(ANIME_SORTS).map(([k, v]) => `<option value="${k}"${f.sort === k ? ' selected' : ''}>${v}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="ed-limit">Keep top</label>
        <input class="input" id="ed-limit" type="number" min="1" max="500" data-f="filters.limit" value="${esc(f.limit)}" />
      </div>
    </div>
    ${keepDaysField(f)}
    ${outputExtras(f)}`;

  return `
    ${typeSection(d)}
    ${section(ed, 'when', when)}
    ${section(ed, 'what', what)}
    ${section(ed, 'where', where)}
    ${section(ed, 'who', who)}
    ${section(ed, 'length', length)}
    ${section(ed, 'output', output)}
    ${advancedSection(d)}
    ${footSection(ed)}`;
}

// --- TV & movies (TMDB) form ---

function tmdbFormHtml(ed) {
  const d = ed.draft;
  const f = d.filters;
  const tv = d.target === 'sonarr';
  const year = new Date().getFullYear();
  const m = ed.tmeta;
  const trending = f.collection === 'trending';
  const arrivalsMode = f.collection === 'arrivals';
  const byPeople = tv && f.people.length > 0 && !arrivalsMode;
  const region = f.region || state.settings?.tmdbRegion || 'US';
  const dateModes = Object.entries(DATE_MODES).filter(([k]) => tv || k !== 'airing');

  if (!m) {
    return `${typeSection(d)}
      <div class="form-sec">
        <div class="notice">${
          state.settings?.tmdbApiKeySet
            ? `Couldn’t load TMDB data: ${esc(ed.tmetaError || 'unknown error')}`
            : 'TV & movie lists use TMDB. Add a free TMDB API key in <a href="#/settings">Settings</a> first.'
        }</div>
      </div>
      ${advancedSection(d)}${footSection(ed)}`;
  }

  const when = `
    <div class="field">
      <span class="label">Source</span>
      ${segHtml('filters.collection', f.collection, [['discover', 'Discover'], ['trending', 'Trending'], ['arrivals', 'New on my services']], true)}
      ${
        arrivalsMode
          ? `<div class="row"><span class="muted" style="flex:none">Arrived in the last</span><input class="input" type="number" min="1" max="90" data-f="filters.arrivalDays" value="${esc(f.arrivalDays || 14)}" /><span class="muted" style="flex:none">days</span></div>
            <span class="hint">Courarr records what’s on the services you pick (under <i>Where to watch</i>) at every refresh and lists what newly appeared. Tracking starts when you save.</span>`
          : ''
      }
      ${trending || byPeople ? `<span class="hint">${trending ? 'Trending' : 'With people chosen, a person’s credits'} can’t use streaming, network, company or keyword filters.</span>` : ''}
    </div>
    <div class="field">
      <label for="ed-date">${tv ? 'Premiered / airing' : 'Released'}</label>
      <select class="select" id="ed-date" data-f="filters.date.mode">
        ${dateModes.map(([k, v]) => `<option value="${k}"${f.date.mode === k ? ' selected' : ''}>${v}</option>`).join('')}
      </select>
      ${f.date.mode === 'year' ? `<input class="input" type="number" min="1900" max="${year + 3}" data-f="filters.date.year" value="${esc(f.date.year)}" />` : ''}
      ${f.date.mode === 'range' ? yearRangeHtml('filters.date', f.date.fromYear, f.date.toYear) : ''}
      ${f.date.mode === 'lastYears' ? `<div class="row"><input class="input" type="number" min="1" max="50" data-f="filters.date.years" value="${esc(f.date.years)}" /><span class="muted" style="flex:none">years</span></div>` : ''}
      ${
        f.date.mode === 'lastDays' || f.date.mode === 'nextDays'
          ? `<div class="row"><input class="input" type="number" min="1" max="3650" data-f="filters.date.days" value="${esc(f.date.days)}" /><span class="muted" style="flex:none">days</span></div>`
          : ''
      }
      ${['lastDays', 'nextDays', 'thisYear', 'lastYears', 'airing'].includes(f.date.mode) ? '<span class="hint">Moves with the calendar on every refresh.</span>' : ''}
    </div>
    ${
      !tv
        ? `<div class="field">
            <span class="label">Release type</span>
            ${segHtml('filters.releaseType', f.releaseType, [['any', 'Any'], ['theatrical', 'Cinemas'], ['digital', 'Digital / disc']])}
            <span class="hint">“Digital / disc” dates by the streaming, rental or Blu-ray release in ${esc(region)} — good for Radarr, since that’s when a release exists to grab.</span>
          </div>`
        : ''
    }`;

  const what = `
    ${genresField(ed, m.genres, true)}
    <label class="check">
      <input type="checkbox" data-f="filters.excludeAnime"${f.excludeAnime ? ' checked' : ''} />
      <span><b>Leave out anime</b><span class="hint">Use an Anime list for those${tv ? ' — they need the Anime series type' : ''}.</span></span>
    </label>
    ${trending || byPeople ? '' : entityField(ed, { type: 'keyword', keys: ['keywordsInclude', 'keywordsExclude'], label: 'Keywords', placeholder: 'time travel, heist, based on novel…', hint: 'Included keywords match if <i>any</i> of them apply. Titles with any left-out keyword are dropped.' })}
    ${
      tv
        ? `<div class="field">
            <span class="label">Show type <span class="label-note">— none = any</span></span>
            <div class="chips">${m.tvTypes
              .filter((t) => (f.seriesType === 'daily') === [1, 5].includes(t.id))
              .map((t) => chipHtml(f.tvTypes, 'tvTypes', t.id, t.name, true))
              .join('')}</div>
          </div>
          <div class="field">
            <span class="label">Status <span class="label-note">— none = any</span></span>
            <div class="chips">${m.tvStatuses.map((t) => chipHtml(f.tvStatuses, 'tvStatuses', t.id, t.name, true)).join('')}</div>
          </div>`
        : `<div class="field">
            <span class="label">Status <span class="label-note">— none = any</span></span>
            <div class="chips">${m.movieStatuses.map((t) => chipHtml(f.movieStatuses, 'movieStatuses', t, t)).join('')}</div>
          </div>
          <div class="field">
            <span class="label">Sequels</span>
            ${segHtml('filters.sequels', f.sequels, [['include', 'Include'], ['exclude', 'First films only'], ['only', 'Sequels only']])}
            <span class="hint">Based on the film’s TMDB collection (e.g. a trilogy).</span>
          </div>`
    }`;

  const customNets = ['networks', 'networksExclude'].flatMap((key) => (f[key] || []).filter((id) => !m.networks.some((x) => x.id === id)).map((id) => [key, id]));
  const where = `
    <div class="field">
      <span class="label">Original language <span class="label-note">— none = any</span></span>
      <div class="chips">${m.languages.map((l) => chipHtml(f.languages, 'languages', l.code, l.name)).join('')}</div>
    </div>
    <div class="field">
      <span class="label">Country of origin <span class="label-note">— none = any</span></span>
      <div class="chips">${m.countries.map((c) => chipHtml(f.countries, 'countries', c.code, c.name)).join('')}</div>
    </div>
    ${
      (f.providers.length || arrivalsMode) && !f.languages.length
        ? '<div class="notice">Streaming catalogues are full of titles in other languages (e.g. French or Korean originals on Netflix). Pick an <b>original language</b> above to keep them out.</div>'
        : ''
    }
    ${
      trending || byPeople
        ? ''
        : `<div class="field">
            <div class="row" style="align-items:flex-end">
              <span class="label" style="flex:1">Streaming on <span class="label-note">— subscription / free</span></span>
              ${modeToggle(ed, 'providers')}
              <select class="select" data-f="filters.region" title="Streaming & age-rating region" style="flex:none;width:90px;height:30px">
                ${REGIONS.map((r) => `<option value="${r}"${region === r ? ' selected' : ''}>${r}</option>`).join('')}
              </select>
            </div>
            <div class="chips">${m.providers.map((p) => pairChip(f, 'providers', p.id, p.name, true)).join('')}</div>
          </div>
          ${
            tv
              ? `<div class="field">
                  ${pickHead(ed, 'networks', 'Network / channel <span class="label-note">— original broadcaster</span>')}
                  <div class="chips">
                    ${m.networks.map((x) => pairChip(f, 'networks', x.id, x.name, true)).join('')}
                    ${customNets.map(([key, id]) => `<button type="button" class="chip ${key === 'networks' ? 'on' : 'not'}" data-remove="${key}" data-v="${id}">${esc(ed.networkNames[id] || `Network ${id}`)} <span class="x">×</span></button>`).join('')}
                  </div>
                  <div class="tag-add">
                    <input class="input" id="net-input" inputmode="numeric" placeholder="Other network ID (from themoviedb.org/network/…)" />
                    <button type="button" class="btn btn-sm" id="net-add">Add</button>
                  </div>
                </div>`
              : ''
          }`
    }`;

  const who = `
    ${entityField(ed, {
      type: 'person',
      keys: ['people', 'peopleExclude'],
      label: tv ? 'People' : 'Cast & crew',
      placeholder: 'Actor, director, writer…',
      hint: tv
        ? 'Included: shows any of them acted in or made. Left out: their shows are dropped.'
        : 'Included: films with any of them. Left out: their films are dropped.',
    })}
    ${trending || byPeople ? '' : entityField(ed, { type: 'company', keys: ['companies', 'companiesExclude'], label: 'Production companies', placeholder: 'A24, Pixar, BBC Studios…', hint: 'Included: any of them. Left out: titles from any of them are dropped.' })}`;

  const length = `
    ${rangeRow(tv ? 'Episode length' : 'Runtime', 'filters.minRuntime', 'filters.maxRuntime', f, 'minRuntime', 'maxRuntime', 'minutes')}
    ${
      tv
        ? `${rangeRow('Seasons', 'filters.minSeasons', 'filters.maxSeasons', f, 'minSeasons', 'maxSeasons')}
          ${rangeRow('Episodes', 'filters.minEpisodes', 'filters.maxEpisodes', f, 'minEpisodes', 'maxEpisodes')}
          <label class="check"><input type="checkbox" data-f="filters.upcomingEpisode"${f.upcomingEpisode ? ' checked' : ''} />
            <span><b>Has an upcoming episode</b><span class="hint">Only shows with a next episode scheduled.</span></span></label>`
        : ''
    }
    ${scoresFields(ed)}
    ${certField(ed, m.certifications)}
    <div class="row">
      <div class="field">
        <label for="ed-rating">Min rating</label>
        <input class="input" id="ed-rating" type="number" min="0" max="10" step="0.5" data-f="filters.minRating" value="${esc(f.minRating)}" />
      </div>
      <div class="field">
        <label for="ed-votes">Min votes</label>
        <input class="input" id="ed-votes" type="number" min="0" step="10" data-f="filters.minVotes" value="${esc(f.minVotes)}" />
      </div>
    </div>
    <span class="hint">Rating is TMDB members’ 0–10 average. Min votes is how many votes a rating needs before it counts, so a handful of 10/10s can’t carry an obscure title.</span>
    ${keepUnscoredField(f, 'tmdb')}`;

  const output = `
    <div class="row">
      <div class="field">
        <label for="ed-sort">Rank by</label>
        <select class="select" id="ed-sort" data-f="filters.sort"${trending || byPeople ? ' disabled title="Ranked by TMDB popularity"' : ''}>
          ${m.sorts.map((x) => `<option value="${x.id}"${f.sort === x.id ? ' selected' : ''}>${x.name}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="ed-limit">Keep top</label>
        <input class="input" id="ed-limit" type="number" min="1" max="500" data-f="filters.limit" value="${esc(f.limit)}" />
      </div>
    </div>
    ${keepDaysField(f)}
    ${outputExtras(f)}`;

  return `
    ${typeSection(d)}
    ${section(ed, 'when', when)}
    ${section(ed, 'what', what)}
    ${section(ed, 'where', where)}
    ${section(ed, 'who', who)}
    ${section(ed, 'length', length)}
    ${section(ed, 'output', output)}
    ${advancedSection(d)}
    ${footSection(ed)}`;
}

// --- results ---

const inFeed = (i) => i.externalId && !i.excluded && !i.ignored && !i.queued;

function resultsHtml(ed) {
  const { target, source } = ed.draft;
  if (!ed.items) {
    return `<div class="empty"><h2>Nothing to show yet</h2>
      <p>Run a preview to see what this list would send to ${ARR[target]}.</p>
      <p><button class="btn btn-primary" id="res-preview" type="button">${icon('play')}Preview</button></p></div>`;
  }
  const items = ed.items;
  const counts = {
    all: items.length,
    feed: items.filter(inFeed).length,
    unmatched: items.filter((i) => !i.externalId).length,
    excluded: items.filter((i) => i.excluded).length,
    queued: items.filter((i) => i.queued && !i.excluded && !i.ignored).length,
    ignored: items.filter((i) => i.ignored).length,
  };
  const matchable = source === 'anilist' || target === 'sonarr';
  const tabs = [
    ['all', 'All'],
    ['feed', 'In feed'],
    ...(counts.queued ? [['queued', 'Queued']] : []),
    ...(matchable ? [['unmatched', 'Unmatched']] : []),
    ...(counts.ignored ? [['ignored', 'Ignored']] : []),
    ['excluded', 'Excluded'],
  ];
  const shown = items.filter((i) =>
    ed.tab === 'feed' ? inFeed(i)
      : ed.tab === 'unmatched' ? !i.externalId
        : ed.tab === 'excluded' ? i.excluded
          : ed.tab === 'queued' ? i.queued && !i.excluded && !i.ignored
            : ed.tab === 'ignored' ? i.ignored
              : true,
  );
  const lib = items.filter((i) => i.inLibrary).length;
  const sub =
    ed.mode === 'preview'
      ? ed.saved
        ? 'Preview of your unsaved changes — the feed still serves the saved version until you save.'
        : 'Preview — create the list to publish its feed.'
      : `Feed last refreshed ${ago(ed.saved?.last_refresh)}.`;
  const legend =
    source === 'anilist'
      ? ['mapping', 'prequel', 'imdb', 'lookup', 'override']
      : target === 'sonarr'
        ? ['tmdb', 'sonarr', 'tmdbOnly']
        : ['tmdb'];

  return `
    <div class="results-head">
      <div>
        <h2>${esc(ed.label || 'Results')} <span class="faint" style="font-weight:500">· ${counts.feed} going to ${ARR[target]}</span></h2>
        <div class="results-sub">${esc(sub)}${arrConnected(target) ? ` ${lib} already in your library.` : ''}</div>
      </div>
      <div class="tabs">
        ${tabs.map(([k, v]) => `<button type="button" data-tab="${k}" class="${ed.tab === k ? 'on' : ''}">${v}<span class="n">${counts[k]}</span></button>`).join('')}
      </div>
    </div>
    ${ed.warnings.map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
    ${
      counts.queued
        ? `<div class="notice info">${counts.queued} title${counts.queued > 1 ? 's are' : ' is'} queued by drip-feed — ${ed.saved?.filters?.dripMax || ed.draft.filters.dripMax} more go to ${ARR[target]} each refresh.</div>`
        : ''
    }
    ${
      counts.ignored
        ? `<div class="notice info">${counts.ignored} title${counts.ignored > 1 ? 's are' : ' is'} ignored (Maintainerr collections or ${ARR[target]}’s import list exclusions) and won’t be sent.</div>`
        : ''
    }
    ${
      counts.unmatched && source === 'anilist'
        ? `<div class="notice info">${counts.unmatched} title${counts.unmatched > 1 ? 's have' : ' has'} no ${target === 'sonarr' ? 'TVDB' : 'TMDB'} ID yet. New shows usually get mapped within a few days; the daily refresh picks them up. You can also set an ID by hand with the # button.</div>`
        : counts.unmatched
          ? `<div class="notice info">${counts.unmatched} show${counts.unmatched > 1 ? 's have' : ' has'} no TVDB ID yet, which Sonarr needs. ${arrConnected('sonarr') ? 'Sonarr couldn’t find one either — ' : 'Connecting Sonarr in Settings lets Courarr ask it — otherwise '}the daily refresh picks them up once one exists.</div>`
          : ''
    }
    <div class="legend">
      ${legend.map((k) => `<span title="${esc(MATCH[k][1])}"><i style="background:var(--src-${k})"></i>${MATCH[k][0]}</span>`).join('')}
      ${source === 'anilist' ? '<span><i style="background:var(--err)"></i>No match</span>' : ''}
    </div>
    ${shown.length ? `<div class="grid">${shown.map((it) => itemHtml(it, items.indexOf(it), ed)).join('')}</div>` : '<div class="empty"><p>Nothing here.</p></div>'}`;
}

const shortCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Every score a title has, named by source. A score the list filters on but the title lacks shows as "—". */
function scoreText(it, f = {}) {
  const sc = it.scores || {};
  const votes = (n) => (n ? ` (${n.toLocaleString()} votes)` : '');
  const dash = (label, why) => `<span title="${esc(why)}">${label} <b>—</b></span>`;
  const kept = '— kept because “Keep titles without a score yet” is on';
  const missing = (k, label, min) =>
    min > 0 && sc[k] == null ? dash(label, sc.unchecked?.includes(k) ? `Couldn’t check the ${label} score` : `No ${label} score yet ${kept}`) : '';
  // A TMDB rating only counts once the title has the list's minimum votes.
  const needVotes = Math.max(Number(f.minVotes) || 0, 1);
  const tmdbUnrated = f.minRating > 0 && (it.votes || 0) < needVotes;
  return [
    it.score ? `<span title="AniList members’ weighted average">AniList <b>${it.score}%</b></span>` : f.minScore > 0 ? dash('AniList', `No AniList score yet ${kept}`) : '',
    tmdbUnrated
      ? dash('TMDB', `Not rated yet: ${it.votes || 0} of ${needVotes} votes${it.rating ? ` (${it.rating} so far)` : ''} ${kept}`)
      : it.rating
        ? `<span title="TMDB user score${votes(it.votes)}">TMDB <b>${it.rating}</b>${it.votes ? ` <small>${shortCount(it.votes)}</small>` : ''}</span>`
        : '',
    sc.imdb != null
      ? `<span title="IMDb rating${votes(sc.imdbVotes)}">IMDb <b>${sc.imdb}</b>${sc.imdbVotes ? ` <small>${shortCount(sc.imdbVotes)}</small>` : ''}</span>`
      : missing('imdb', 'IMDb', f.minImdb),
    sc.rt != null ? `<span title="Rotten Tomatoes critics">RT <b>${sc.rt}%</b></span>` : missing('rt', 'RT', f.minRt),
    sc.metacritic != null ? `<span title="Metascore">MC <b>${sc.metacritic}</b></span>` : missing('metacritic', 'Metacritic', f.minMetacritic),
  ]
    .filter(Boolean)
    .join('');
}

function keptUntil(it, ed) {
  const days = ed.saved?.filters?.keepDays || 0;
  return new Date(new Date(it.lastSeen).getTime() + days * 86_400_000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function itemHtml(it, idx, ed) {
  const { target, source } = ed.draft;
  const src = it.matchSource;
  const anime = source === 'anilist';
  let meta;
  let ids;
  const mins = (v) => (v >= 60 ? `${Math.floor(v / 60)}h ${v % 60}m` : `${v}m`);
  if (anime) {
    meta = [
      FORMAT_NAMES[it.format] || it.format,
      it.episodes ? `${it.episodes} ep` : null,
      it.format === 'MOVIE' && it.runtime ? mins(it.runtime) : null,
      it.certification,
      it.studio,
    ];
    const idLabel = target === 'sonarr' ? 'TVDB' : 'TMDB';
    const url = target === 'sonarr' ? `https://thetvdb.com/dereferrer/series/${it.externalId}` : `https://www.themoviedb.org/movie/${it.externalId}`;
    ids = it.externalId ? `<a href="${url}" target="_blank" rel="noopener">${idLabel} ${it.externalId}</a>` : `<span class="faint">no ${idLabel} ID</span>`;
  } else {
    meta = [
      it.year,
      it.seasons ? `${it.seasons} season${it.seasons > 1 ? 's' : ''}` : null,
      it.episodes ? `${it.episodes} eps` : null,
      it.format === 'MOVIE' && it.runtime ? mins(it.runtime) : null,
      it.certification,
      it.language?.toUpperCase(),
    ];
    ids = [
      `<a href="${esc(it.siteUrl)}" target="_blank" rel="noopener">TMDB ${it.tmdbId}</a>`,
      it.tvdbId ? `<a href="https://thetvdb.com/dereferrer/series/${it.tvdbId}" target="_blank" rel="noopener">TVDB ${it.tvdbId}</a>` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const scores = scoreText(it, ed.draft.filters);
  return `
    <div class="item${it.excluded ? ' excluded' : ''}">
      <div class="poster" style="background:${esc(it.color || 'var(--panel-2)')}">
        ${it.cover ? `<img loading="lazy" src="${esc(it.cover)}" alt="" />` : '<div class="no-poster">No poster</div>'}
        <span class="rank">${idx + 1}</span>
        <div class="item-actions">
          ${ed.saved ? `<button type="button" data-exclude="${it.key}" title="${it.excluded ? 'Put back in the feed' : 'Exclude from the feed'}">${icon(it.excluded ? 'eye' : 'eyeOff')}</button>` : ''}
          ${anime ? `<button type="button" data-override="${it.key}" title="Set the ${target === 'sonarr' ? 'TVDB' : 'TMDB'} ID by hand">${icon('hash')}</button>` : ''}
          <a href="${esc(it.siteUrl)}" target="_blank" rel="noopener" title="Open on ${anime ? 'AniList' : 'TMDB'}">${icon('ext')}</a>
        </div>
        <div class="badges">
          ${src ? `<span class="badge src-${src}" title="${esc(MATCH[src][1])}"><i></i>${MATCH[src][0]}</span>` : '<span class="badge src-none"><i></i>No match</span>'}
          ${it.inLibrary ? '<span class="badge lib">In library</span>' : ''}
          ${it.sequel ? '<span class="badge">Sequel</span>' : ''}
          ${it.excluded ? '<span class="badge src-none">Excluded</span>' : ''}
          ${it.ignored ? `<span class="badge src-none" title="${esc(it.ignored)}">Ignored</span>` : ''}
          ${it.queued && !it.excluded && !it.ignored ? '<span class="badge kept" title="Waiting for a drip-feed slot">Queued</span>' : ''}
          ${it.arrivedAt ? `<span class="badge lib" title="First seen on your services">New ${esc(new Date(it.arrivedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</span>` : ''}
          ${it.retained ? `<span class="badge kept" title="Dropped out of the results; kept because of “Keep titles after they drop off”">Kept until ${esc(keptUntil(it, ed))}</span>` : ''}
        </div>
      </div>
      <div class="item-body">
        <div class="item-title" title="${esc(it.subtitle || it.title)}">${esc(it.title)}</div>
        <div class="item-meta">${esc(meta.filter(Boolean).join(' · '))}</div>
        ${scores ? `<div class="item-scores">${scores}</div>` : ''}
        <div class="item-id">${ids}</div>
      </div>
    </div>`;
}

// ---------- dialogs ----------

function openDialog(html, onClose) {
  dialog.innerHTML = html;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', async () => resolve(await onClose(dialog.returnValue)), { once: true });
  });
}

function overrideDialog(item, target) {
  const idLabel = target === 'sonarr' ? 'TVDB' : 'TMDB';
  const key = target === 'sonarr' ? 'tvdbId' : 'tmdbId';
  const current = item.matchSource === 'override' ? item.externalId : '';
  const p = openDialog(
    `<form method="dialog">
      <div>
        <h2>Set ${idLabel} ID</h2>
        <p class="muted" style="margin:4px 0 0">${esc(item.title)}</p>
      </div>
      <div class="field">
        <label for="ov-id">${idLabel} ${target === 'sonarr' ? 'series' : 'movie'} ID</label>
        <input class="input mono" id="ov-id" inputmode="numeric" value="${esc(current)}" placeholder="${esc(item.externalId || '')}" />
        <span class="hint">${
          target === 'sonarr'
            ? 'The number in the TheTVDB series URL. For a sequel, use the parent series — Sonarr tracks seasons inside one series.'
            : 'The number in the themoviedb.org movie URL.'
        } Applies to every list.</span>
      </div>
      <div class="actions">
        ${current ? '<button class="btn btn-ghost btn-danger" value="clear">Remove override</button>' : ''}
        <button class="btn btn-ghost" value="cancel">Cancel</button>
        <button class="btn btn-primary" value="save">Save</button>
      </div>
    </form>`,
    async (action) => {
      if (action !== 'save' && action !== 'clear') return false;
      const raw = action === 'clear' ? null : dialog.querySelector('#ov-id').value.trim();
      if (action === 'save' && !/^\d+$/.test(raw || '')) {
        toast(`${idLabel} IDs are whole numbers`, true);
        return false;
      }
      try {
        await api(`/api/overrides/${item.key}`, { method: 'PUT', body: { [key]: raw, title: item.title } });
        if (raw) Object.assign(item, { externalId: Number(raw), matchSource: 'override' });
        else Object.assign(item, { externalId: null, matchSource: null });
        toast(raw ? `${item.title} → ${idLabel} ${raw}` : 'Override removed — refresh to re-match');
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    },
  );
  // Enter would otherwise "click" the first button in the form (Remove/Cancel).
  dialog.querySelector('#ov-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.close('save');
    }
  });
  return p;
}

const SONARR_MONITOR = {
  all: 'All episodes',
  future: 'Future episodes',
  missing: 'Missing episodes',
  existing: 'Existing episodes',
  recent: 'Recent episodes',
  firstSeason: 'First season',
  lastSeason: 'Latest season',
  pilot: 'Pilot episode',
  none: 'None',
};
const RADARR_MONITOR = { movieOnly: 'Movie only', movieAndCollection: 'Movie and collection', none: 'None' };
const RADARR_AVAIL = { announced: 'Announced', inCinemas: 'In cinemas', released: 'Released' };

async function arrDialog(list, arrInfo) {
  const kind = list.target;
  const name = ARR[kind];
  let opts;
  try {
    opts = await api(`/api/arr/${kind}/options`);
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  const il = arrInfo?.importList;
  const rec = arrInfo?.recommendedSeriesType || (list.source === 'tmdb' ? 'standard' : 'anime');
  const cur = {
    rootFolderPath: il?.rootFolderPath || opts.rootFolders[0]?.path || '',
    qualityProfileId: il?.qualityProfileId ?? opts.qualityProfiles[0]?.id,
    seriesType: il?.seriesType || rec,
    monitor: il?.monitor || (kind === 'sonarr' ? 'all' : 'movieOnly'),
    minimumAvailability: il?.minimumAvailability || 'released',
    seasonFolder: il ? il.seasonFolder !== false : true,
    searchOnAdd: il ? !!il.searchOnAdd : true,
    tags: il?.tags || [],
  };
  const gb = (b) => (b ? `${(b / 1024 ** 3).toFixed(0)} GB free` : '');
  const sel = (id, entries, value) =>
    `<select class="select" id="${id}">${entries.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  if (!opts.rootFolders.length) {
    toast(`${name} has no root folders yet — add one in ${name} → Settings → Media Management`, true);
    return false;
  }

  const p = openDialog(
    `<form method="dialog" class="arr-form">
      <div>
        <h2>${il ? `Edit in ${name}` : `Add to ${name}`}</h2>
        <p class="muted" style="margin:4px 0 0">Creates the import list <b>Courarr – ${esc(list.name)}</b> pointing at this list’s feed.</p>
      </div>
      <div class="field">
        <label for="arr-root">Root folder</label>
        ${sel('arr-root', opts.rootFolders.map((r) => [r.path, `${r.path}  ${gb(r.freeSpace)}`]), cur.rootFolderPath)}
      </div>
      <div class="field">
        <label for="arr-qp">Quality profile</label>
        ${sel('arr-qp', opts.qualityProfiles.map((q) => [q.id, q.name]), cur.qualityProfileId)}
      </div>
      ${
        kind === 'sonarr'
          ? `<div class="field">
              <span class="label">Series type</span>
              <div class="seg" id="arr-type">${Object.entries(SERIES_TYPES)
                .map(([v, l]) => `<button type="button" data-v="${v}" class="${cur.seriesType === v ? 'on' : ''}">${l}${v === rec ? ' ✓' : ''}</button>`)
                .join('')}</div>
              <span class="hint" id="arr-type-hint"></span>
            </div>
            <div class="field">
              <label for="arr-mon">Monitor</label>
              ${sel('arr-mon', Object.entries(SONARR_MONITOR), cur.monitor)}
            </div>
            <label class="check"><input type="checkbox" id="arr-sf"${cur.seasonFolder ? ' checked' : ''} /><span><b>Season folders</b></span></label>`
          : `<div class="row">
              <div class="field"><label for="arr-mon">Monitor</label>${sel('arr-mon', Object.entries(RADARR_MONITOR), cur.monitor)}</div>
              <div class="field"><label for="arr-avail">Minimum availability</label>${sel('arr-avail', Object.entries(RADARR_AVAIL), cur.minimumAvailability)}</div>
            </div>`
      }
      <label class="check"><input type="checkbox" id="arr-search"${cur.searchOnAdd ? ' checked' : ''} />
        <span><b>Search as soon as a title is added</b><span class="hint">Otherwise ${name} waits for new releases via RSS.</span></span></label>
      ${
        opts.tags.length
          ? `<div class="field"><span class="label">Tags</span><div class="chips" id="arr-tags">${opts.tags
              .map((t) => `<button type="button" class="chip${cur.tags.includes(t.id) ? ' on' : ''}" data-id="${t.id}">${esc(t.label)}</button>`)
              .join('')}</div></div>`
          : ''
      }
      <div class="actions">
        ${il ? `<button class="btn btn-ghost btn-danger" value="remove" style="margin-right:auto">Remove from ${name}</button>` : ''}
        <button class="btn btn-ghost" value="cancel">Cancel</button>
        <button class="btn btn-primary" value="save">${il ? 'Save' : `Add to ${name}`}</button>
      </div>
    </form>`,
    async (action) => {
      if (action === 'remove') {
        if (!confirm(`Remove the “Courarr – ${list.name}” import list from ${name}? Titles it already added stay in your library.`)) return false;
        await api(`/api/lists/${list.id}/arr`, { method: 'DELETE' }).catch((e) => toast(e.message, true));
        toast(`Removed from ${name}`);
        return true;
      }
      if (action !== 'save') return false;
      const body = {
        rootFolderPath: dialog.querySelector('#arr-root').value,
        qualityProfileId: Number(dialog.querySelector('#arr-qp').value),
        monitor: dialog.querySelector('#arr-mon').value,
        searchOnAdd: dialog.querySelector('#arr-search').checked,
        tags: [...dialog.querySelectorAll('#arr-tags .chip.on')].map((c) => Number(c.dataset.id)),
      };
      if (kind === 'sonarr') {
        body.seriesType = dialog.querySelector('#arr-type .on')?.dataset.v || rec;
        body.seasonFolder = dialog.querySelector('#arr-sf').checked;
      } else {
        body.minimumAvailability = dialog.querySelector('#arr-avail').value;
      }
      try {
        await api(`/api/lists/${list.id}/arr`, { method: 'PUT', body });
        toast(il ? `${name} import list updated` : `Added to ${name} — it will import the feed on its next list sync`);
        return true;
      } catch (e) {
        toast(e.message, true);
        return false;
      }
    },
  );

  const typeHint = () => {
    const el = dialog.querySelector('#arr-type-hint');
    if (!el) return;
    const v = dialog.querySelector('#arr-type .on')?.dataset.v;
    el.innerHTML =
      v === rec
        ? 'Matches this list’s series type.'
        : `<span class="warn-text">This list is built for ${SERIES_TYPES[rec]} series (see “Sonarr series type” on the list). ${
            v === 'anime' ? 'Anime type uses absolute episode numbering.' : v === 'daily' ? 'Daily type expects date-based episodes.' : 'Standard type expects season/episode numbering.'
          }</span>`;
  };
  typeHint();
  dialog.querySelector('#arr-type')?.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    dialog.querySelectorAll('#arr-type button').forEach((x) => x.classList.toggle('on', x === b));
    typeHint();
  });
  dialog.querySelector('#arr-tags')?.addEventListener('click', (e) => e.target.closest('.chip')?.classList.toggle('on'));
  return p;
}

// ---------- settings ----------

const SCHEDULES = [
  ['0 3 * * *', 'Every day at 3 AM'],
  ['0 */12 * * *', 'Every 12 hours'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 3 * * 1', 'Every Monday at 3 AM'],
  ['', 'Off — manual refresh only'],
];

async function viewSettings() {
  await loadSettings();
  state.status = await api('/api/status');
  const s = state.settings;
  const st = state.status;
  const preset = SCHEDULES.some(([v]) => v === s.schedule) ? s.schedule : 'custom';
  const origin = location.origin;

  const keyPlaceholder = (kind, hint) => (s[`${kind}ApiKeySet`] ? 'Saved — leave blank to keep' : hint);
  const testRow = (kind) => `
    <div class="row" style="flex:none">
      <button type="button" class="btn btn-sm" data-test="${kind}" style="flex:none">Test</button>
      <span class="test-result" id="${kind}-test"></span>
      ${s[`${kind}ApiKeySet`] ? `<button type="button" class="btn btn-sm btn-ghost btn-danger" data-clear="${kind}" style="flex:none">Forget key</button>` : ''}
    </div>`;

  const arrPanel = (kind) => `
    <div class="panel">
      <div class="panel-head"><span class="pill ${kind}">${kind}</span><div><h2>${ARR[kind]}</h2><p>Optional — lets Courarr add lists to ${ARR[kind]} for you, show “in library” badges and sync instantly.</p></div></div>
      <div class="panel-body">
        <div class="field">
          <label for="${kind}-url">URL</label>
          <input class="input" id="${kind}-url" name="${kind}Url" value="${esc(s[`${kind}Url`])}" placeholder="http://192.168.1.10:${kind === 'sonarr' ? 8989 : 7878}" />
        </div>
        <div class="field">
          <label for="${kind}-key">API key</label>
          <input class="input mono" id="${kind}-key" name="${kind}ApiKey" type="password" autocomplete="new-password"
            placeholder="${keyPlaceholder(kind, `${ARR[kind]} → Settings → General → API Key`)}" />
        </div>
        ${testRow(kind)}
      </div>
    </div>`;

  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Server time zone: ${esc(st.timezone)} · Courarr ${esc(st.version)}</p></div></div>
    <form id="settings-form" autocomplete="off">
      <div class="settings">
        <div class="panel">
          <div class="panel-head"><div><h2>Refresh schedule</h2><p>When Courarr re-runs every enabled list. You can always refresh by hand.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="sched-preset">Schedule</label>
              <select class="select" id="sched-preset">
                ${SCHEDULES.map(([v, l]) => `<option value="${v}"${preset === v ? ' selected' : ''}>${l}</option>`).join('')}
                <option value="custom"${preset === 'custom' ? ' selected' : ''}>Custom (cron)…</option>
              </select>
            </div>
            <div class="field${preset === 'custom' ? '' : ' hidden'}" id="cron-field">
              <label for="cron">Cron expression</label>
              <input class="input mono" id="cron" name="schedule" value="${esc(s.schedule)}" placeholder="0 3 * * *" />
              <span class="hint">minute hour day month weekday — e.g. <code>30 4 * * *</code> is 4:30 AM daily.</span>
            </div>
            <span class="hint">${st.nextRun ? `Next run: ${esc(new Date(st.nextRun).toLocaleString())}` : 'No scheduled runs.'}</span>
          </div>
        </div>

        <div class="panel" id="security">
          <div class="panel-head"><div><h2>Login & security</h2><p>Signed in as <b>${esc(s.authUser)}</b>.</p></div></div>
          <div class="panel-body">
            <div class="field"><label for="acc-user">Username</label><input class="input" id="acc-user" value="${esc(s.authUser)}" autocomplete="username" /></div>
            <div class="row">
              <div class="field"><label for="acc-new">New password</label><input class="input" id="acc-new" type="password" autocomplete="new-password" placeholder="leave blank to keep" /></div>
              <div class="field"><label for="acc-new2">Confirm</label><input class="input" id="acc-new2" type="password" autocomplete="new-password" /></div>
            </div>
            <div class="field"><label for="acc-cur">Current password</label><input class="input" id="acc-cur" type="password" autocomplete="current-password" placeholder="needed to change either" /></div>
            <div class="row" style="flex:none"><button type="button" class="btn btn-sm" id="acc-save" style="flex:none">Update login</button><span class="hint">Changing the password signs out every other browser.</span></div>
            <div class="field">
              <span class="label">API key <span class="label-note">— for scripts, e.g. <code>curl -X POST -H "X-Api-Key: …" …/api/refresh</code></span></span>
              <div class="feed"><code id="api-key">${esc(s.apiKey)}</code>
                <button type="button" class="btn btn-ghost btn-sm btn-icon" data-copy-text="${esc(s.apiKey)}" title="Copy">${icon('copy')}</button>
                <button type="button" class="btn btn-ghost btn-sm" data-regen="api">New key</button></div>
            </div>
            <label class="check"><input type="checkbox" name="feedKeyRequired"${s.feedKeyRequired ? ' checked' : ''} />
              <span><b>Protect feed URLs with a key</b><span class="hint">Feeds must be readable by Sonarr/Radarr without logging in. With this on, each feed URL carries a secret <code>?key=…</code>. Import lists Courarr created are updated automatically; update any you added by hand.</span></span></label>
            <div class="row" style="flex:none">
              ${s.feedKeyRequired ? '<button type="button" class="btn btn-sm btn-ghost" data-regen="feed" style="flex:none">New feed key</button>' : ''}
              <a class="btn btn-sm btn-ghost" href="#/setup/arr" style="flex:none">Run the setup guide again</a>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><span class="pill normal">TMDB</span><div><h2>TMDB</h2><p>Needed for TV & movie lists. Free: themoviedb.org → Settings → API.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="tmdb-key">API key or Read Access Token</label>
              <input class="input mono" id="tmdb-key" name="tmdbApiKey" type="password" autocomplete="new-password"
                placeholder="${keyPlaceholder('tmdb', 'Paste either the API key or the long read access token')}" />
            </div>
            <div class="field">
              <label for="tmdb-region">Your region</label>
              <select class="select" id="tmdb-region" name="tmdbRegion">
                ${REGIONS.map((r) => `<option value="${r}"${s.tmdbRegion === r ? ' selected' : ''}>${r}</option>`).join('')}
              </select>
              <span class="hint">Default region for streaming services and digital release dates. Lists can override it.</span>
            </div>
            <div class="field">
              <span class="label">Default original languages <span class="label-note">— for new TV & movie lists</span></span>
              <div class="chips" id="def-langs">${LANG_CHOICES.map(([c, l]) => `<button type="button" class="chip${(s.defaultLanguages || []).includes(c) ? ' on' : ''}" data-lang="${c}">${l}</button>`).join('')}</div>
              <span class="hint">Keeps foreign-language originals (e.g. French Netflix series) out unless a list asks for them.</span>
            </div>
            ${testRow('tmdb')}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Scores</h2><p>IMDb, Rotten Tomatoes and Metacritic scores for filters and title cards.</p></div></div>
          <div class="panel-body">
            ${
              st.imdb?.enabled
                ? `<div class="row" style="flex:none">
                    <span class="hint" style="flex:1">IMDb ratings: ${
                      st.imdb.titles
                        ? `${st.imdb.titles.toLocaleString()} titles from IMDb’s daily ratings file, updated ${esc(ago(st.imdb.updatedAt))}`
                        : st.imdb.updating ? 'downloading IMDb’s daily ratings file…' : 'not downloaded yet'
                    }${st.imdb.error ? ` — <span style="color:var(--err)">${esc(st.imdb.error)}</span>` : ''}. No key needed.</span>
                    <button type="button" class="btn btn-sm" id="imdb-update" style="flex:none">${icon('refresh')}Update now</button>
                  </div>`
                : ''
            }
            <div class="field">
              <label for="omdb-key">OMDb API key <span class="label-note">— for Rotten Tomatoes & Metacritic</span></label>
              <input class="input mono" id="omdb-key" name="omdbApiKey" type="password" autocomplete="new-password" placeholder="${keyPlaceholder('omdb', 'e.g. a1b2c3d4')}" />
              <span class="hint">Free key (1,000 lookups a day) from omdbapi.com/apikey.aspx. Scores are cached for a week, so a handful of lists stays well inside the free limit.</span>
            </div>
            ${testRow('omdb')}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Maintainerr</h2><p>Skip titles your Maintainerr rules flag — e.g. abandoned series — in every list.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="mt-url">URL</label>
              <input class="input" id="mt-url" name="maintainerrUrl" value="${esc(s.maintainerrUrl)}" placeholder="http://192.168.1.10:6246" />
            </div>
            <div class="field">
              <label for="mt-key">API key <span class="label-note">— only if your Maintainerr requires one</span></label>
              <input class="input mono" id="mt-key" name="maintainerrApiKey" type="password" autocomplete="new-password" placeholder="${keyPlaceholder('maintainerr', 'Leave blank if Maintainerr has no API key')}" />
            </div>
            ${testRow('maintainerr')}
            <div class="field">
              <span class="label">Ignore titles in these collections</span>
              <div id="mt-collections" class="mt-cols"><span class="hint">${s.maintainerrUrl ? 'Loading collections…' : 'Enter the URL and press Test to list your collections.'}</span></div>
            </div>
            <label class="check"><input type="checkbox" name="maintainerrStopNewSeasons"${s.maintainerrStopNewSeasons ? ' checked' : ''} />
              <span><b>Stop new seasons of these shows in Sonarr</b><span class="hint">At each refresh, shows in the chosen collections stop monitoring new seasons, and seasons with nothing downloaded yet are unmonitored. Episodes you already have are untouched.</span></span></label>
            <div class="row" style="flex:none">
              <span class="hint" style="flex:1">Courarr re-reads the collections at every refresh, so a show you start watching again stops being ignored. Maintainerr’s own “add to import list exclusions” covers anything it deletes.</span>
              <button type="button" class="btn btn-sm" id="mt-sync" style="flex:none">${icon('refresh')}Sync now</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Notifications</h2><p>Hear about new titles going to Sonarr/Radarr, and about refresh problems.</p></div></div>
          <div class="panel-body">
            <label class="check"><input type="checkbox" name="notifyOnNew"${s.notifyOnNew ? ' checked' : ''} /><span><b>New titles added to a list’s feed</b><span class="hint">Per list, can be turned off in the list’s Ranking & output section.</span></span></label>
            <label class="check"><input type="checkbox" name="notifyOnError"${s.notifyOnError ? ' checked' : ''} /><span><b>Refresh failures</b></span></label>
            <div id="notifiers"></div>
            <div class="row" style="flex:none">
              <select class="select" id="nt-type" style="flex:none;width:180px">${Object.entries(NOTIFIER_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
              <button type="button" class="btn btn-sm" id="nt-add" style="flex:none">${icon('plus')}Add</button>
            </div>
          </div>
        </div>

        ${arrPanel('sonarr')}
        ${arrPanel('radarr')}

        <div class="panel">
          <div class="panel-head"><div><h2>Anime lists</h2><p>How seasons, titles and IDs are handled for AniList lists.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="rollover">Switch to the next season this many days early</label>
              <input class="input" id="rollover" name="seasonRolloverDays" type="number" min="0" max="45" value="${esc(s.seasonRolloverDays)}" />
              <span class="hint">“This season” is currently <b>${esc(st.currentSeason)}</b>. Shows are announced and mapped before they air, so a head start helps.</span>
            </div>
            <div class="field">
              <label for="lang">Titles</label>
              <select class="select" id="lang" name="titleLanguage">
                <option value="english"${s.titleLanguage === 'english' ? ' selected' : ''}>English (fall back to romaji)</option>
                <option value="romaji"${s.titleLanguage === 'romaji' ? ' selected' : ''}>Romaji</option>
              </select>
            </div>
            <label class="check"><input type="checkbox" name="arrLookupFallback"${s.arrLookupFallback ? ' checked' : ''} />
              <span><b>Search Sonarr/Radarr by title when the mapping has no ID</b><span class="hint">Exact title + year matches only. Needs a connection.</span></span></label>
            <div class="row" style="flex:none">
              <span class="hint" style="flex:1">Anime ID mapping: ${st.mapping.entries.toLocaleString()} entries, updated ${esc(ago(st.mapping.updatedAt))}${st.mapping.lastError ? ` — <span style="color:var(--err)">${esc(st.mapping.lastError)}</span>` : ''}</span>
              <button type="button" class="btn btn-sm" id="map-update" style="flex:none">${icon('refresh')}Update now</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Feeds</h2><p>How Sonarr and Radarr reach Courarr.</p></div></div>
          <div class="panel-body">
            <div class="field">
              <label for="feed-base">Feed base URL</label>
              <input class="input" id="feed-base" name="feedBaseUrl" value="${esc(s.feedBaseUrl)}" placeholder="${esc(origin)}" />
              <span class="hint">The address Sonarr/Radarr use to reach Courarr. Leave blank to use this page’s address.</span>
            </div>
            <label class="check"><input type="checkbox" name="triggerArrSync"${s.triggerArrSync ? ' checked' : ''} />
              <span><b>Tell Sonarr/Radarr to sync import lists after a refresh</b><span class="hint">Otherwise they pick up changes on their own list interval (Radarr: every 12h minimum).</span></span></label>
            <ol class="steps">
              <li>With a connection above, open a list and click <b>Add to Sonarr/Radarr</b>. Each list is added with its own series type — <b>Anime</b>, <b>Standard</b> or <b>Daily</b> (set on the list).</li>
              <li>Without one: Sonarr → Settings → Import Lists → + → <b>Custom List</b> (set Series Type yourself); Radarr → <b>Custom Lists</b>. Paste the feed URL from the list card.</li>
            </ol>
          </div>
        </div>
      </div>
      <div class="save-bar"><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>`;

  const form = document.getElementById('settings-form');

  // --- Maintainerr collections ---
  let mtCollectionsLoaded = false;
  const renderCollections = (cols) => {
    const chosen = new Set(s.maintainerrCollections || []);
    const box = form.querySelector('#mt-collections');
    mtCollectionsLoaded = true;
    box.innerHTML = cols.length
      ? cols
          .map(
            (c) => `<label class="check${c.supported ? '' : ' disabled'}"><input type="checkbox" name="mtCollection" value="${c.id}"${chosen.has(c.id) && c.supported ? ' checked' : ''}${c.supported ? '' : ' disabled'} />
              <span><b>${esc(c.title)}</b><span class="hint">${c.type} · ${c.count} title${c.count === 1 ? '' : 's'}${c.active ? '' : ' · inactive'}${c.supported ? '' : ' — season collections manage parts of a show, so they can’t be used here'}</span></span></label>`,
          )
          .join('')
      : '<span class="hint">Maintainerr has no collections yet.</span>';
  };
  if (s.maintainerrUrl) {
    api('/api/maintainerr/collections')
      .then(renderCollections)
      .catch((err) => {
        form.querySelector('#mt-collections').innerHTML = `<span class="hint" style="color:var(--err)">${esc(err.message)}</span>`;
      });
  }

  // --- notifiers ---
  const notifiers = structuredClone(s.notifiers || []);
  const renderNotifiers = () => {
    form.querySelector('#notifiers').innerHTML = notifiers
      .map((n, i) => {
        const t = NOTIFIER_TYPES[n.type];
        return `<div class="notifier" data-i="${i}">
          <div class="row" style="flex:none">
            <b style="flex:none;min-width:90px">${t.label}</b>
            <input class="input" data-nf="name" value="${esc(n.name || '')}" placeholder="Name (optional)" />
            <label class="check" style="flex:none;align-items:center"><input type="checkbox" data-nf="enabled"${n.enabled !== false ? ' checked' : ''} /><span>On</span></label>
          </div>
          ${t.fields
            .map(([k, label, ph, secret]) => `<div class="field"><label>${label}</label><input class="input mono" data-nf="${k}" ${secret ? 'type="password" autocomplete="new-password"' : ''} value="${esc(n[k] || '')}" placeholder="${esc(ph || '')}" /></div>`)
            .join('')}
          <div class="row" style="flex:none">
            <button type="button" class="btn btn-sm" data-ntest="${i}" style="flex:none">Send test</button>
            <span class="test-result" id="nt-res-${i}"></span>
            <button type="button" class="btn btn-sm btn-ghost btn-danger" data-nremove="${i}" style="flex:none;margin-left:auto">Remove</button>
          </div>
        </div>`;
      })
      .join('');
  };
  const readNotifiers = () =>
    [...form.querySelectorAll('.notifier')].map((el) => {
      const n = { ...notifiers[Number(el.dataset.i)] };
      el.querySelectorAll('[data-nf]').forEach((inp) => (n[inp.dataset.nf] = inp.type === 'checkbox' ? inp.checked : inp.value));
      return n;
    });
  renderNotifiers();

  form.querySelector('#def-langs').addEventListener('click', (e) => e.target.closest('.chip')?.classList.toggle('on'));
  form.querySelector('#sched-preset').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    form.querySelector('#cron-field').classList.toggle('hidden', !custom);
    if (!custom) form.querySelector('#cron').value = e.target.value;
  });

  const collect = () => {
    const fd = new FormData(form);
    return {
      schedule: fd.get('schedule'),
      seasonRolloverDays: Number(fd.get('seasonRolloverDays')),
      titleLanguage: fd.get('titleLanguage'),
      feedBaseUrl: fd.get('feedBaseUrl'),
      sonarrUrl: fd.get('sonarrUrl'),
      sonarrApiKey: fd.get('sonarrApiKey'),
      radarrUrl: fd.get('radarrUrl'),
      radarrApiKey: fd.get('radarrApiKey'),
      tmdbApiKey: fd.get('tmdbApiKey'),
      tmdbRegion: fd.get('tmdbRegion'),
      defaultLanguages: [...form.querySelectorAll('#def-langs .chip.on')].map((c) => c.dataset.lang),
      omdbApiKey: fd.get('omdbApiKey'),
      maintainerrUrl: fd.get('maintainerrUrl'),
      maintainerrApiKey: fd.get('maintainerrApiKey'),
      maintainerrStopNewSeasons: fd.get('maintainerrStopNewSeasons') === 'on',
      notifyOnNew: fd.get('notifyOnNew') === 'on',
      notifyOnError: fd.get('notifyOnError') === 'on',
      feedKeyRequired: fd.get('feedKeyRequired') === 'on',
      notifiers: readNotifiers(),
      ...(mtCollectionsLoaded ? { maintainerrCollections: [...form.querySelectorAll('[name="mtCollection"]:checked:not(:disabled)')].map((c) => Number(c.value)) } : {}),
      arrLookupFallback: fd.get('arrLookupFallback') === 'on',
      triggerArrSync: fd.get('triggerArrSync') === 'on',
    };
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: collect() });
      state.tmdbMeta = {};
      toast('Settings saved');
      pollStatus();
      viewSettings();
    } catch (err) {
      toast(err.message, true);
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-test],[data-clear],#map-update,#mt-sync,#nt-add,[data-ntest],[data-nremove],#acc-save,[data-regen],[data-copy-text]');
    if (!b) return;
    if (b.dataset.copyText) {
      await copyText(b.dataset.copyText);
      return;
    }
    if (b.dataset.regen) {
      const what = b.dataset.regen === 'api' ? 'API key' : 'feed key';
      if (!confirm(`Make a new ${what}? Anything using the old one stops working${b.dataset.regen === 'feed' ? ' (Courarr updates the import lists it created)' : ''}.`)) return;
      state.settings = await api(`/api/auth/keys/${b.dataset.regen}`, { method: 'POST' });
      toast(`New ${what} created`);
      viewSettings();
      return;
    }
    if (b.id === 'acc-save') {
      const v = (id) => form.querySelector(id).value;
      if (v('#acc-new') !== v('#acc-new2')) return toast('The new passwords don’t match', true);
      try {
        await api('/api/auth/account', { method: 'PUT', body: { current: v('#acc-cur'), username: v('#acc-user'), password: v('#acc-new') || undefined } });
        toast('Login updated');
        viewSettings();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    if (b.id === 'nt-add') {
      notifiers.splice(0, notifiers.length, ...readNotifiers());
      notifiers.push({ type: form.querySelector('#nt-type').value, enabled: true });
      renderNotifiers();
      return;
    }
    if (b.dataset.nremove) {
      notifiers.splice(0, notifiers.length, ...readNotifiers());
      notifiers.splice(Number(b.dataset.nremove), 1);
      renderNotifiers();
      return;
    }
    if (b.dataset.ntest) {
      const out = form.querySelector(`#nt-res-${b.dataset.ntest}`);
      out.className = 'test-result';
      out.textContent = 'Sending…';
      try {
        const r = await api('/api/notify/test', { method: 'POST', body: readNotifiers()[Number(b.dataset.ntest)] });
        out.className = `test-result ${r.ok ? 'ok' : 'err'}`;
        out.textContent = r.ok ? 'Sent — check your app' : `Failed: ${r.error}`;
      } catch (err) {
        out.className = 'test-result err';
        out.textContent = err.message;
      }
      return;
    }
    if (b.id === 'mt-sync') {
      b.disabled = true;
      try {
        await api('/api/settings', { method: 'PUT', body: collect() });
        const r = await api('/api/maintainerr/sync', { method: 'POST' });
        toast(r.length ? r.map((x) => `${x.collection}: ${x.titles}`).join(' · ') : 'No collections chosen');
      } catch (err) {
        toast(err.message, true);
      }
      b.disabled = false;
      return;
    }
    if (b.dataset.test) {
      const kind = b.dataset.test;
      const out = form.querySelector(`#${kind}-test`);
      out.className = 'test-result';
      out.textContent = 'Testing…';
      const v = collect();
      try {
        const r = await api('/api/settings/test', { method: 'POST', body: { kind, url: v[`${kind}Url`], apiKey: v[`${kind}ApiKey`] } });
        out.className = `test-result ${r.ok ? 'ok' : 'err'}`;
        out.textContent = r.ok ? `Connected to ${r.appName} ${r.version}` : `Failed: ${r.error}`;
        if (r.ok && r.collections) renderCollections(r.collections);
      } catch (err) {
        out.className = 'test-result err';
        out.textContent = err.message;
      }
    }
    if (b.dataset.clear) {
      const kind = b.dataset.clear;
      const key = `clear${kind[0].toUpperCase()}${kind.slice(1)}ApiKey`;
      state.settings = await api('/api/settings', { method: 'PUT', body: { [key]: true } });
      toast('API key removed');
      viewSettings();
    }
    if (b.id === 'imdb-update') {
      b.disabled = true;
      b.classList.add('loading');
      try {
        const m = await api('/api/imdb/update', { method: 'POST' });
        if (m.error) throw new Error(m.error);
        toast(`IMDb ratings updated — ${m.titles.toLocaleString()} titles`);
        viewSettings();
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
        b.classList.remove('loading');
      }
    }
    if (b.id === 'map-update') {
      b.disabled = true;
      b.classList.add('loading');
      try {
        const m = await api('/api/mapping/update', { method: 'POST' });
        toast(`Mapping updated — ${m.entries.toLocaleString()} entries`);
        viewSettings();
      } catch (err) {
        toast(err.message, true);
        b.disabled = false;
        b.classList.remove('loading');
      }
    }
  });
}

// ---------- activity ----------

async function viewActivity() {
  const [runs, overrides, ignored] = await Promise.all([api('/api/runs'), api('/api/overrides'), api('/api/ignored')]);
  view.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Recent refreshes and the anime IDs you have set by hand.</p></div></div>
    <div class="panel" style="margin-bottom:16px">
      ${
        runs.length
          ? `<table class="table">
              <thead><tr><th style="width:160px">Started</th><th style="width:100px">Trigger</th><th style="width:110px">Result</th><th>Lists</th></tr></thead>
              <tbody>${runs.map(runRow).join('')}</tbody>
            </table>`
          : '<div class="panel-body muted">No refreshes yet.</div>'
      }
    </div>
    <div class="panel" style="margin-bottom:16px">
      <div class="panel-head"><div><h2>Ignored titles</h2><p>From the Maintainerr collections chosen in Settings — never sent to Sonarr/Radarr.</p></div></div>
      ${
        ignored.length
          ? `<table class="table" style="margin-top:8px">
              <thead><tr><th>Title</th><th>Type</th><th>Why</th><th>IDs</th></tr></thead>
              <tbody>${ignored
                .map(
                  (r) => `<tr><td>${esc(r.title)}</td><td class="muted">${r.kind}</td><td class="muted">${esc(r.reason)}</td>
                    <td class="mono muted">${[r.tvdb_id && `tvdb ${r.tvdb_id}`, r.tmdb_id && `tmdb ${r.tmdb_id}`, r.imdb_id].filter(Boolean).join(' · ')}</td></tr>`,
                )
                .join('')}</tbody>
            </table>`
          : '<div class="panel-body muted">None — connect Maintainerr in Settings and pick collections to ignore.</div>'
      }
    </div>
    <div class="panel">
      <div class="panel-head"><div><h2>Manual IDs</h2><p>Set with the # button on an anime title. They win over every other match.</p></div></div>
      ${
        overrides.length
          ? `<table class="table" style="margin-top:8px">
              <thead><tr><th>Title</th><th>AniList</th><th>TVDB</th><th>TMDB</th><th></th></tr></thead>
              <tbody>${overrides
                .map(
                  (o) => `<tr>
                    <td>${esc(o.title || '—')}</td>
                    <td class="mono"><a href="https://anilist.co/anime/${o.anilist_id}" target="_blank" rel="noopener">${o.anilist_id}</a></td>
                    <td class="mono">${o.tvdb_id ?? '—'}</td>
                    <td class="mono">${o.tmdb_id ?? '—'}</td>
                    <td style="text-align:right"><button class="btn btn-sm btn-ghost btn-danger" data-del-ov="${o.anilist_id}" type="button">Remove</button></td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table>`
          : '<div class="panel-body muted">None yet.</div>'
      }
    </div>`;

  view.onclick = async (e) => {
    const b = e.target.closest('[data-del-ov]');
    if (!b) return;
    await api(`/api/overrides/${b.dataset.delOv}`, { method: 'DELETE' });
    toast('Override removed — it applies from the next refresh');
    viewActivity();
  };
}

function runRow(r) {
  const s = r.summary || {};
  const lists = (s.lists || [])
    .map((l) =>
      l.error
        ? `<span><b>${esc(l.name)}</b> — <span style="color:var(--err)">${esc(l.error)}</span></span>`
        : `<span><b>${esc(l.name)}</b> <span class="muted">${l.matched}/${l.total} matched${l.added ? ` · ${l.added} new` : ''}${l.queued ? ` · ${l.queued} queued` : ''} · ${esc(l.label)}</span></span>`,
    )
    .join('');
  const extra = [
    ...(s.warnings || []).map((w) => `<span style="color:var(--warn)">${esc(w)}</span>`),
    s.error ? `<span style="color:var(--err)">${esc(s.error)}</span>` : '',
    s.synced?.length ? `<span class="faint">Asked ${s.synced.map((k) => ARR[k]).join(' & ')} to sync</span>` : '',
    s.maintainerr?.length ? `<span class="faint">Maintainerr: ${s.maintainerr.map((m) => `${esc(m.collection)} (${m.titles})`).join(', ')}</span>` : '',
    s.stoppedNewSeasons?.length ? `<span class="faint">Stopped new seasons: ${s.stoppedNewSeasons.map(esc).join(', ')}</span>` : '',
    s.notified ? `<span class="faint">Sent ${s.notified} notification${s.notified > 1 ? 's' : ''}</span>` : '',
  ].join('');
  return `<tr>
    <td>${esc(fmtDate(r.started_at))}</td>
    <td class="muted" style="text-transform:capitalize">${esc(r.trigger)}</td>
    <td><span class="st ${esc(r.status)}">${esc(r.status)}</span></td>
    <td><div class="run-lists">${lists || '<span class="faint">No lists</span>'}${extra}</div></td>
  </tr>`;
}

// ---------- login & first-run setup ----------

/** Full-page screens (login, create account) hide the app's top bar. */
function bare(on) {
  document.body.classList.toggle('bare', on);
}

function authShell(inner) {
  return `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="auth-brand"><img src="logo.svg" alt="" width="44" height="44" /><span>Courarr</span></div>
        ${inner}
      </div>
      <p class="auth-foot">Seasonal anime, TV & movie lists for Sonarr and Radarr</p>
    </div>`;
}

function viewLogin(message) {
  bare(true);
  view.innerHTML = authShell(`
    <h1>Log in</h1>
    <form id="login-form" class="auth-form" autocomplete="on">
      <div class="field"><label for="lg-user">Username</label><input class="input" id="lg-user" name="username" autocomplete="username" required autofocus /></div>
      <div class="field"><label for="lg-pass">Password</label><input class="input" id="lg-pass" name="password" type="password" autocomplete="current-password" required /></div>
      <label class="check"><input type="checkbox" name="remember" checked /><span><b>Keep me logged in</b><span class="hint">For 30 days on this browser.</span></span></label>
      <div class="auth-error" id="lg-error">${esc(message || '')}</div>
      <button class="btn btn-primary auth-submit" type="submit">Log in</button>
      <p class="hint auth-help">Forgot it? Restart the container once with <code>COURARR_RESET_AUTH=true</code> to set a new login.</p>
    </form>`);
  const form = view.querySelector('#login-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password'), remember: fd.get('remember') === 'on' } });
      await startApp();
    } catch (err) {
      form.querySelector('#lg-error').textContent = err.message;
      btn.disabled = false;
    }
  });
}

function viewCreateAccount() {
  bare(true);
  view.innerHTML = authShell(`
    <div class="steps-mini"><span class="on">1</span> Account <i></i><span>2</span> Connections <i></i><span>3</span> Done</div>
    <h1>Welcome to Courarr</h1>
    <p class="muted">First, create the login for this Courarr. Anyone who can reach it on your network will need it.</p>
    <form id="acct-form" class="auth-form" autocomplete="on">
      <div class="field"><label for="ac-user">Username</label><input class="input" id="ac-user" name="username" autocomplete="username" required minlength="2" maxlength="40" autofocus /></div>
      <div class="field"><label for="ac-pass">Password</label><input class="input" id="ac-pass" name="password" type="password" autocomplete="new-password" required minlength="8" />
        <span class="hint">At least 8 characters.</span></div>
      <div class="field"><label for="ac-pass2">Confirm password</label><input class="input" id="ac-pass2" name="password2" type="password" autocomplete="new-password" required minlength="8" /></div>
      <div class="auth-error" id="ac-error"></div>
      <button class="btn btn-primary auth-submit" type="submit">Create account</button>
    </form>`);
  const form = view.querySelector('#acct-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const err = form.querySelector('#ac-error');
    if (fd.get('password') !== fd.get('password2')) {
      err.textContent = 'The passwords don’t match';
      return;
    }
    try {
      await api('/api/auth/setup', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      await startApp();
    } catch (e2) {
      err.textContent = e2.message;
    }
  });
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  clearTimeout(pollTimer);
  state.settings = null;
  document.getElementById('logout').hidden = true;
  // replaceState: changing the hash directly would trigger a route to the (now locked) lists.
  history.replaceState(null, '', '#/');
  viewLogin('You have been logged out.');
}

// --- the setup guide ---

const SETUP_STEPS = [
  { id: 'arr', title: 'Sonarr & Radarr' },
  { id: 'tmdb', title: 'TV & movie data' },
  { id: 'omdb', title: 'Scores' },
  { id: 'feeds', title: 'Feed address' },
  { id: 'done', title: 'Ready' },
];

function setupProgress(i) {
  return `<ol class="setup-steps">${SETUP_STEPS.map(
    (s, j) => `<li class="${j < i ? 'done' : j === i ? 'on' : ''}"><span>${j < i ? '✓' : j + 1}</span>${esc(s.title)}</li>`,
  ).join('')}</ol>`;
}

async function viewSetup(stepId) {
  bare(false);
  await loadSettings();
  const s = state.settings;
  const i = Math.max(0, SETUP_STEPS.findIndex((x) => x.id === stepId));
  const step = SETUP_STEPS[i].id;
  const go = (j) => (location.hash = `#/setup/${SETUP_STEPS[j].id}`);
  const origin = location.origin;

  const keyField = (kind, label, placeholder, help) => `
    <div class="field">
      <label for="su-${kind}-key">${label}</label>
      <input class="input mono" id="su-${kind}-key" data-key="${kind}" type="password" autocomplete="new-password"
        placeholder="${s[`${kind}ApiKeySet`] ? 'Saved — leave blank to keep' : esc(placeholder)}" />
      ${help ? `<span class="hint">${help}</span>` : ''}
    </div>`;
  const testLine = (kind) => `<div class="row" style="flex:none"><button type="button" class="btn btn-sm" data-sutest="${kind}" style="flex:none">Test</button><span class="test-result" id="su-${kind}-res">${
    s[`${kind}ApiKeySet`] ? '<span class="faint">Saved</span>' : ''
  }</span></div>`;

  let body;
  if (step === 'arr') {
    body = `
      <h2>Connect Sonarr and Radarr</h2>
      <p class="muted">Optional, but recommended. With a connection, Courarr can add each list to Sonarr/Radarr for you with the right series type, show what you already have, and find IDs for brand-new shows.
      You’ll find the API key in each app under <b>Settings → General → Security</b>.</p>
      <p class="hint">Use your server’s address (e.g. <code>http://192.168.1.10:8989</code>), not <code>localhost</code> — inside Docker, “localhost” is Courarr itself.</p>
      <div class="setup-grid">
        ${['sonarr', 'radarr']
          .map(
            (k) => `<div class="setup-box">
              <div class="row" style="flex:none;gap:8px"><span class="pill ${k}" style="flex:none">${k}</span><b style="flex:none">${ARR[k]}</b></div>
              <div class="field"><label for="su-${k}-url">URL</label><input class="input" id="su-${k}-url" data-url="${k}" value="${esc(s[`${k}Url`])}" placeholder="http://192.168.1.10:${k === 'sonarr' ? 8989 : 7878}" /></div>
              ${keyField(k, 'API key', `${ARR[k]} → Settings → General → API Key`)}
              ${testLine(k)}
            </div>`,
          )
          .join('')}
      </div>`;
  } else if (step === 'tmdb') {
    body = `
      <h2>TV & movie data (TMDB)</h2>
      <p class="muted"><b>Anime lists work without this.</b> For regular TV and movie lists — and age ratings on anime — Courarr needs a free key from The Movie Database.</p>
      <ol class="how">
        <li>Sign up at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a> (free).</li>
        <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Settings → API</a> and request a <b>Developer</b> key (any app name and URL will do).</li>
        <li>Copy either the <b>API Key</b> or the long <b>API Read Access Token</b> and paste it here.</li>
      </ol>
      ${keyField('tmdb', 'TMDB API key or Read Access Token', 'Paste the key or token')}
      ${testLine('tmdb')}
      <div class="row">
        <div class="field">
          <label for="su-region">Your region</label>
          <select class="select" id="su-region">${REGIONS.map((r) => `<option value="${r}"${s.tmdbRegion === r ? ' selected' : ''}>${r}</option>`).join('')}</select>
          <span class="hint">For streaming services, age ratings and digital release dates.</span>
        </div>
      </div>
      <div class="field">
        <span class="label">Original languages you watch</span>
        <div class="chips" id="su-langs">${LANG_CHOICES.map(([c, l]) => `<button type="button" class="chip${(s.defaultLanguages || []).includes(c) ? ' on' : ''}" data-lang="${c}">${l}</button>`).join('')}</div>
        <span class="hint">New TV & movie lists start with these, so foreign-language originals (e.g. French Netflix series) stay out unless you ask for them.</span>
      </div>`;
  } else if (step === 'omdb') {
    body = `
      <h2>Critic & audience scores (OMDb)</h2>
      <p class="muted">Optional. IMDb ratings already work without a key (Courarr downloads IMDb’s daily ratings file). An OMDb key adds <b>Rotten Tomatoes and Metacritic</b> scores for filters and title cards.</p>
      <ol class="how">
        <li>Get a free key at <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" rel="noopener">omdbapi.com/apikey.aspx</a> (choose <b>FREE</b>, 1,000 lookups a day).</li>
        <li>Click the activation link OMDb emails you, then paste the key here.</li>
      </ol>
      ${keyField('omdb', 'OMDb API key', 'e.g. a1b2c3d4')}
      ${testLine('omdb')}`;
  } else if (step === 'feeds') {
    body = `
      <h2>How Sonarr & Radarr reach Courarr</h2>
      <p class="muted">Each list is a feed URL that Sonarr/Radarr read. Enter the address <b>they</b> can reach Courarr at.</p>
      <div class="field">
        <label for="su-feedbase">Feed base URL</label>
        <input class="input" id="su-feedbase" value="${esc(s.feedBaseUrl)}" placeholder="${esc(origin)}" />
        <span class="hint">Blank uses this page’s address (<code>${esc(origin)}</code>) — fine when Sonarr/Radarr run on the same network.
        If they share a Docker network with Courarr, use its container name, e.g. <code>http://courarr:6161</code>.</span>
      </div>
      <label class="check"><input type="checkbox" id="su-feedkey"${s.feedKeyRequired ? ' checked' : ''} />
        <span><b>Protect feed URLs with a key</b><span class="hint">Feeds are readable without logging in (Sonarr/Radarr can’t log in). With this on, each feed URL carries a secret <code>?key=…</code>; lists added from Courarr get it automatically.</span></span></label>`;
  } else {
    const have = (k) => !!s[`${k}ApiKeySet`];
    const item = (on, text, off) => `<li class="${on ? 'ok' : ''}"><span>${on ? '✓' : '–'}</span>${on ? text : off}</li>`;
    body = `
      <h2>You’re set up</h2>
      <ul class="setup-summary">
        ${item(true, '<b>Anime lists</b> from AniList — no key needed')}
        ${item(have('tmdb'), '<b>TV & movie lists</b> from TMDB', 'TV & movie lists need a TMDB key — add it any time in Settings')}
        ${item(have('sonarr') || have('radarr'), `<b>One-click “Add to ${[have('sonarr') && 'Sonarr', have('radarr') && 'Radarr'].filter(Boolean).join(' / ')}”</b> and library badges`, 'Without a Sonarr/Radarr connection you copy each feed URL into them yourself')}
        ${item(have('omdb'), '<b>Critic & audience score</b> filters', 'Score filters need an OMDb key')}
      </ul>
      <p class="muted">Also in <a href="#/settings">Settings</a>: the refresh schedule (daily at 3 AM), Maintainerr, notifications, and your API key for scripts.</p>
      <div class="templates" style="margin-top:14px">
        ${TEMPLATES.filter((t) => t.source === 'anilist' || have('tmdb'))
          .slice(0, 4)
          .map((t) => `<div class="template" data-template="${TEMPLATES.indexOf(t)}" role="button" tabindex="0"><span class="row" style="flex:none;gap:6px"><span class="pill ${t.source === 'anilist' ? 'anime' : 'normal'}" style="flex:none">${SOURCE_NAMES[t.source]}</span><span class="pill ${t.target}" style="flex:none">${t.target}</span></span><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`)
          .join('')}
      </div>`;
  }

  view.innerHTML = `
    <div class="setup">
      <div class="page-head"><div><h1>Set up Courarr</h1><p>A few connections and you’re ready — every step can be changed later in Settings.</p></div></div>
      ${setupProgress(i)}
      <div class="panel setup-panel"><div class="panel-body">${body}</div>
        <div class="setup-foot">
          ${i > 0 ? '<button type="button" class="btn btn-ghost" data-su="back">Back</button>' : ''}
          <span class="spacer"></span>
          ${step === 'done' ? '<button type="button" class="btn btn-primary" data-su="finish">Go to my lists</button>' : `
            <button type="button" class="btn btn-ghost" data-su="skip">Skip</button>
            <button type="button" class="btn btn-primary" data-su="next">Save & continue</button>`}
        </div>
      </div>
    </div>`;

  // Collect only what this step shows; blank keys keep the saved ones.
  const collect = () => {
    const out = {};
    view.querySelectorAll('[data-url]').forEach((el) => (out[`${el.dataset.url}Url`] = el.value.trim()));
    view.querySelectorAll('[data-key]').forEach((el) => el.value.trim() && (out[`${el.dataset.key}ApiKey`] = el.value.trim()));
    if (step === 'tmdb') {
      out.tmdbRegion = view.querySelector('#su-region').value;
      out.defaultLanguages = [...view.querySelectorAll('#su-langs .chip.on')].map((c) => c.dataset.lang);
    }
    if (step === 'feeds') {
      out.feedBaseUrl = view.querySelector('#su-feedbase').value.trim();
      out.feedKeyRequired = view.querySelector('#su-feedkey').checked;
    }
    return out;
  };
  const test = async (kind) => {
    const out = view.querySelector(`#su-${kind}-res`);
    out.className = 'test-result';
    out.textContent = 'Testing…';
    const v = collect();
    try {
      const r = await api('/api/settings/test', { method: 'POST', body: { kind, url: v[`${kind}Url`], apiKey: v[`${kind}ApiKey`] } });
      out.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      out.textContent = r.ok ? `Connected to ${r.appName} ${r.version}` : `Failed: ${r.error}`;
      return r.ok;
    } catch (e) {
      out.className = 'test-result err';
      out.textContent = e.message;
      return false;
    }
  };
  // Kinds on this step the user actually filled in (a URL or a new key).
  const filled = () => {
    const v = collect();
    return ['sonarr', 'radarr', 'tmdb', 'omdb'].filter((k) => view.querySelector(`[data-key="${k}"]`) && (v[`${k}ApiKey`] || (v[`${k}Url`] && v[`${k}Url`] !== s[`${k}Url`])));
  };

  view.querySelector('#su-langs')?.addEventListener('click', (e) => e.target.closest('.chip')?.classList.toggle('on'));
  let forced = false;
  view.onclick = async (e) => {
    const t = e.target.closest('[data-sutest],[data-su],[data-template]');
    if (!t) return;
    if (t.dataset.sutest) return test(t.dataset.sutest);
    if (t.dataset.template) {
      await api('/api/settings', { method: 'PUT', body: { setupComplete: true } });
      location.hash = `#/lists/new?template=${t.dataset.template}`;
      return;
    }
    const action = t.dataset.su;
    if (action === 'back') return go(i - 1);
    if (action === 'skip') return go(i + 1);
    if (action === 'finish') {
      await api('/api/settings', { method: 'PUT', body: { setupComplete: true } });
      await loadSettings();
      location.hash = '#/';
      return;
    }
    // Save & continue: test anything newly entered first, but let people go on regardless.
    t.disabled = true;
    const failed = [];
    for (const k of filled()) if (!(await test(k))) failed.push(ARR[k] || k.toUpperCase());
    if (failed.length && !forced) {
      forced = true;
      t.disabled = false;
      t.textContent = 'Save anyway';
      toast(`${failed.join(' & ')} didn’t connect — check the details, or save anyway and fix it later`, true);
      return;
    }
    try {
      await api('/api/settings', { method: 'PUT', body: collect() });
      go(i + 1);
    } catch (err) {
      toast(err.message, true);
      t.disabled = false;
    }
  };
}

/** Called once the browser is logged in: loads settings and shows the app (or the setup guide). */
async function startApp() {
  bare(false);
  await loadSettings();
  document.getElementById('logout').hidden = false;
  pollStatus();
  if (!state.settings.setupComplete && !location.hash.startsWith('#/setup')) location.hash = '#/setup/arr';
  else route();
}

async function boot() {
  let st;
  try {
    const res = await fetch('/api/auth/status');
    if (checkBuild(res)) return;
    st = await res.json();
  } catch {
    view.innerHTML = '<div class="empty"><h2>Can’t reach Courarr</h2><p>Is the container running?</p></div>';
    return;
  }
  if (!st.configured) return viewCreateAccount();
  if (!st.authenticated) return viewLogin();
  await startApp();
}

// ---------- boot ----------

document.getElementById('logout').addEventListener('click', logout);
boot();
