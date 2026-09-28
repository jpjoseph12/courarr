// Minimal Sonarr / Radarr v3 API client. Used for optional extras: title lookups for unmapped
// shows, "already in library" badges, creating the Custom List import list for a Courarr list,
// and nudging an import-list sync after a refresh.

export function arrClient(kind, settings) {
  const base = (settings[`${kind}Url`] || '').trim().replace(/\/+$/, '');
  const apiKey = (settings[`${kind}ApiKey`] || '').trim();
  if (!base || !apiKey) return null;

  async function req(p, init = {}) {
    const res = await fetch(`${base}/api/v3${p}`, {
      ...init,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${kind} ${p.split('?')[0]}: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  const isSonarr = kind === 'sonarr';
  return {
    kind,
    status: () => req('/system/status'),
    lookup: (term) => req(`${isSonarr ? '/series' : '/movie'}/lookup?term=${encodeURIComponent(term)}`),
    /** Everything already in the library, indexed by each id type. */
    async libraryIds() {
      const all = await req(isSonarr ? '/series' : '/movie');
      const ids = { tvdb: new Set(), tmdb: new Set(), imdb: new Set() };
      for (const x of all) {
        if (x.tvdbId) ids.tvdb.add(x.tvdbId);
        if (x.tmdbId) ids.tmdb.add(x.tmdbId);
        if (x.imdbId) ids.imdb.add(x.imdbId);
      }
      return ids;
    },
    syncImportLists: () =>
      req('/command', { method: 'POST', body: JSON.stringify({ name: 'ImportListSync' }) }),

    async options() {
      const [rootFolders, qualityProfiles, tags] = await Promise.all([
        req('/rootfolder'),
        req('/qualityprofile'),
        req('/tag'),
      ]);
      return {
        rootFolders: rootFolders.map((r) => ({ path: r.path, freeSpace: r.freeSpace })),
        qualityProfiles: qualityProfiles.map((q) => ({ id: q.id, name: q.name })),
        tags: tags.map((t) => ({ id: t.id, label: t.label })),
      };
    },

    async getImportList(id) {
      try {
        return summariseImportList(await req(`/importlist/${id}`));
      } catch (e) {
        if (/HTTP 404/.test(e.message)) return null;
        throw e;
      }
    },

    /** Creates or updates the Custom List import list that points at a Courarr feed. */
    async upsertImportList(existingId, cfg) {
      let body = null;
      if (existingId) body = await req(`/importlist/${existingId}`).catch(() => null);
      if (!body) {
        const impl = isSonarr ? 'CustomImport' : 'RadarrListImport';
        body = (await req('/importlist/schema')).find((s) => s.implementation === impl);
        if (!body) throw new Error(`${kind} has no ${impl} import list type`);
      }
      const field = (name, value) => {
        const f = body.fields.find((x) => x.name === name);
        if (f) f.value = value;
      };
      body.name = cfg.name;
      body.rootFolderPath = cfg.rootFolderPath;
      body.qualityProfileId = Number(cfg.qualityProfileId);
      body.tags = cfg.tags || [];
      if (isSonarr) {
        body.enableAutomaticAdd = true;
        body.seriesType = cfg.seriesType;
        body.shouldMonitor = cfg.monitor;
        body.monitorNewItems = cfg.monitorNewItems || 'all';
        body.seasonFolder = cfg.seasonFolder !== false;
        body.searchForMissingEpisodes = !!cfg.searchOnAdd;
        field('baseUrl', cfg.url);
      } else {
        body.enabled = true;
        body.enableAuto = true;
        body.monitor = cfg.monitor;
        body.minimumAvailability = cfg.minimumAvailability;
        body.searchOnAdd = !!cfg.searchOnAdd;
        field('url', cfg.url);
      }
      // forceSave: Radarr refuses a list whose feed is currently empty unless forced.
      const saved = body.id
        ? await req(`/importlist/${body.id}?forceSave=true`, { method: 'PUT', body: JSON.stringify(body) })
        : await req('/importlist?forceSave=true', { method: 'POST', body: JSON.stringify(body) });
      return summariseImportList(saved);
    },

    async deleteImportList(id) {
      try {
        await fetch(`${base}/api/v3/importlist/${id}`, {
          method: 'DELETE',
          headers: { 'X-Api-Key': apiKey },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        /* already gone or unreachable — nothing more to do */
      }
    },
  };

  function summariseImportList(l) {
    const url = l.fields?.find((f) => f.name === (isSonarr ? 'baseUrl' : 'url'))?.value;
    return {
      id: l.id,
      name: l.name,
      url,
      rootFolderPath: l.rootFolderPath,
      qualityProfileId: l.qualityProfileId,
      tags: l.tags || [],
      ...(isSonarr
        ? {
            seriesType: l.seriesType,
            monitor: l.shouldMonitor,
            seasonFolder: l.seasonFolder,
            searchOnAdd: l.searchForMissingEpisodes,
          }
        : { monitor: l.monitor, minimumAvailability: l.minimumAvailability, searchOnAdd: l.searchOnAdd }),
    };
  }
}

const norm = (s) =>
  (s || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Finds a Sonarr (tvdbId) / Radarr (tmdbId) match for an AniList entry by title.
 * Only accepts exact normalised-title matches with a plausible year, so it errs on the side
 * of leaving things unmatched rather than adding the wrong show.
 */
export async function lookupByTitle(client, media) {
  const names = [media.title.english, media.title.romaji, ...(media.synonyms || [])].filter(Boolean);
  const wanted = new Set(names.map(norm).filter((n) => n.length >= 3));
  const year = media.startDate?.year || media.seasonYear || null;
  const tried = new Set();

  for (const term of [media.title.romaji, media.title.english].filter(Boolean)) {
    if (tried.has(term)) continue;
    tried.add(term);
    let results;
    try {
      results = await client.lookup(term);
    } catch {
      return null;
    }
    for (const r of results.slice(0, 10)) {
      const titles = [r.title, r.originalTitle, ...(r.alternateTitles || []).map((a) => a.title)];
      const titleOk = titles.some((t) => wanted.has(norm(t)));
      const yearOk = !year || !r.year || Math.abs(r.year - year) <= 1;
      if (titleOk && yearOk) {
        const id = client.kind === 'sonarr' ? r.tvdbId : r.tmdbId;
        if (id) return id;
      }
    }
  }
  return null;
}
