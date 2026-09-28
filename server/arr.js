// Minimal Sonarr / Radarr v3 API client. Only used for optional extras: title lookups for
// unmapped shows, "already in library" badges, and nudging an import-list sync after a refresh.

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
    async libraryIds() {
      const all = await req(isSonarr ? '/series' : '/movie');
      return new Set(all.map((x) => (isSonarr ? x.tvdbId : x.tmdbId)).filter(Boolean));
    },
    syncImportLists: () =>
      req('/command', { method: 'POST', body: JSON.stringify({ name: 'ImportListSync' }) }),
  };
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
