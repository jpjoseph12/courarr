import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-tmdb-'));
process.env.TMDB_BASE_URL = 'http://127.0.0.1:7072/3';
const { start } = await import('./fixtures/mock-tmdb.mjs');
const { discoverParams, resolveDateFilter, searchTmdb, tmdbClient, tvExternalIds } = await import('../server/tmdb.js');
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
const tvDefaults = () => structuredClone(DEFAULT_FILTERS.tmdb.sonarr);
const movieDefaults = () => structuredClone(DEFAULT_FILTERS.tmdb.radarr);

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
});

test('discover params', () => {
  const f = { ...movieDefaults(), genresInclude: [28, 12], genresExclude: [27], languages: ['en', 'fr'], providers: [8, 9] };
  const p = discoverParams('movie', f, 'GB', at).params;
  assert.equal(p.with_genres, '28,12'); // AND
  assert.equal(p.with_original_language, 'en|fr'); // OR
  assert.equal(p.with_watch_providers, '8|9');
  assert.equal(p.watch_region, 'GB');
  assert.equal(p.with_release_type, '4|5');
  assert.equal(p.region, 'GB');
  assert.equal(p.without_keywords, '210024'); // anime excluded by default
  assert.ok(!('with_networks' in p));

  const tv = discoverParams('tv', { ...tvDefaults(), networks: [213], tvTypes: [4, 2], excludeAnime: false }, 'US', at).params;
  assert.equal(tv.with_networks, '213');
  assert.equal(tv.with_type, '4|2');
  assert.ok(!('without_keywords' in tv));
  // Sorting by rating without a vote floor would surface 10/10-from-one-vote junk.
  assert.equal(discoverParams('tv', { ...tvDefaults(), minVotes: 0, sort: 'rating' }, 'US', at).params['vote_count.gte'], 200);
});

test('search against mock TMDB: anime excluded, TVDB ids resolved, feed shape', async () => {
  const client = tmdbClient('test');
  {
    const tv = await searchTmdb(client, 'tv', { ...tvDefaults(), minVotes: 0 }, 'US');
    assert.deepEqual(tv.results.map((r) => r.id), [1396, 100088, 95396, 126308]); // no Frieren

    const withAnime = await searchTmdb(client, 'tv', { ...tvDefaults(), minVotes: 0, excludeAnime: false }, 'US');
    assert.ok(withAnime.results.some((r) => r.id === 209867));

    const movies = await searchTmdb(client, 'movie', { ...movieDefaults(), minVotes: 0, date: { mode: 'any' } }, 'US');
    assert.ok(!movies.results.some((r) => r.id === 129), 'untagged Japanese animation is filtered too');

    const ids = await tvExternalIds(client, [1396, 126308]);
    assert.deepEqual(ids.get(1396), { tvdbId: 81189, imdbId: 'tt0903747' });
    assert.equal(ids.get(126308).tvdbId, null);

    const items = [
      { key: 1396, title: 'Breaking Bad', tmdbId: 1396, tvdbId: 81189, imdbId: 'tt0903747', externalId: 81189 },
      // No TVDB id yet: Sonarr v4 would reject it, so it stays out of the feed.
      { key: 126308, title: 'Shōgun', tmdbId: 126308, tvdbId: null, imdbId: 'tt2788316', externalId: null },
    ];
    assert.deepEqual(feedFor({ source: 'tmdb', target: 'sonarr' }, items), [
      { title: 'Breaking Bad', tvdbId: 81189, tmdbId: 1396, imdbId: 'tt0903747' },
    ]);
  }
});

test('bad key surfaces TMDB’s message', async () => {
  await assert.rejects(tmdbClient('wrong').get('/configuration'), /Invalid API key/);
});
