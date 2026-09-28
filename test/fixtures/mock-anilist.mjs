// A stand-in for the AniList GraphQL API (and the Fribb ID mapping file) for offline tests.
// It understands the handful of queries Courarr sends, told apart by what the query asks for.
import http from 'node:http';

const media = (o) => ({
  idMal: null,
  synonyms: [],
  status: 'RELEASING',
  season: 'FALL',
  seasonYear: 2026,
  startDate: { year: 2026, month: 10, day: 1 },
  averageScore: 70,
  popularity: 1000,
  genres: [],
  countryOfOrigin: 'JP',
  siteUrl: `https://anilist.co/anime/${o.id}`,
  coverImage: { large: `https://img.example/${o.id}.jpg`, color: '#223344' },
  studios: { nodes: [] },
  relations: { edges: [] },
  episodes: 12,
  duration: 24,
  format: 'TV',
  licensors: [],
  ...o,
  title: { romaji: o.name, english: o.name, native: null, ...(o.title || {}) },
});

export const MEDIA = [
  media({ id: 101, name: 'Alpha Show', genres: ['Action', 'Comedy'], popularity: 5000, studios: { nodes: [{ id: 569, name: 'MAPPA' }] }, licensors: [5] }),
  // A sequel with no mapping of its own: resolved through its prequel.
  media({
    id: 102,
    name: 'Alpha Show Season 2',
    genres: ['Action'],
    popularity: 4000,
    relations: { edges: [{ relationType: 'PREQUEL', node: { id: 101, type: 'ANIME', relations: { edges: [] } } }] },
  }),
  // Episode count / runtime not announced yet.
  media({ id: 103, name: 'Beta Romance', genres: ['Romance'], countryOfOrigin: 'CN', episodes: null, duration: null, popularity: 3000, studios: { nodes: [{ id: 43, name: 'ufotable' }] } }),
  // Not in the mapping: only a Sonarr title search can match it.
  media({ id: 104, name: 'Gamma Unmapped', genres: ['Drama'], popularity: 2000, episodes: 24 }),
  media({ id: 105, name: 'Delta Movie', format: 'MOVIE', episodes: 1, duration: 110, genres: ['Drama'], popularity: 1500, season: 'SPRING', seasonYear: 2016, startDate: { year: 2016, month: 4, day: 1 } }),
  // Mapping only knows its IMDb id: Radarr resolves it.
  media({ id: 106, name: 'Epsilon Film', format: 'MOVIE', episodes: 1, duration: 95, genres: ['Action'], popularity: 1200, season: 'SUMMER', seasonYear: 2018, startDate: { year: 2018, month: 0, day: 0 } }),
];

export const MAPPING = [
  { anilist_id: 101, type: 'TV', tvdb_id: 9001, themoviedb_id: { tv: 5001 }, imdb_id: ['tt0000101'], season: { tvdb: 1 } },
  { anilist_id: 103, type: 'ONA', tvdb_id: 9003, imdb_id: 'tt0000103' },
  { anilist_id: 105, type: 'MOVIE', themoviedb_id: { movie: [7005] }, imdb_id: ['tt0000105'] },
  { anilist_id: 106, type: 'MOVIE', imdb_id: ['tt0000106'] },
  { anilist_id: 999, type: 'MOVIE', themoviedb_id: 42 }, // older schema: a bare number
  { mal_id: 1 }, // no AniList id: skipped
];

const STAFF = { 95185: { name: 'Kana Hanazawa', occupations: ['Voice Actor'], staffMedia: [103], characterMedia: [101] } };

const fuzzy = (d) => (d.year || 0) * 10000 + (d.month || 0) * 100 + (d.day || 0);

function pageOf(v) {
  let r = MEDIA.filter((m) => {
    if (v.format_in && !v.format_in.includes(m.format)) return false;
    if (v.status_in && !v.status_in.includes(m.status)) return false;
    if (v.season && (m.season !== v.season || m.seasonYear !== v.seasonYear)) return false;
    if (v.startDate_greater != null && !(fuzzy(m.startDate) > v.startDate_greater)) return false;
    if (v.startDate_lesser != null && !(fuzzy(m.startDate) < v.startDate_lesser)) return false;
    if (v.genre_in && !v.genre_in.every((g) => m.genres.includes(g))) return false;
    if (v.genre_not_in && v.genre_not_in.some((g) => m.genres.includes(g))) return false;
    if (v.countryOfOrigin && m.countryOfOrigin !== v.countryOfOrigin) return false;
    if (v.licensedById_in && !v.licensedById_in.some((id) => m.licensors.includes(id))) return false;
    if (v.popularity_greater != null && !(m.popularity > v.popularity_greater)) return false;
    if (v.averageScore_greater != null && !(m.averageScore > v.averageScore_greater)) return false;
    return true;
  }).sort((a, b) => b.popularity - a.popularity);
  const per = v.perPage || 50;
  const page = v.page || 1;
  const slice = r.slice((page - 1) * per, page * per).map(({ name, licensors, ...m }) => structuredClone(m));
  return { Page: { pageInfo: { hasNextPage: page * per < r.length }, media: slice } };
}

function answer(query, v) {
  if (query.includes('GenreCollection')) {
    return {
      GenreCollection: ['Action', 'Comedy', 'Drama', 'Romance', 'Hentai'],
      MediaTagCollection: [
        { name: 'Isekai', category: 'Theme', isAdult: false },
        { name: 'Nudity', category: 'Sexual Content', isAdult: true },
      ],
      ExternalLinkSourceCollection: [{ id: 20, site: 'HIDIVE' }, { id: 5, site: 'Crunchyroll' }, { id: 5, site: 'Crunchyroll' }],
    };
  }
  if (query.includes('studios(search')) {
    return { Page: { studios: [{ id: 569, name: 'MAPPA' }, { id: 43, name: 'ufotable' }].filter((s) => s.name.toLowerCase().includes(v.q.toLowerCase())) } };
  }
  if (query.includes('staff(search')) {
    return {
      Page: {
        staff: Object.entries(STAFF)
          .filter(([, s]) => s.name.toLowerCase().includes(v.q.toLowerCase()))
          .map(([id, s]) => ({ id: Number(id), name: { full: s.name }, primaryOccupations: s.occupations })),
      },
    };
  }
  if (query.includes('Staff(id')) {
    const s = STAFF[v.id];
    if (!s) return { Staff: null };
    return {
      Staff: {
        staffMedia: { pageInfo: { hasNextPage: false }, nodes: s.staffMedia.map((id) => ({ id })) },
        characterMedia: { pageInfo: { hasNextPage: false }, nodes: [...s.characterMedia.map((id) => ({ id, type: 'ANIME' })), { id: 1, type: 'MANGA' }] },
      },
    };
  }
  return pageOf(v);
}

/** `control.fail` = [status, …] makes the next requests fail with those statuses (to test retries). */
export const control = { fail: [], requests: 0, mappingFails: false };

export function startAniList(port = 0) {
  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url.startsWith('/mapping.json')) {
      if (control.mappingFails) return send(503, { error: 'down' });
      return send(200, MAPPING);
    }
    let body = '';
    req.on('data', (c) => (body += c)).on('end', () => {
      control.requests++;
      const fail = control.fail.shift();
      if (fail === 429) return send(429, { errors: [{ message: 'Too Many Requests.' }] }, { 'Retry-After': '0' });
      if (fail) return send(fail, { errors: [{ message: 'Internal Server Error' }] });
      const { query, variables } = JSON.parse(body);
      if (query.includes('__invalid')) return send(400, { errors: [{ message: 'Syntax Error' }] });
      send(200, { data: answer(query, variables || {}) });
    });
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
