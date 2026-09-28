// Courarr web UI — plain ES modules, no build step.

const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, opts = {}) {
  const init = { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
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
  toast('Feed URL copied');
}

const FORMAT_NAMES = { TV: 'TV', TV_SHORT: 'TV Short', ONA: 'ONA', OVA: 'OVA', MOVIE: 'Movie', SPECIAL: 'Special', MUSIC: 'Music' };
const STATUS_NAMES = { RELEASING: 'Airing', NOT_YET_RELEASED: 'Upcoming', FINISHED: 'Finished', CANCELLED: 'Cancelled', HIATUS: 'Hiatus' };
const SORT_NAMES = { POPULARITY_DESC: 'Popularity', SCORE_DESC: 'Score', TRENDING_DESC: 'Trending', FAVOURITES_DESC: 'Favourites', START_DATE_DESC: 'Newest' };
const COUNTRIES = { JP: 'Japan', CN: 'China', KR: 'Korea', TW: 'Taiwan' };
const SEASON_MODES = {
  current: 'This season',
  next: 'Next season',
  previous: 'Last season',
  specific: 'A specific season',
  currentYear: 'This year',
  year: 'A specific year',
  none: 'Any time',
};
const SOURCES = {
  mapping: ['Mapped', 'ID from the anime mapping database'],
  prequel: ['Via prequel', 'Sequel — uses the earlier season’s series'],
  imdb: ['Via IMDb', 'Found in Radarr by IMDb ID'],
  lookup: ['Title match', 'Found by exact title search in Sonarr/Radarr'],
  override: ['Manual', 'ID you set by hand'],
};
const ARR = { sonarr: 'Sonarr', radarr: 'Radarr' };
const FALLBACK_GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];

const TEMPLATES = [
  {
    name: 'Popular this season',
    target: 'sonarr',
    desc: 'Top 50 TV & ONA anime airing this season.',
    filters: { season: { mode: 'current' }, formats: ['TV', 'TV_SHORT', 'ONA'], countries: ['JP'], limit: 50 },
  },
  {
    name: 'New shows next season',
    target: 'sonarr',
    desc: 'Upcoming season, first seasons only — no sequels.',
    filters: { season: { mode: 'next' }, formats: ['TV', 'ONA'], countries: ['JP'], sequels: 'exclude', limit: 30 },
  },
  {
    name: 'Anime movies this year',
    target: 'radarr',
    desc: 'Popular anime films released this year.',
    filters: { season: { mode: 'currentYear' }, formats: ['MOVIE'], countries: ['JP'], limit: 25 },
  },
];

// ---------- global state ----------

const state = { settings: null, meta: null, status: null };

async function loadSettings() {
  state.settings = await api('/api/settings');
}

async function ensureMeta() {
  if (state.meta) return state.meta;
  try {
    state.meta = await api('/api/meta');
  } catch (e) {
    toast(`Couldn't load genres/tags from AniList: ${e.message}`, true);
    const d = {
      season: { mode: 'current' }, statuses: [], countries: ['JP'], genresInclude: [], genresExclude: [],
      tagsInclude: [], tagsExclude: [], minPopularity: 0, minScore: 0, sequels: 'include', sort: 'POPULARITY_DESC', limit: 50,
    };
    return {
      genres: FALLBACK_GENRES,
      tags: [],
      defaults: {
        sonarr: { ...d, formats: ['TV', 'TV_SHORT', 'ONA'] },
        radarr: { ...d, season: { mode: 'currentYear' }, formats: ['MOVIE'] },
      },
    };
  }
  return state.meta;
}

const feedUrl = (slug) => `${state.settings?.feedBaseUrl || location.origin}/feed/${slug}`;
const arrConnected = (target) => !!(state.settings?.[`${target}Url`] && state.settings?.[`${target}ApiKeySet`]);

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
  statusEl.title = `Mapping: ${s.mapping.entries.toLocaleString()} entries, updated ${ago(s.mapping.updatedAt)}\nTimezone: ${s.timezone}`;
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
  [/^#\/lists\/(\d+)$/, (m, t) => viewEditor(Number(m[1]), null, t)],
  [/^#\/settings$/, () => viewSettings()],
  [/^#\/activity$/, () => viewActivity()],
];

async function route() {
  const hash = location.hash || '#/';
  const section = hash.startsWith('#/settings') ? 'settings' : hash.startsWith('#/activity') ? 'activity' : 'lists';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const token = ++renderToken;
  view.onclick = null;
  view.oninput = null;
  view.onsubmit = null;
  view.onkeydown = null;
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

function describe(f, seasonLabel) {
  const parts = [seasonLabel];
  parts.push(f.formats.length ? f.formats.map((x) => FORMAT_NAMES[x] || x).join(', ') : 'All formats');
  if (f.sequels === 'exclude') parts.push('no sequels');
  if (f.sequels === 'only') parts.push('sequels only');
  const g = f.genresInclude.length + f.genresExclude.length + f.tagsInclude.length + f.tagsExclude.length;
  if (g) parts.push(`${g} genre/tag filter${g > 1 ? 's' : ''}`);
  parts.push(`top ${f.limit} by ${SORT_NAMES[f.sort].toLowerCase()}`);
  return parts.join(' · ');
}

async function viewLists() {
  const [lists] = await Promise.all([api('/api/lists'), state.settings ? null : loadSettings()]);
  if (!state.status) state.status = await api('/api/status');
  const st = state.status;

  const head = `
    <div class="page-head">
      <div>
        <h1>Lists</h1>
        <p>Current season: <b>${esc(st.currentSeason)}</b> · next up: ${esc(st.nextSeason)}</p>
      </div>
      <div class="page-actions">
        <a class="btn" href="#/lists/new?target=radarr">${icon('plus')}Radarr list</a>
        <a class="btn btn-primary" href="#/lists/new?target=sonarr">${icon('plus')}Sonarr list</a>
      </div>
    </div>`;

  if (!lists.length) {
    view.innerHTML = `${head}
      <div class="empty">
        <h2>No lists yet</h2>
        <p>Each list is a saved AniList search. Courarr turns the results into a feed URL that Sonarr or Radarr imports.<br>Start from a template or build your own.</p>
        <div class="templates">
          ${TEMPLATES.map(
            (t, i) => `<div class="template" data-template="${i}" role="button" tabindex="0">
              <span class="pill ${t.target}" style="align-self:flex-start">${t.target}</span>
              <b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>`,
          ).join('')}
        </div>
      </div>`;
  } else {
    view.innerHTML = `${head}<div class="cards">${lists.map(listCard).join('')}</div>`;
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
          <span class="pill ${l.target}">${l.target}</span>
          <a href="#/lists/${l.id}">${esc(l.name)}</a>
          ${l.enabled ? '' : '<span class="pill off">Paused</span>'}
        </div>
        <div class="card-meta">${esc(describe(l.filters, l.seasonLabel))}</div>
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
        <span class="when">${l.last_refresh ? `Refreshed ${ago(l.last_refresh)}` : 'Not refreshed yet'}</span>
        <button class="btn btn-sm" data-refresh="${l.id}" type="button">${icon('refresh')}Refresh</button>
        <a class="btn btn-sm btn-ghost" href="#/lists/${l.id}">${icon('edit')}Edit</a>
      </div>
    </article>`;
}

// ---------- editor ----------

async function viewEditor(id, params, token) {
  view.innerHTML = loadingBlock('Loading…');
  const [meta] = await Promise.all([ensureMeta(), state.settings ? null : loadSettings()]);
  let saved = null;
  if (id) saved = await api(`/api/lists/${id}`);
  if (token !== renderToken) return;

  let draft;
  if (saved) {
    draft = { name: saved.name, slug: saved.slug, target: saved.target, filters: structuredClone(saved.filters), enabled: saved.enabled };
  } else {
    const tpl = TEMPLATES[Number(params.get('template'))];
    const target = tpl?.target || (params.get('target') === 'radarr' ? 'radarr' : 'sonarr');
    draft = {
      name: tpl?.name || '',
      slug: '',
      target,
      filters: { ...structuredClone(meta.defaults[target]), ...structuredClone(tpl?.filters || {}) },
      enabled: true,
    };
  }

  const ed = {
    id,
    saved,
    draft,
    meta,
    items: saved?.items?.length ? saved.items : null,
    seasonLabel: saved?.seasonLabel || null,
    mode: saved?.items?.length ? 'saved' : 'none',
    warnings: [],
    tab: 'all',
    busy: false,
  };

  view.innerHTML = `
    <div class="page-head">
      <div>
        <a class="btn btn-ghost btn-sm" href="#/" style="margin-left:-10px;margin-bottom:6px">${icon('back')}Lists</a>
        <h1>${saved ? esc(saved.name) : 'New list'}</h1>
      </div>
    </div>
    <div class="editor">
      <form class="form" id="ed-form" autocomplete="off"></form>
      <section id="ed-results"></section>
    </div>
    <datalist id="tag-list">${meta.tags.map((t) => `<option value="${esc(t.name)}">${esc(t.category)}</option>`).join('')}</datalist>`;

  const form = document.getElementById('ed-form');
  const results = document.getElementById('ed-results');

  const renderForm = () => {
    form.innerHTML = editorFormHtml(ed);
  };
  const renderRes = () => {
    results.innerHTML = resultsHtml(ed);
  };
  renderForm();
  renderRes();

  // --- form events ---

  const setPath = (path, value) => {
    const keys = path.split('.');
    let o = ed.draft;
    while (keys.length > 1) o = o[keys.shift()];
    o[keys[0]] = value;
  };

  form.addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'number') v = e.target.value === '' ? 0 : Number(e.target.value);
    setPath(f, v);
    if (f === 'filters.season.mode') {
      const s = ed.draft.filters.season;
      if (v === 'specific' && !s.season) {
        s.season = 'WINTER';
        s.year = new Date().getFullYear();
      }
      if (v === 'year' && !s.year) s.year = new Date().getFullYear();
      renderForm();
    }
  });

  form.addEventListener('click', (e) => {
    const b = e.target.closest('button,[data-chip],[data-genre]');
    if (!b) return;
    const f = ed.draft.filters;
    if (b.dataset.target && b.dataset.target !== ed.draft.target) {
      ed.draft.target = b.dataset.target;
      const d = structuredClone(meta.defaults[b.dataset.target]);
      f.formats = d.formats;
      f.season = d.season;
      ed.items = null;
      ed.mode = 'none';
      renderForm();
      renderRes();
      return;
    }
    if (b.dataset.chip) {
      const arr = f[b.dataset.chip];
      const v = b.dataset.v;
      const i = arr.indexOf(v);
      if (i >= 0) arr.splice(i, 1);
      else arr.push(v);
      b.classList.toggle('on', i < 0);
      return;
    }
    if (b.dataset.genre) {
      const g = b.dataset.genre;
      const inc = f.genresInclude.indexOf(g);
      const exc = f.genresExclude.indexOf(g);
      if (inc >= 0) {
        f.genresInclude.splice(inc, 1);
        f.genresExclude.push(g);
      } else if (exc >= 0) {
        f.genresExclude.splice(exc, 1);
      } else {
        f.genresInclude.push(g);
      }
      b.classList.toggle('on', f.genresInclude.includes(g));
      b.classList.toggle('not', f.genresExclude.includes(g));
      return;
    }
    if (b.dataset.sequels) {
      f.sequels = b.dataset.sequels;
      form.querySelectorAll('[data-sequels]').forEach((x) => x.classList.toggle('on', x === b));
      return;
    }
    if (b.dataset.tagAdd) {
      addTag(b.dataset.tagAdd);
      return;
    }
    if (b.dataset.tagRemove) {
      const key = b.dataset.tagRemove;
      f[key] = f[key].filter((t) => t !== b.dataset.v);
      renderForm();
      return;
    }
    if (b.id === 'ed-preview') runPreview();
    if (b.id === 'ed-delete') deleteList();
  });

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'tag-input') {
      e.preventDefault();
      addTag('tagsInclude');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  function addTag(key) {
    const input = form.querySelector('#tag-input');
    const val = input.value.trim();
    if (!val) return;
    const known = meta.tags.find((t) => t.name.toLowerCase() === val.toLowerCase());
    if (meta.tags.length && !known) {
      toast(`"${val}" isn't an AniList tag`, true);
      return;
    }
    const name = known?.name || val;
    const f = ed.draft.filters;
    f.tagsInclude = f.tagsInclude.filter((t) => t !== name);
    f.tagsExclude = f.tagsExclude.filter((t) => t !== name);
    f[key].push(name);
    renderForm();
    form.querySelector('#tag-input')?.focus();
  }

  const setBusy = (busy, label) => {
    ed.busy = busy;
    form.querySelectorAll('.form-foot button').forEach((b) => (b.disabled = busy));
    if (busy) results.innerHTML = loadingBlock(label);
  };

  async function runPreview() {
    setBusy(true, 'Searching AniList and matching IDs…');
    try {
      const r = await api('/api/preview', {
        method: 'POST',
        body: { target: ed.draft.target, filters: ed.draft.filters, listId: ed.id },
      });
      if (token !== renderToken) return;
      Object.assign(ed, { items: r.items, seasonLabel: r.seasonLabel, warnings: r.warnings, mode: 'preview' });
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
      else toast(`Saved — ${l.matched}/${l.total} titles matched`);
      if (ed.id) route();
      else location.hash = `#/lists/${list.id}`;
      pollStatus();
    } catch (e) {
      toast(e.message, true);
      setBusy(false);
      renderRes();
    }
  }

  async function deleteList() {
    if (!confirm(`Delete "${ed.saved.name}"? Its feed URL will stop working.`)) return;
    try {
      await api(`/api/lists/${ed.id}`, { method: 'DELETE' });
      toast('List deleted');
      location.hash = '#/';
    } catch (e) {
      toast(e.message, true);
    }
  }

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
    const item = ed.items?.find((i) => i.anilistId === Number(b.dataset.exclude || b.dataset.override));
    if (!item) return;
    if (b.dataset.exclude) {
      try {
        if (item.excluded) await api(`/api/lists/${ed.id}/exclusions/${item.anilistId}`, { method: 'DELETE' });
        else await api(`/api/lists/${ed.id}/exclusions`, { method: 'POST', body: { anilistId: item.anilistId, title: item.title } });
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
}

function editorFormHtml(ed) {
  const d = ed.draft;
  const f = d.filters;
  const s = f.season;
  const chip = (key, v, label) =>
    `<button type="button" class="chip${f[key].includes(v) ? ' on' : ''}" data-chip="${key}" data-v="${esc(v)}">${esc(label)}</button>`;
  const year = new Date().getFullYear();
  const formats = d.target === 'radarr' ? ['MOVIE', 'SPECIAL', 'OVA', 'ONA'] : ['TV', 'TV_SHORT', 'ONA', 'OVA', 'SPECIAL', 'MOVIE'];

  return `
    <div class="form-sec">
      <div class="field">
        <label for="ed-name">Name</label>
        <input class="input" id="ed-name" data-f="name" value="${esc(d.name)}" placeholder="e.g. Fall simulcasts" maxlength="80" />
      </div>
      <div class="field">
        <span class="label">Send to</span>
        <div class="seg">
          <button type="button" class="sonarr${d.target === 'sonarr' ? ' on' : ''}" data-target="sonarr">Sonarr · series</button>
          <button type="button" class="radarr${d.target === 'radarr' ? ' on' : ''}" data-target="radarr">Radarr · movies</button>
        </div>
      </div>
    </div>

    <div class="form-sec">
      <div class="field">
        <label for="ed-season">When</label>
        <select class="select" id="ed-season" data-f="filters.season.mode">
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
        ${
          ['current', 'next', 'previous', 'currentYear'].includes(s.mode)
            ? `<span class="hint">Rolls forward automatically${s.mode === 'currentYear' ? ' each January' : ` — switches ${state.settings?.seasonRolloverDays ?? 14} days before a season starts`}.</span>`
            : ''
        }
      </div>
      <div class="field">
        <span class="label">Format</span>
        <div class="chips">${formats.map((x) => chip('formats', x, FORMAT_NAMES[x])).join('')}</div>
      </div>
      <div class="field">
        <span class="label">Status <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">— none selected = any</span></span>
        <div class="chips">${Object.entries(STATUS_NAMES).map(([k, v]) => chip('statuses', k, v)).join('')}</div>
      </div>
      <div class="field">
        <span class="label">Sequels</span>
        <div class="seg">
          ${[['include', 'Include'], ['exclude', 'New only'], ['only', 'Sequels only']]
            .map(([k, v]) => `<button type="button" data-sequels="${k}" class="${f.sequels === k ? 'on' : ''}">${v}</button>`)
            .join('')}
        </div>
      </div>
      <div class="field">
        <span class="label">Country of origin</span>
        <div class="chips">${Object.entries(COUNTRIES).map(([k, v]) => chip('countries', k, v)).join('')}</div>
      </div>
    </div>

    <div class="form-sec">
      <div class="field">
        <span class="label">Genres</span>
        <span class="hint">Click once to require, twice to exclude.</span>
        <div class="chips">
          ${ed.meta.genres
            .map((g) => `<button type="button" class="chip${f.genresInclude.includes(g) ? ' on' : ''}${f.genresExclude.includes(g) ? ' not' : ''}" data-genre="${esc(g)}">${esc(g)}</button>`)
            .join('')}
        </div>
      </div>
      <div class="field">
        <label for="tag-input">Tags</label>
        <div class="tag-add">
          <input class="input" id="tag-input" list="tag-list" placeholder="Isekai, Iyashikei, Time Skip…" />
          <button type="button" class="btn btn-sm" data-tag-add="tagsInclude" style="height:36px">Require</button>
          <button type="button" class="btn btn-sm" data-tag-add="tagsExclude" style="height:36px">Exclude</button>
        </div>
        ${
          f.tagsInclude.length + f.tagsExclude.length
            ? `<div class="chips">
                ${f.tagsInclude.map((t) => `<button type="button" class="chip on" data-tag-remove="tagsInclude" data-v="${esc(t)}">${esc(t)} <span class="x">×</span></button>`).join('')}
                ${f.tagsExclude.map((t) => `<button type="button" class="chip not" data-tag-remove="tagsExclude" data-v="${esc(t)}">${esc(t)} <span class="x">×</span></button>`).join('')}
              </div>`
            : ''
        }
      </div>
    </div>

    <div class="form-sec">
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
      <div class="row">
        <div class="field">
          <label for="ed-sort">Rank by</label>
          <select class="select" id="ed-sort" data-f="filters.sort">
            ${Object.entries(SORT_NAMES).map(([k, v]) => `<option value="${k}"${f.sort === k ? ' selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="ed-limit">Keep top</label>
          <input class="input" id="ed-limit" type="number" min="1" max="500" data-f="filters.limit" value="${esc(f.limit)}" />
        </div>
      </div>
      <span class="hint">Popularity = AniList members who added the show. Score is 0–100; new shows often have none yet, so a minimum score hides them.</span>
    </div>

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
    </div>

    <div class="form-foot">
      <button type="button" class="btn" id="ed-preview">${icon('play')}Preview</button>
      <span class="spacer"></span>
      ${ed.saved ? '<button type="button" class="btn btn-ghost btn-danger" id="ed-delete">Delete</button>' : ''}
      <button type="submit" class="btn btn-primary">${ed.saved ? 'Save & refresh' : 'Create list'}</button>
    </div>`;
}

const inFeed = (i) => i.externalId && !i.excluded;

function resultsHtml(ed) {
  const target = ed.draft.target;
  if (!ed.items) {
    return `<div class="empty"><h2>Nothing to show yet</h2>
      <p>Run a preview to see which shows this list would send to ${ARR[target]}.</p>
      <p><button class="btn btn-primary" id="res-preview" type="button">${icon('play')}Preview</button></p></div>`;
  }
  const items = ed.items;
  const counts = {
    all: items.length,
    feed: items.filter(inFeed).length,
    unmatched: items.filter((i) => !i.externalId).length,
    excluded: items.filter((i) => i.excluded).length,
  };
  const shown = items.filter((i) =>
    ed.tab === 'feed' ? inFeed(i) : ed.tab === 'unmatched' ? !i.externalId : ed.tab === 'excluded' ? i.excluded : true,
  );
  const lib = items.filter((i) => i.inLibrary).length;
  const sub =
    ed.mode === 'preview'
      ? ed.saved
        ? 'Preview of your unsaved changes — the feed still serves the saved version until you save.'
        : 'Preview — create the list to publish its feed.'
      : `Feed last refreshed ${ago(ed.saved?.last_refresh)}.`;

  return `
    <div class="results-head">
      <div>
        <h2>${esc(ed.seasonLabel || 'Results')} <span class="faint" style="font-weight:500">· ${counts.feed} going to ${ARR[target]}</span></h2>
        <div class="results-sub">${esc(sub)}${arrConnected(target) ? ` ${lib} already in your library.` : ''}</div>
      </div>
      <div class="tabs">
        ${[['all', 'All'], ['feed', 'In feed'], ['unmatched', 'Unmatched'], ['excluded', 'Excluded']]
          .map(([k, v]) => `<button type="button" data-tab="${k}" class="${ed.tab === k ? 'on' : ''}">${v}<span class="n">${counts[k]}</span></button>`)
          .join('')}
      </div>
    </div>
    ${ed.warnings.map((w) => `<div class="notice">${esc(w)}</div>`).join('')}
    ${
      counts.unmatched
        ? `<div class="notice info">${counts.unmatched} title${counts.unmatched > 1 ? 's have' : ' has'} no ${target === 'sonarr' ? 'TVDB' : 'TMDB'} ID yet. New shows usually get mapped within a few days; the daily refresh picks them up. You can also set an ID by hand with the # button.</div>`
        : ''
    }
    <div class="legend">
      ${Object.entries(SOURCES).map(([k, [label, tip]]) => `<span title="${esc(tip)}"><i style="background:var(--src-${k})"></i>${label}</span>`).join('')}
      <span><i style="background:var(--err)"></i>No match</span>
    </div>
    ${shown.length ? `<div class="grid">${shown.map((it) => itemHtml(it, items.indexOf(it), ed)).join('')}</div>` : '<div class="empty"><p>Nothing here.</p></div>'}`;
}

function itemHtml(it, idx, ed) {
  const target = ed.draft.target;
  const src = it.matchSource;
  const idLabel = target === 'sonarr' ? 'TVDB' : 'TMDB';
  const idUrl = target === 'sonarr'
    ? `https://thetvdb.com/dereferrer/series/${it.externalId}`
    : `https://www.themoviedb.org/movie/${it.externalId}`;
  const meta = [FORMAT_NAMES[it.format] || it.format, it.episodes ? `${it.episodes} ep` : null, it.score ? `${it.score}%` : null, it.studio]
    .filter(Boolean)
    .join(' · ');
  return `
    <div class="item${it.excluded ? ' excluded' : ''}">
      <div class="poster" style="background:${esc(it.color || 'var(--panel-2)')}">
        ${it.cover ? `<img loading="lazy" src="${esc(it.cover)}" alt="" />` : ''}
        <span class="rank">${idx + 1}</span>
        <div class="item-actions">
          ${ed.saved ? `<button type="button" data-exclude="${it.anilistId}" title="${it.excluded ? 'Put back in the feed' : 'Exclude from the feed'}">${icon(it.excluded ? 'eye' : 'eyeOff')}</button>` : ''}
          <button type="button" data-override="${it.anilistId}" title="Set the ${idLabel} ID by hand">${icon('hash')}</button>
          <a href="${esc(it.siteUrl)}" target="_blank" rel="noopener" title="Open on AniList">${icon('ext')}</a>
        </div>
        <div class="badges">
          ${
            src
              ? `<span class="badge src-${src}" title="${esc(SOURCES[src][1])}"><i></i>${SOURCES[src][0]}</span>`
              : '<span class="badge src-none"><i></i>No match</span>'
          }
          ${it.inLibrary ? '<span class="badge lib">In library</span>' : ''}
          ${it.sequel ? '<span class="badge">Sequel</span>' : ''}
          ${it.excluded ? '<span class="badge src-none">Excluded</span>' : ''}
        </div>
      </div>
      <div class="item-body">
        <div class="item-title" title="${esc(it.romaji)}">${esc(it.title)}</div>
        <div class="item-meta">${esc(meta)}</div>
        <div class="item-id">${it.externalId ? `<a href="${idUrl}" target="_blank" rel="noopener">${idLabel} ${it.externalId}</a>` : `<span class="faint">no ${idLabel} ID</span>`}</div>
      </div>
    </div>`;
}

function overrideDialog(item, target) {
  const idLabel = target === 'sonarr' ? 'TVDB' : 'TMDB';
  const key = target === 'sonarr' ? 'tvdbId' : 'tmdbId';
  const current = item.matchSource === 'override' ? item.externalId : '';
  dialog.innerHTML = `
    <form method="dialog">
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
    </form>`;
  dialog.showModal();
  // Enter would otherwise "click" the first button in the form (Remove/Cancel).
  dialog.querySelector('#ov-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.close('save');
    }
  });
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      async () => {
        const action = dialog.returnValue;
        if (action !== 'save' && action !== 'clear') return resolve(false);
        const raw = action === 'clear' ? null : dialog.querySelector('#ov-id').value.trim();
        if (action === 'save' && !/^\d+$/.test(raw || '')) {
          toast(`${idLabel} IDs are whole numbers`, true);
          return resolve(false);
        }
        try {
          await api(`/api/overrides/${item.anilistId}`, { method: 'PUT', body: { [key]: raw, title: item.title } });
          if (raw) Object.assign(item, { externalId: Number(raw), matchSource: 'override' });
          else Object.assign(item, { externalId: null, matchSource: null });
          toast(raw ? `${item.title} → ${idLabel} ${raw}` : 'Override removed — refresh to re-match');
          resolve(true);
        } catch (e) {
          toast(e.message, true);
          resolve(false);
        }
      },
      { once: true },
    );
  });
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

  const arrPanel = (kind) => `
    <div class="panel">
      <div class="panel-head"><span class="pill ${kind}">${kind}</span><div><h2>${ARR[kind]} connection</h2><p>Optional — enables title lookups, “in library” badges and instant syncs.</p></div></div>
      <div class="panel-body">
        <div class="field">
          <label for="${kind}-url">URL</label>
          <input class="input" id="${kind}-url" name="${kind}Url" value="${esc(s[`${kind}Url`])}" placeholder="http://192.168.1.10:${kind === 'sonarr' ? 8989 : 7878}" />
        </div>
        <div class="field">
          <label for="${kind}-key">API key</label>
          <input class="input mono" id="${kind}-key" name="${kind}ApiKey" type="password" autocomplete="new-password"
            placeholder="${s[`${kind}ApiKeySet`] ? 'Saved — leave blank to keep' : `${ARR[kind]} → Settings → General → API Key`}" />
        </div>
        <div class="row" style="flex:none">
          <button type="button" class="btn btn-sm" data-test="${kind}" style="flex:none">Test connection</button>
          <span class="test-result" id="${kind}-test"></span>
          ${s[`${kind}ApiKeySet`] ? `<button type="button" class="btn btn-sm btn-ghost btn-danger" data-clear="${kind}" style="flex:none">Forget key</button>` : ''}
        </div>
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

        <div class="panel">
          <div class="panel-head"><div><h2>Lists</h2><p>How seasons and titles are handled.</p></div></div>
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
            <div class="field">
              <label for="feed-base">Feed base URL</label>
              <input class="input" id="feed-base" name="feedBaseUrl" value="${esc(s.feedBaseUrl)}" placeholder="${esc(origin)}" />
              <span class="hint">The address Sonarr/Radarr use to reach Courarr. Leave blank to use this page’s address.</span>
            </div>
          </div>
        </div>

        ${arrPanel('sonarr')}
        ${arrPanel('radarr')}

        <div class="panel">
          <div class="panel-head"><div><h2>Matching</h2><p>How AniList entries are turned into TVDB / TMDB IDs.</p></div></div>
          <div class="panel-body">
            <label class="check"><input type="checkbox" name="arrLookupFallback"${s.arrLookupFallback ? ' checked' : ''} />
              <span><b>Search Sonarr/Radarr by title when the mapping has no ID</b><span class="hint">Exact title + year matches only. Needs a connection above.</span></span></label>
            <label class="check"><input type="checkbox" name="triggerArrSync"${s.triggerArrSync ? ' checked' : ''} />
              <span><b>Tell Sonarr/Radarr to sync import lists after a refresh</b><span class="hint">Otherwise they pick up changes on their own list interval (Radarr: every 12h minimum).</span></span></label>
            <div class="row" style="flex:none">
              <span class="hint" style="flex:1">Mapping database: ${st.mapping.entries.toLocaleString()} entries, updated ${esc(ago(st.mapping.updatedAt))}${st.mapping.lastError ? ` — <span style="color:var(--err)">${esc(st.mapping.lastError)}</span>` : ''}</span>
              <button type="button" class="btn btn-sm" id="map-update" style="flex:none">${icon('refresh')}Update now</button>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><div><h2>Connecting a list</h2><p>Do this once per list.</p></div></div>
          <div class="panel-body">
            <ol class="steps">
              <li><b>Sonarr:</b> Settings → Import Lists → + → <b>Custom List</b>. Paste the list’s feed URL, pick a root folder and quality profile, and set <b>Series Type: Anime</b>. “Monitor: Future Episodes” works well for sequels you already have.</li>
              <li><b>Radarr:</b> Settings → Import Lists → + → <b>Custom Lists</b>. Paste the feed URL and pick a root folder / quality profile.</li>
              <li>Copy feed URLs from the list cards on the Lists page.</li>
            </ol>
          </div>
        </div>
      </div>
      <div class="save-bar"><button class="btn btn-primary" type="submit">Save settings</button></div>
    </form>`;

  const form = document.getElementById('settings-form');
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
      arrLookupFallback: fd.get('arrLookupFallback') === 'on',
      triggerArrSync: fd.get('triggerArrSync') === 'on',
    };
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.settings = await api('/api/settings', { method: 'PUT', body: collect() });
      toast('Settings saved');
      pollStatus();
      viewSettings();
    } catch (err) {
      toast(err.message, true);
    }
  });

  form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-test],[data-clear],#map-update');
    if (!b) return;
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
      } catch (err) {
        out.className = 'test-result err';
        out.textContent = err.message;
      }
    }
    if (b.dataset.clear) {
      const kind = b.dataset.clear;
      const key = `clear${kind[0].toUpperCase()}${kind.slice(1)}ApiKey`;
      state.settings = await api('/api/settings', { method: 'PUT', body: { [key]: true } });
      toast(`${ARR[kind]} API key removed`);
      viewSettings();
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
  const [runs, overrides] = await Promise.all([api('/api/runs'), api('/api/overrides')]);
  view.innerHTML = `
    <div class="page-head"><div><h1>Activity</h1><p>Recent refreshes and the IDs you have set by hand.</p></div></div>
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
    <div class="panel">
      <div class="panel-head"><div><h2>Manual IDs</h2><p>Set with the # button on a title. They win over every other match.</p></div></div>
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
        : `<span><b>${esc(l.name)}</b> <span class="muted">${l.matched}/${l.total} matched · ${esc(l.seasonLabel)}</span></span>`,
    )
    .join('');
  const extra = [
    ...(s.warnings || []).map((w) => `<span style="color:var(--warn)">${esc(w)}</span>`),
    s.error ? `<span style="color:var(--err)">${esc(s.error)}</span>` : '',
    s.synced?.length ? `<span class="faint">Asked ${s.synced.map((k) => ARR[k]).join(' & ')} to sync</span>` : '',
  ].join('');
  return `<tr>
    <td>${esc(fmtDate(r.started_at))}</td>
    <td class="muted" style="text-transform:capitalize">${esc(r.trigger)}</td>
    <td><span class="st ${esc(r.status)}">${esc(r.status)}</span></td>
    <td><div class="run-lists">${lists || '<span class="faint">No lists</span>'}${extra}</div></td>
  </tr>`;
}

// ---------- boot ----------

loadSettings().catch(() => {});
pollStatus();
route();
