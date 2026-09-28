// A tiny stand-in for the TMDB v3 API, for local testing without an API key:
//   node test/fixtures/mock-tmdb.mjs 7071
//   TMDB_BASE_URL=http://localhost:7071/3 npm run dev   (then use API key "test")
// Titles use their real TMDB / TVDB / IMDb ids so Sonarr/Radarr can resolve them.
import http from 'node:http';

const ANIME = 210024;
const TV = [
  { id: 1396, name: 'Breaking Bad', tvdb: 81189, imdb: 'tt0903747', genre_ids: [18, 80], original_language: 'en', origin_country: ['US'], first_air_date: '2008-01-20', vote_average: 8.9, vote_count: 15000, popularity: 300 },
  { id: 100088, name: 'The Last of Us', tvdb: 392256, imdb: 'tt3581920', genre_ids: [18, 10759], original_language: 'en', origin_country: ['US'], first_air_date: '2023-01-15', vote_average: 8.6, vote_count: 5000, popularity: 250 },
  { id: 95396, name: 'Severance', tvdb: 371980, imdb: 'tt11280740', genre_ids: [18, 9648, 10765], original_language: 'en', origin_country: ['US'], first_air_date: '2022-02-17', vote_average: 8.4, vote_count: 2000, popularity: 200 },
  // No TVDB id on purpose: Sonarr has to resolve it from the TMDB id.
  { id: 126308, name: 'Shōgun', tvdb: null, imdb: 'tt2788316', genre_ids: [18, 10768], original_language: 'en', origin_country: ['US'], first_air_date: '2024-02-27', vote_average: 8.5, vote_count: 1500, popularity: 150 },
  { id: 209867, name: "Frieren: Beyond Journey's End", tvdb: 424536, imdb: 'tt22248376', genre_ids: [16, 10759, 10765], original_language: 'ja', origin_country: ['JP'], first_air_date: '2023-09-29', vote_average: 8.8, vote_count: 600, popularity: 120, keywords: [ANIME] },
];
const MOVIE = [
  { id: 693134, title: 'Dune: Part Two', genre_ids: [878, 12], original_language: 'en', release_date: '2024-02-27', vote_average: 8.1, vote_count: 6000, popularity: 280 },
  { id: 872585, title: 'Oppenheimer', genre_ids: [18, 36], original_language: 'en', release_date: '2023-07-19', vote_average: 8.1, vote_count: 9000, popularity: 200 },
  { id: 1022789, title: 'Inside Out 2', genre_ids: [16, 10751, 12, 35], original_language: 'en', release_date: '2024-06-11', vote_average: 7.6, vote_count: 5000, popularity: 180 },
  // Japanese animation without the anime keyword: caught by Courarr's own heuristic.
  { id: 129, title: 'Spirited Away', genre_ids: [16, 10751, 14], original_language: 'ja', release_date: '2001-07-20', vote_average: 8.5, vote_count: 16000, popularity: 90 },
];
const GENRES = {
  tv: [[10759, 'Action & Adventure'], [16, 'Animation'], [35, 'Comedy'], [80, 'Crime'], [18, 'Drama'], [9648, 'Mystery'], [10765, 'Sci-Fi & Fantasy'], [10768, 'War & Politics']],
  movie: [[28, 'Action'], [12, 'Adventure'], [16, 'Animation'], [35, 'Comedy'], [18, 'Drama'], [10751, 'Family'], [14, 'Fantasy'], [36, 'History'], [878, 'Science Fiction']],
};
const KEYWORDS = [{ id: 4379, name: 'time travel' }, { id: 10349, name: 'heist' }, { id: ANIME, name: 'anime' }];

export const requests = [];

function discover(list, q) {
  let r = list;
  const without = (q.get('without_keywords') || '').split(',').filter(Boolean).map(Number);
  if (without.length) r = r.filter((x) => !(x.keywords || []).some((k) => without.includes(k)));
  const withG = (q.get('with_genres') || '').split(',').filter(Boolean).map(Number);
  r = r.filter((x) => withG.every((g) => x.genre_ids.includes(g)));
  const noG = (q.get('without_genres') || '').split(',').filter(Boolean).map(Number);
  r = r.filter((x) => !noG.some((g) => x.genre_ids.includes(g)));
  const minVotes = Number(q.get('vote_count.gte') || 0);
  r = r.filter((x) => x.vote_count >= minVotes);
  const lang = (q.get('with_original_language') || '').split('|').filter(Boolean);
  if (lang.length) r = r.filter((x) => lang.includes(x.original_language));
  return r;
}

const strip = ({ tvdb, imdb, keywords, ...rest }) => ({ ...rest, poster_path: null, adult: false });

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
    if (p === '/configuration') return send(200, { images: {} });
    if ((m = p.match(/^\/genre\/(tv|movie)\/list$/))) return send(200, { genres: GENRES[m[1]].map(([id, name]) => ({ id, name })) });
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
      const all = m[1] === 'discover' ? discover(list, q) : list;
      const page = Number(q.get('page') || 1);
      return send(200, { page, total_pages: Math.max(1, Math.ceil(all.length / 20)), results: all.slice((page - 1) * 20, page * 20).map(strip) });
    }
    if ((m = p.match(/^\/tv\/(\d+)\/external_ids$/))) {
      const show = TV.find((s) => s.id === Number(m[1]));
      return show ? send(200, { id: show.id, tvdb_id: show.tvdb, imdb_id: show.imdb }) : send(404, { status_message: 'Not found' });
    }
    if (p === '/search/keyword') {
      const term = (q.get('query') || '').toLowerCase();
      return send(200, { results: KEYWORDS.filter((k) => k.name.includes(term)) });
    }
    send(404, { status_message: 'The resource you requested could not be found.' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('mock-tmdb.mjs')) {
  const port = Number(process.argv[2]) || 7071;
  start(port).then(() => console.log(`mock TMDB on http://localhost:${port}/3 (api key "test")`));
}
