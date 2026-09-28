// A tiny stand-in for the TMDB v3 API, for local testing without an API key:
//   node test/fixtures/mock-tmdb.mjs 7071
//   TMDB_BASE_URL=http://localhost:7071/3 npm run dev   (then use API key "test")
// Titles use their real TMDB / TVDB / IMDb ids so Sonarr/Radarr can resolve them.
import http from 'node:http';

const ANIME = 210024;
const TYPES = ['Documentary', 'News', 'Miniseries', 'Reality', 'Scripted', 'Talk Show', 'Video'];
const TV = [
  { id: 1396, name: 'Breaking Bad', tvdb: 81189, imdb: 'tt0903747', genre_ids: [18, 80], original_language: 'en', origin_country: ['US'], first_air_date: '2008-01-20', vote_average: 8.9, vote_count: 15000, popularity: 300, type: 4, seasons: 5, episodes: 62, runtime: 47, status: 'Ended', cert: { US: 'TV-MA', GB: '15' }, companies: [11073], cast: [17419] },
  { id: 100088, name: 'The Last of Us', tvdb: 392256, imdb: 'tt3581920', genre_ids: [18, 10759], original_language: 'en', origin_country: ['US'], first_air_date: '2023-01-15', vote_average: 8.6, vote_count: 5000, popularity: 250, type: 4, seasons: 2, episodes: 16, runtime: 55, status: 'Returning Series', next: '2026-10-05', cert: { US: 'TV-MA', GB: '18' }, companies: [], cast: [1253360] },
  { id: 95396, name: 'Severance', tvdb: 371980, imdb: 'tt11280740', genre_ids: [18, 9648, 10765], original_language: 'en', origin_country: ['US'], first_air_date: '2022-02-17', vote_average: 8.4, vote_count: 2000, popularity: 200, type: 4, seasons: 2, episodes: 19, runtime: 50, status: 'Returning Series', cert: { US: 'TV-MA', GB: '15' }, companies: [], cast: [] },
  // No TVDB id on purpose: Sonarr has to resolve it from the TMDB id.
  { id: 126308, name: 'Shōgun', tvdb: null, imdb: 'tt2788316', genre_ids: [18, 10768], original_language: 'en', origin_country: ['US'], first_air_date: '2024-02-27', vote_average: 8.5, vote_count: 1500, popularity: 150, type: 2, seasons: 1, episodes: 10, runtime: 60, status: 'Returning Series', cert: { US: 'TV-MA' }, companies: [], cast: [] },
  // A date-based talk show: must only appear in Daily lists.
  { id: 2224, name: 'The Daily Show', tvdb: 71256, imdb: 'tt0115147', genre_ids: [35, 10767], original_language: 'en', origin_country: ['US'], first_air_date: '1996-07-22', vote_average: 6.4, vote_count: 500, popularity: 100, type: 5, seasons: 30, episodes: 4000, runtime: 22, status: 'Returning Series', next: '2026-09-29', cert: { US: 'TV-14' }, companies: [], cast: [] },
  { id: 209867, name: "Frieren: Beyond Journey's End", tvdb: 424536, imdb: 'tt22248376', genre_ids: [16, 10759, 10765], original_language: 'ja', origin_country: ['JP'], first_air_date: '2023-09-29', vote_average: 8.8, vote_count: 600, popularity: 120, keywords: [ANIME], type: 4, seasons: 1, episodes: 28, runtime: 24, status: 'Returning Series', cert: {}, companies: [], cast: [] },
];
const MOVIE = [
  { id: 693134, title: 'Dune: Part Two', genre_ids: [878, 12], original_language: 'en', release_date: '2024-02-27', vote_average: 8.1, vote_count: 6000, popularity: 280, runtime: 167, status: 'Released', imdb: 'tt15239678', collection: 726871, cert: { US: 'PG-13', GB: '12A' }, companies: [923], cast: [1190668] },
  { id: 438631, title: 'Dune', genre_ids: [878, 12], original_language: 'en', release_date: '2021-09-15', vote_average: 7.8, vote_count: 12000, popularity: 150, runtime: 155, status: 'Released', imdb: 'tt1160419', collection: 726871, cert: { US: 'PG-13', GB: '12A' }, companies: [923], cast: [1190668] },
  { id: 872585, title: 'Oppenheimer', genre_ids: [18, 36], original_language: 'en', release_date: '2023-07-19', vote_average: 8.1, vote_count: 9000, popularity: 200, runtime: 181, status: 'Released', imdb: 'tt15398776', cert: { US: 'R', GB: '15' }, companies: [33], cast: [2037] },
  { id: 1022789, title: 'Inside Out 2', genre_ids: [16, 10751, 12, 35], original_language: 'en', release_date: '2024-06-11', vote_average: 7.6, vote_count: 5000, popularity: 180, runtime: 97, status: 'Released', imdb: 'tt22022452', cert: { US: 'PG', GB: 'U' }, companies: [3], cast: [] },
  // Japanese animation without the anime keyword: caught by Courarr's own heuristic.
  { id: 129, title: 'Spirited Away', genre_ids: [16, 10751, 14], original_language: 'ja', release_date: '2001-07-20', vote_average: 8.5, vote_count: 16000, popularity: 90, runtime: 125, status: 'Released', imdb: 'tt0245429', cert: { US: 'PG' }, companies: [10342], cast: [] },
];
const GENRES = {
  tv: [[10759, 'Action & Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'], [18, 'Drama'], [9648, 'Mystery'], [10765, 'Sci-Fi & Fantasy'], [10767, 'Talk'], [10768, 'War & Politics']],
  movie: [[28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'], [878, 'Science Fiction']],
};
const CERTS = {
  tv: { US: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'], GB: ['U', 'PG', '12', '15', '18'] },
  movie: { US: ['G', 'PG', 'PG-13', 'R', 'NC-17'], GB: ['U', 'PG', '12A', '15', '18'] },
};
const KEYWORDS = [{ id: 4379, name: 'time travel' }, { id: 10349, name: 'heist' }, { id: ANIME, name: 'anime' }];
const PEOPLE = [
  { id: 17419, name: 'Bryan Cranston', known_for_department: 'Acting' },
  { id: 1253360, name: 'Pedro Pascal', known_for_department: 'Acting' },
  { id: 1190668, name: 'Timothée Chalamet', known_for_department: 'Acting' },
  { id: 2037, name: 'Cillian Murphy', known_for_department: 'Acting' },
];
const COMPANIES = [{ id: 923, name: 'Legendary Pictures', origin_country: 'US' }, { id: 33, name: 'Universal Pictures', origin_country: 'US' }, { id: 3, name: 'Pixar', origin_country: 'US' }];
const NETWORK_NAMES = { 213: 'Netflix', 49: 'HBO', 174: 'AMC', 88: 'FX' };

export const requests = [];

const ids = (v, sep) => (v || '').split(sep).filter(Boolean).map(Number);

function discover(kind, list, q) {
  let r = list;
  const without = ids(q.get('without_keywords'), ',');
  if (without.length) r = r.filter((x) => !(x.keywords || []).some((k) => without.includes(k)));
  const g = q.get('with_genres') || '';
  if (g.includes('|')) r = r.filter((x) => ids(g, '|').some((id) => x.genre_ids.includes(id)));
  else r = r.filter((x) => ids(g, ',').every((id) => x.genre_ids.includes(id)));
  const noG = ids(q.get('without_genres'), ',');
  r = r.filter((x) => !noG.some((id) => x.genre_ids.includes(id)));
  r = r.filter((x) => x.vote_count >= Number(q.get('vote_count.gte') || 0));
  const lang = (q.get('with_original_language') || '').split('|').filter(Boolean);
  if (lang.length) r = r.filter((x) => lang.includes(x.original_language));
  const types = ids(q.get('with_type'), '|');
  if (kind === 'tv' && types.length) r = r.filter((x) => types.includes(x.type));
  const rmin = Number(q.get('with_runtime.gte') || 0);
  const rmax = Number(q.get('with_runtime.lte') || 0);
  r = r.filter((x) => (!rmin || x.runtime >= rmin) && (!rmax || x.runtime <= rmax));
  const comp = ids(q.get('with_companies'), '|');
  if (comp.length) r = r.filter((x) => x.companies.some((c) => comp.includes(c)));
  const people = ids(q.get('with_people'), '|');
  if (people.length) r = r.filter((x) => x.cast.some((c) => people.includes(c)));
  const certMax = q.get('certification.lte');
  const country = q.get('certification_country');
  if (certMax && country) {
    const order = CERTS[kind][country] || [];
    r = r.filter((x) => x.cert[country] && order.indexOf(x.cert[country]) <= order.indexOf(certMax));
  }
  const dateKey = kind === 'tv' ? 'first_air_date' : 'primary_release_date';
  const field = kind === 'tv' ? 'first_air_date' : 'release_date';
  const gte = q.get(`${dateKey}.gte`) || q.get('release_date.gte');
  const lte = q.get(`${dateKey}.lte`) || q.get('release_date.lte');
  if (gte) r = r.filter((x) => x[field] >= gte);
  if (lte) r = r.filter((x) => x[field] <= lte);
  return r;
}

const strip = ({ tvdb, imdb, keywords, type, seasons, episodes, runtime, status, next, cert, companies, cast, collection, ...rest }) => ({
  ...rest,
  poster_path: null,
  adult: false,
});

function tvDetails(s) {
  return {
    id: s.id,
    name: s.name,
    type: TYPES[s.type],
    number_of_seasons: s.seasons,
    number_of_episodes: s.episodes,
    episode_run_time: [s.runtime],
    status: s.status,
    next_episode_to_air: s.next ? { air_date: s.next } : null,
    external_ids: { tvdb_id: s.tvdb, imdb_id: s.imdb },
    content_ratings: { results: Object.entries(s.cert).map(([c, rating]) => ({ iso_3166_1: c, rating })) },
  };
}

function movieDetails(m) {
  return {
    id: m.id,
    title: m.title,
    runtime: m.runtime,
    status: m.status,
    imdb_id: m.imdb,
    belongs_to_collection: m.collection ? { id: m.collection } : null,
    release_dates: {
      results: Object.entries(m.cert).map(([c, certification]) => ({ iso_3166_1: c, release_dates: [{ type: 3, certification }] })),
    },
  };
}

export function start(port = 7071) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams;
    requests.push({ path: url.pathname, params: Object.fromEntries(q) });
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const auth = q.get('api_key') === 'test' || req.headers.authorization === 'Bearer eyJtest';
    if (url.pathname === '/__requests') return send(200, requests);
    if (!auth) return send(401, { status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' });

    let m;
    const p = url.pathname.replace(/^\/3/, '');
    const term = (q.get('query') || '').toLowerCase();
    if (p === '/configuration') return send(200, { images: {} });
    if ((m = p.match(/^\/genre\/(tv|movie)\/list$/))) return send(200, { genres: GENRES[m[1]].map(([id, name]) => ({ id, name })) });
    if ((m = p.match(/^\/certification\/(tv|movie)\/list$/))) {
      const certifications = Object.fromEntries(
        Object.entries(CERTS[m[1]]).map(([c, list]) => [c, list.map((certification, i) => ({ certification, meaning: '', order: i + 1 }))]),
      );
      return send(200, { certifications });
    }
    if ((m = p.match(/^\/watch\/providers\/(tv|movie)$/))) {
      return send(200, {
        results: [
          { provider_id: 8, provider_name: 'Netflix', display_priority: 1, display_priorities: { GB: 1, US: 1 } },
          { provider_id: 9, provider_name: 'Amazon Prime Video', display_priority: 2, display_priorities: { GB: 2, US: 2 } },
          { provider_id: 337, provider_name: 'Disney Plus', display_priority: 3, display_priorities: { GB: 3, US: 3 } },
        ],
      });
    }
    if ((m = p.match(/^\/(discover|trending)\/(tv|movie)/))) {
      const list = m[2] === 'tv' ? TV : MOVIE;
      const all = m[1] === 'discover' ? discover(m[2], list, q) : list;
      const page = Number(q.get('page') || 1);
      return send(200, { page, total_pages: Math.max(1, Math.ceil(all.length / 20)), results: all.slice((page - 1) * 20, page * 20).map(strip) });
    }
    if ((m = p.match(/^\/tv\/(\d+)$/))) {
      const show = TV.find((s) => s.id === Number(m[1]));
      return show ? send(200, tvDetails(show)) : send(404, { status_message: 'Not found' });
    }
    if ((m = p.match(/^\/tv\/(\d+)\/external_ids$/))) {
      const show = TV.find((s) => s.id === Number(m[1]));
      return show ? send(200, { id: show.id, tvdb_id: show.tvdb, imdb_id: show.imdb }) : send(404, { status_message: 'Not found' });
    }
    if ((m = p.match(/^\/movie\/(\d+)$/))) {
      const film = MOVIE.find((s) => s.id === Number(m[1]));
      return film ? send(200, movieDetails(film)) : send(404, { status_message: 'Not found' });
    }
    if ((m = p.match(/^\/collection\/(\d+)$/))) {
      const parts = MOVIE.filter((x) => x.collection === Number(m[1])).map(strip);
      return send(200, { id: Number(m[1]), parts });
    }
    if ((m = p.match(/^\/person\/(\d+)\/tv_credits$/))) {
      const pid = Number(m[1]);
      return send(200, { cast: TV.filter((s) => s.cast.includes(pid)).map(strip), crew: [] });
    }
    if ((m = p.match(/^\/network\/(\d+)$/))) {
      const name = NETWORK_NAMES[m[1]];
      return name ? send(200, { id: Number(m[1]), name }) : send(404, { status_message: 'Not found' });
    }
    if (p === '/search/keyword') return send(200, { results: KEYWORDS.filter((k) => k.name.includes(term)) });
    if (p === '/search/person') return send(200, { results: PEOPLE.filter((k) => k.name.toLowerCase().includes(term)) });
    if (p === '/search/company') return send(200, { results: COMPANIES.filter((k) => k.name.toLowerCase().includes(term)) });
    send(404, { status_message: 'The resource you requested could not be found.' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-tmdb.mjs')) {
  const port = Number(process.argv[2]) || 7071;
  start(port).then(() => console.log(`mock TMDB on http://localhost:${port}/3 (api key "test")`));
}
