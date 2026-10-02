import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-tmdb-'));
process.env.TMDB_BASE_URL = 'http://127.0.0.1:7072/3';
const { start } = await import('./fixtures/mock-tmdb.mjs');
const { allowedTvTypes, discoverParams, passesRating, resolveDateFilter, searchTmdb, tmdbClient, tmdbDetails } = await import('../server/tmdb.js');
const { DEFAULT_FILTERS, feedFor } = await import('../server/builder.js');

const at = new Date('2026-09-28T12:00:00Z');
let server;
before(async () => {
  server = await start(7072);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const tvDefaults = () => ({ ...structuredClone(DEFAULT_FILTERS.tmdb.sonarr), minVotes: 0 });
const movieDefaults = () => ({ ...structuredClone(DEFAULT_FILTERS.tmdb.radarr), minVotes: 0, date: { mode: 'any' }, releaseType: 'any' });
const client = () => tmdbClient('test');
const ids = (r) => r.results.map((x) => x.id);

test('date windows', () => {
  assert.deepEqual(resolveDateFilter({ mode: 'lastDays', days: 30 }, 'tv', 'any', at).params, {
    'first_air_date.gte': '2026-08-29',
    'first_air_date.lte': '2026-09-28',
  });
  assert.deepEqual(resolveDateFilter({ mode: 'year', year: 2025 }, 'movie', 'any', at).params, {
    'primary_release_date.gte': '2025-01-01',
    'primary_release_date.lte': '2025-12-31',
  });
  // With a release type, TMDB filters on that release's date instead of the premiere.
  assert.deepEqual(resolveDateFilter({ mode: 'nextDays', days: 7 }, 'movie', 'digital', at).params, {
    'release_date.gte': '2026-09-28',
    'release_date.lte': '2026-10-05',
  });
  assert.equal(resolveDateFilter({ mode: 'airing' }, 'tv', 'any', at).params['air_date.lte'], '2026-10-05');
  const range = resolveDateFilter({ mode: 'range', fromYear: 1990, toYear: 1999 }, 'movie', 'any', at);
  assert.deepEqual(range.params, { 'primary_release_date.gte': '1990-01-01', 'primary_release_date.lte': '1999-12-31' });
  assert.equal(range.label, 'Released 1990–1999');
});

test('discover params', () => {
  const f = {
    ...movieDefaults(), releaseType: 'digital', genresInclude: [28, 12], genresExclude: [27], languages: ['en', 'fr'],
    providers: [8, 9], minRuntime: 90, maxRuntime: 150, companies: [{ id: 923, name: 'Legendary' }],
    people: [{ id: 2037, name: 'Cillian Murphy' }], maxCertification: '12A',
  };
  const p = discoverParams('movie', f, 'GB', at).params;
  assert.equal(p.with_genres, '28,12'); // all
  assert.equal(p.with_original_language, 'en|fr');
  assert.equal(p.with_watch_providers, '8|9');
  assert.equal(p.watch_region, 'GB');
  assert.equal(p.with_release_type, '4|5');
  assert.equal(p.without_keywords, '210024'); // anime excluded by default
  assert.equal(p['with_runtime.gte'], 90);
  assert.equal(p['with_runtime.lte'], 150);
  assert.equal(p.with_companies, '923');
  assert.equal(p.with_people, '2037');
  assert.equal(p['certification.lte'], '12A');
  assert.equal(p.certification_country, 'GB');
  assert.equal(discoverParams('movie', { ...f, genreMatch: 'any' }, 'GB', at).params.with_genres, '28|12');
  // "Keep unrated" moves the rating check to details (discover would drop unrated titles).
  assert.ok(!('certification.lte' in discoverParams('movie', { ...f, keepUnrated: true }, 'GB', at).params));

  const tv = discoverParams('tv', { ...tvDefaults(), networks: [213], excludeAnime: false, people: [{ id: 1 }] }, 'US', at).params;
  assert.equal(tv.with_networks, '213');
  assert.ok(!('without_keywords' in tv));
  assert.ok(!('with_people' in tv), 'discover/tv has no people filter');
  assert.equal(discoverParams('tv', { ...tvDefaults(), sort: 'rating' }, 'US', at).params['vote_count.gte'], 200);
});

test('Sonarr series type decides which TV types are allowed', () => {
  assert.deepEqual(allowedTvTypes({ tvTypes: [], seriesType: 'standard' }), [0, 2, 3, 4, 6]);
  assert.deepEqual(allowedTvTypes({ tvTypes: [4, 5], seriesType: 'standard' }), [4]);
  assert.deepEqual(allowedTvTypes({ tvTypes: [], seriesType: 'daily' }), [1, 5]);
  assert.deepEqual(allowedTvTypes({ tvTypes: [4], seriesType: 'daily' }), [1, 5]);
  assert.equal(discoverParams('tv', tvDefaults(), 'US', at).params.with_type, '0|2|3|4|6');
});

test('standard TV: anime and talk shows left out; daily list gets only talk shows', async () => {
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', tvDefaults(), 'US')), [1396, 100088, 95396, 126308]);
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', { ...tvDefaults(), seriesType: 'daily' }, 'US')), [2224]);
  const withAnime = await searchTmdb(client(), 'tv', { ...tvDefaults(), excludeAnime: false }, 'US');
  assert.ok(ids(withAnime).includes(209867));
});

test('TV details: seasons, episodes, upcoming episode, age rating, people', async () => {
  const c = client();
  assert.deepEqual(ids(await searchTmdb(c, 'tv', { ...tvDefaults(), maxSeasons: 2 }, 'US')), [100088, 95396, 126308]);
  assert.deepEqual(ids(await searchTmdb(c, 'tv', { ...tvDefaults(), minEpisodes: 20 }, 'US')), [1396]);
  assert.deepEqual(ids(await searchTmdb(c, 'tv', { ...tvDefaults(), upcomingEpisode: true }, 'US')), [100088]);
  // GB 15 max: The Last of Us is 18 there; Shōgun has no GB rating (dropped unless keepUnrated).
  assert.deepEqual(ids(await searchTmdb(c, 'tv', { ...tvDefaults(), maxCertification: '15' }, 'GB')), [1396, 95396]);
  assert.deepEqual(
    ids(await searchTmdb(c, 'tv', { ...tvDefaults(), maxCertification: '15', keepUnrated: true }, 'GB')),
    [1396, 95396, 126308],
  );
  const people = await searchTmdb(c, 'tv', { ...tvDefaults(), people: [{ id: 1253360, name: 'Pedro Pascal' }] }, 'US');
  assert.deepEqual(ids(people), [100088]);
  assert.match(people.label, /^Credits/);

  const d = await tmdbDetails(c, 'tv', [1396, 126308]);
  assert.equal(d.get(1396).tvdbId, 81189);
  assert.equal(d.get(1396).seasons, 5);
  assert.equal(d.get(126308).tvdbId, null);
});

test('movies: runtime, age rating, people, companies, sequels, status', async () => {
  const c = client();
  const all = await searchTmdb(c, 'movie', movieDefaults(), 'US');
  assert.ok(!ids(all).includes(129), 'untagged Japanese animation is filtered too');
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), maxRuntime: 160 }, 'US')), [438631, 1022789]);
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), maxCertification: 'PG-13' }, 'US')), [693134, 438631, 1022789]);
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), people: [{ id: 2037 }] }, 'US')), [872585]);
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), companies: [{ id: 923 }] }, 'US')), [693134, 438631]);
  // Dune (2021) is first in its collection, Part Two is the sequel; Oppenheimer is standalone.
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), sequels: 'only' }, 'US')), [693134]);
  assert.ok(!ids(await searchTmdb(c, 'movie', { ...movieDefaults(), sequels: 'exclude' }, 'US')).includes(693134));
  assert.deepEqual(ids(await searchTmdb(c, 'movie', { ...movieDefaults(), movieStatuses: ['Planned'] }, 'US')), []);
});

test('Sonarr feed carries TVDB ids only for matched shows', () => {
  const items = [
    { key: 1396, title: 'Breaking Bad', tmdbId: 1396, tvdbId: 81189, imdbId: 'tt0903747', externalId: 81189 },
    // No TVDB id yet: Sonarr v4 would reject it, so it stays out of the feed.
    { key: 126308, title: 'Shōgun', tmdbId: 126308, tvdbId: null, imdbId: 'tt2788316', externalId: null },
  ];
  assert.deepEqual(feedFor({ source: 'tmdb', target: 'sonarr' }, items), [
    { title: 'Breaking Bad', tvdbId: 81189, tmdbId: 1396, imdbId: 'tt0903747' },
  ]);
});

test('bad key surfaces TMDB’s message', async () => {
  await assert.rejects(tmdbClient('wrong').get('/configuration'), /Invalid API key/);
});

test('min rating: titles below the vote minimum are "not rated yet" and kept unless keepUnscored is off', async () => {
  const f = { ...tvDefaults(), minRating: 8.55, minVotes: 3000 };
  // Breaking Bad 8.9 (15k votes), Last of Us 8.6 (5k), Severance 8.4 (2k), Shōgun 8.5 (1.5k)
  assert.deepEqual(discoverParams('tv', f, 'US').params['vote_average.gte'], undefined, 'checked locally');
  assert.deepEqual(discoverParams('tv', f, 'US').params['vote_count.gte'], undefined);
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', f, 'US')), [1396, 100088, 95396, 126308]);
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', { ...f, minRating: 8.7 }, 'US')), [1396, 95396, 126308], 'rated below the bar: dropped');

  const strict = { ...f, keepUnscored: false };
  assert.equal(discoverParams('tv', strict, 'US').params['vote_average.gte'], 8.55);
  assert.equal(discoverParams('tv', strict, 'US').params['vote_count.gte'], 3000);
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', strict, 'US')), [1396, 100088]);

  // Ranking by rating keeps the vote floor, or a few 10/10 votes would top the list.
  const byRating = { ...f, sort: 'rating' };
  assert.equal(discoverParams('tv', byRating, 'US').params['vote_count.gte'], 3000);
  assert.deepEqual(ids(await searchTmdb(client(), 'tv', byRating, 'US')), [1396, 100088]);

  assert.ok(passesRating({ vote_count: 0 }, { minRating: 7, minVotes: 0 }), 'no votes at all → not rated yet');
  assert.ok(!passesRating({ vote_count: 3, vote_average: 9 }, { minRating: 0, minVotes: 10 }), 'votes alone stay a hard minimum');
  // Missing values (e.g. a list saved by an older version) never throw or misfire.
  assert.ok(passesRating({}, {}));
  assert.ok(passesRating({ vote_count: 0 }, { minRating: 7 }), 'no vote minimum saved: unrated still kept');
  assert.ok(!passesRating({ vote_count: 40, vote_average: 5 }, { minRating: 7 }));
});
