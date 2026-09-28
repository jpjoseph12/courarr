// Reads Maintainerr collections (e.g. "Series - Abandonment") so their titles can be kept out of
// every feed. Maintainerr's rules (watch history, ratings, age…) decide; Courarr just listens.
import * as store from './db.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export function maintainerrClient(settings) {
  const base = (settings.maintainerrUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const apiKey = (settings.maintainerrApiKey || '').trim();

  async function get(p) {
    const res = await fetch(`${base}/api${p}`, {
      headers: { Accept: 'application/json', ...(apiKey ? { 'X-Api-Key': apiKey } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Maintainerr ${p.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }

  return {
    /** Show and movie collections. Season/episode collections manage parts of a show, not whole titles. */
    async collections() {
      const all = await get('/collections');
      return all.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        active: c.isActive,
        count: c.mediaCount ?? c.media?.length ?? 0,
        supported: c.type === 'show' || c.type === 'movie',
      }));
    },

    async collectionItems(collectionId) {
      const out = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await get(`/collections/media/${collectionId}/content/${page}?size=${PAGE_SIZE}`);
        out.push(...(r.items || []));
        if (out.length >= (r.totalSize || 0) || !(r.items || []).length) break;
      }
      return out;
    },
  };
}

const firstInt = (...vals) => {
  for (const v of vals.flat()) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
};

/** One Maintainerr collection item -> an ignored_titles row. */
export function toIgnoredRow(item, collection) {
  const p = item.mediaData?.providerIds || {};
  const kind = collection.type === 'movie' ? 'movie' : 'show';
  return {
    ref: `maintainerr:${kind}:${item.mediaServerId}`,
    kind,
    title: item.mediaData?.title || `Plex item ${item.mediaServerId}`,
    tmdbId: firstInt(item.tmdbId, p.tmdb || []),
    // A movie's "tvdb" id is a TVDB *movie* id; never compare it with Sonarr series ids.
    tvdbId: kind === 'show' ? firstInt(item.tvdbId, p.tvdb || []) : null,
    imdbId: (p.imdb || [])[0] || null,
    reason: `Maintainerr: ${collection.title}`,
  };
}

/**
 * Mirrors the chosen collections into ignored_titles: titles that left a collection (e.g. you
 * started watching again) stop being ignored. If Maintainerr can't be read, nothing changes.
 */
export async function syncMaintainerr(client, collectionIds) {
  const cols = (await client.collections()).filter((c) => collectionIds.includes(c.id) && c.supported);
  const summary = [];
  for (const c of cols) {
    const rows = (await client.collectionItems(c.id)).map((it) => toIgnoredRow(it, c));
    summary.push({ collection: c.title, titles: rows.length, rows });
  }
  store.replaceIgnored('maintainerr:', summary.flatMap((x) => x.rows));
  return summary;
}

/** Lookup sets for matching list items against the ignored titles, split by kind. */
export function ignoreIndex(rows = store.listIgnored()) {
  const idx = {
    show: { tvdb: new Map(), tmdb: new Map(), imdb: new Map() },
    movie: { tvdb: new Map(), tmdb: new Map(), imdb: new Map() },
  };
  for (const r of rows) {
    const k = idx[r.kind];
    if (r.tvdb_id) k.tvdb.set(r.tvdb_id, r.reason);
    if (r.tmdb_id) k.tmdb.set(r.tmdb_id, r.reason);
    if (r.imdb_id) k.imdb.set(r.imdb_id, r.reason);
  }
  return idx;
}

/** Why an item is ignored (or null). `kind` is show for Sonarr lists, movie for Radarr lists. */
export function ignoredReason(idx, kind, { tvdbId, tmdbId, imdbId }) {
  const k = idx[kind];
  return (tvdbId && k.tvdb.get(tvdbId)) || (tmdbId && k.tmdb.get(tmdbId)) || (imdbId && k.imdb.get(imdbId)) || null;
}
