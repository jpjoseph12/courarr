// End-to-end tests of the HTTP API: the real app, with every outside service replaced by a
// local stand-in (AniList, the ID mapping, TMDB, OMDb, Sonarr, Radarr, Maintainerr, webhooks).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

import { control as anilistControl, startAniList } from './fixtures/mock-anilist.mjs';
import { API_KEY, startArr } from './fixtures/mock-arr.mjs';
import { start as startTmdb } from './fixtures/mock-tmdb.mjs';
import { startMaintainerr, startWebhookSink } from './fixtures/mock-services.mjs';

const servers = [];
const url = (s) => `http://127.0.0.1:${s.address().port}`;
let C; // Courarr base URL
let cookie = ''; // logged-in session
let sonarr;
let radarr;
let maintainerr;
let sink;

before(async () => {
  const anilist = await startAniList(0);
  const tmdb = await startTmdb(0);
  // IMDb's daily ratings file. tt0000103 is 7.2 here but 6.1 on OMDb: the file is fresher and wins.
  const ratings = zlib.gzipSync(
    [
      ['tconst', 'averageRating', 'numVotes'],
      ['tt0000101', 8.9, 12000],
      ['tt0000103', 7.2, 300],
      ['tt15239678', 8.5, 700000],
      ['tt15398776', 8.3, 900000],
      ['tt1160419', 8.0, 1000000],
      ['tt22022452', 7.5, 200000],
    ]
      .map((r) => r.join('\t'))
      .join('\n'),
  );
  const omdb = http.createServer((req, res) => {
    if (req.url.startsWith('/title.ratings')) return res.end(ratings);
    const q = new URL(req.url, 'http://x').searchParams;
    res.setHeader('Content-Type', 'application/json');
    if (q.get('apikey') !== 'omdb') return res.end(JSON.stringify({ Response: 'False', Error: 'Invalid API key!' }));
    const scores = {
      tt0111161: { Response: 'True', imdbRating: '9.3', Metascore: '82', Ratings: [{ Source: 'Rotten Tomatoes', Value: '89%' }] },
      tt0000101: { Response: 'True', imdbRating: '8.7', Metascore: 'N/A', Ratings: [{ Source: 'Rotten Tomatoes', Value: '95%' }] },
      tt0000103: { Response: 'True', imdbRating: '6.1', Metascore: 'N/A', Ratings: [] },
    };
    res.end(JSON.stringify(scores[q.get('i')] || { Response: 'False', Error: 'Incorrect IMDb ID.' }));
  });
  await new Promise((r) => omdb.listen(0, r));
  sonarr = await startArr('sonarr', 0);
  radarr = await startArr('radarr', 0);
  maintainerr = await startMaintainerr(0);
  sink = await startWebhookSink(0);
  servers.push(anilist, tmdb, omdb, sonarr.server, radarr.server, maintainerr, sink);

  process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-api-'));
  process.env.ANILIST_URL = url(anilist);
  process.env.ANILIST_MIN_GAP_MS = '0';
  process.env.ANILIST_RETRY_MS = '5';
  process.env.MAPPING_URL = `${url(anilist)}/mapping.json`;
  process.env.TMDB_BASE_URL = `${url(tmdb)}/3`;
  process.env.OMDB_BASE_URL = url(omdb);
  process.env.IMDB_RATINGS_URL = `${url(omdb)}/title.ratings.tsv.gz`;
  anilistControl.mappingFails = false;

  const { app } = await import('../server/app.js');
  const courarr = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  servers.push(courarr);
  C = url(courarr);
  // Every API route needs a login now: create the account and keep its session cookie.
  const r = await fetch(`${C}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery' }),
  });
  assert.equal(r.status, 201);
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
});

async function api(method, p, body) {
  const res = await fetch(C + p, {
    method,
    headers: { Cookie: cookie, 'X-Courarr': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}
const ok = async (method, p, body) => {
  const r = await api(method, p, body);
  assert.ok(r.status < 400, `${method} ${p} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const sinkReceived = async () => (await fetch(`${url(sink)}/received`)).json();
const waitIdle = async () => {
  for (let i = 0; i < 100; i++) {
    if (!(await ok('GET', '/api/status')).running) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('refresh never finished');
};

// ---------------------------------------------------------------------------

describe('web UI and basics', () => {
  test('index is served with version-stamped assets and no-cache', async () => {
    const r = await api('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.body, /app\.js\?v=/);
    assert.match(r.body, /app\.css\?v=/);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    // Every response names the server build; the page embeds the same one, so an open tab can
    // tell when Courarr was updated underneath it and reload.
    const build = r.headers.get('x-courarr-build');
    assert.match(build, /^\d+\.\d+\.\d+-[0-9a-z]+$/);
    assert.ok(r.body.includes(`<meta name="courarr-build" content="${build}" />`));
    assert.ok(r.body.includes(`app.js?v=${build}`));
    assert.equal((await api('GET', '/api/health')).headers.get('x-courarr-build'), build);
    const js = await api('GET', '/app.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('cache-control'), 'no-cache');
  });

  test('unknown API routes are JSON 404s', async () => {
    const r = await api('GET', '/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Not found');
    assert.equal((await api('GET', '/api/lists/abc')).status, 404);
    assert.equal((await api('GET', '/api/lists/9999')).status, 404);
    assert.equal((await api('GET', '/feed/missing')).status, 404);
  });

  test('health, status and metadata', async () => {
    assert.deepEqual((await ok('GET', '/api/health')).ok, true);
    const st = await ok('GET', '/api/status');
    assert.equal(st.schedule, '0 3 * * *');
    assert.ok(st.nextRun === null || typeof st.nextRun === 'string');
    assert.match(st.currentSeason, /^(Winter|Spring|Summer|Fall) \d{4}$/);
    const meta = await ok('GET', '/api/meta');
    assert.ok(!meta.genres.includes('Hentai'), 'adult genre hidden');
    assert.deepEqual(meta.tags.map((t) => t.name), ['Isekai'], 'adult tags hidden');
    assert.deepEqual(meta.streaming.map((s) => s.name), ['Crunchyroll', 'HIDIVE'], 'deduplicated and sorted');
    assert.equal(meta.seriesType.tmdb, 'standard');
  });
});

describe('settings', () => {
  test('validation and key masking', async () => {
    assert.equal((await api('PUT', '/api/settings', { schedule: 'nope' })).status, 400);
    const s = await ok('PUT', '/api/settings', {
      schedule: '0 4 * * *',
      seasonRolloverDays: 99, // clamped
      feedBaseUrl: 'http://courarr.local:6161/',
      tmdbApiKey: 'test',
      tmdbRegion: 'GB',
      omdbApiKey: 'omdb',
      sonarrUrl: `${url(sonarr.server)}/`,
      sonarrApiKey: API_KEY,
      radarrUrl: url(radarr.server),
      radarrApiKey: API_KEY,
      defaultLanguages: ['EN', 'xx1', 'fr'],
      titleLanguage: 'romaji',
      arrLookupFallback: true,
      triggerArrSync: true,
    });
    assert.equal(s.seasonRolloverDays, 45);
    assert.equal(s.feedBaseUrl, 'http://courarr.local:6161');
    assert.equal(s.sonarrUrl, url(sonarr.server));
    assert.deepEqual(s.defaultLanguages, ['en', 'fr']);
    for (const k of ['tmdb', 'omdb', 'sonarr', 'radarr']) {
      assert.equal(s[`${k}ApiKey`], '', `${k} key never sent back`);
      assert.equal(s[`${k}ApiKeySet`], true);
    }
    assert.equal((await ok('GET', '/api/status')).schedule, '0 4 * * *');
    // blank keeps, clear flag removes
    assert.equal((await ok('PUT', '/api/settings', { omdbApiKey: '' })).omdbApiKeySet, true);
    assert.equal((await ok('PUT', '/api/settings', { clearOmdbApiKey: true })).omdbApiKeySet, false);
    await ok('PUT', '/api/settings', { omdbApiKey: 'omdb', titleLanguage: 'english' });
    // turning the schedule off
    await ok('PUT', '/api/settings', { schedule: '' });
    assert.equal((await ok('GET', '/api/status')).nextRun, null);
    await ok('PUT', '/api/settings', { schedule: '0 3 * * *' });
  });

  test('connection tests', async () => {
    const t = (body) => ok('POST', '/api/settings/test', body);
    assert.equal((await t({ kind: 'tmdb' })).ok, true);
    assert.match((await t({ kind: 'tmdb', apiKey: 'bad' })).error, /Invalid API key/);
    assert.match((await t({ kind: 'omdb' })).version, /IMDb 9.3, RT 89%/);
    assert.match((await t({ kind: 'omdb', apiKey: 'bad' })).error, /Invalid API key/);
    assert.equal((await t({ kind: 'sonarr' })).version, '4.0.20');
    assert.equal((await t({ kind: 'radarr' })).appName, 'Radarr');
    assert.match((await t({ kind: 'sonarr', url: 'http://127.0.0.1:1' })).error, /fetch failed/);
    assert.match((await t({ kind: 'sonarr', apiKey: 'wrong' })).error, /HTTP 401/);
    const mt = await t({ kind: 'maintainerr', url: url(maintainerr) });
    assert.equal(mt.ok, true);
    assert.deepEqual(mt.collections.map((c) => [c.title, c.supported]), [['Series - Abandonment', true], ['Keep Latest Season - TV', false]]);
    assert.equal((await api('POST', '/api/settings/test', { kind: 'maintainerr', url: '' })).status, 400);
    assert.equal((await api('POST', '/api/settings/test', { kind: 'plex' })).status, 400);
    assert.equal((await api('POST', '/api/settings/test', { kind: 'radarr', url: '' })).status, 400);
  });

  test('notifiers: validation, secrets kept but never returned, test send', async () => {
    const bad = [
      { type: 'discord', webhookUrl: 'https://example.com/hook' },
      { type: 'telegram', botToken: 'x' },
      { type: 'ntfy', topic: '', server: '' },
      { type: 'gotify', server: 'nope', token: 't' },
      { type: 'webhook', url: 'ftp://x' },
      { type: 'carrier-pigeon' },
    ];
    for (const n of bad) assert.equal((await api('PUT', '/api/settings', { notifiers: [n] })).status, 400, n.type);
    assert.equal((await api('PUT', '/api/settings', { notifiers: 'nope' })).status, 400);

    const saved = await ok('PUT', '/api/settings', {
      notifiers: [
        { type: 'webhook', name: 'sink', url: `${url(sink)}/hook` },
        { type: 'ntfy', topic: 'courarr', token: 'secret-token', enabled: false },
      ],
    });
    const ntfy = saved.notifiers[1];
    assert.equal(ntfy.token, '••••••••');
    // Saving again with the mask keeps the real token (checked by re-reading via a test send below).
    await ok('PUT', '/api/settings', { notifiers: [saved.notifiers[0], ntfy] });
    const r = await ok('POST', '/api/notify/test', saved.notifiers[0]);
    assert.equal(r.ok, true);
    assert.equal((await sinkReceived()).at(-1).event, 'test');
    const fail = await ok('POST', '/api/notify/test', { type: 'webhook', url: 'http://127.0.0.1:1/x' });
    assert.equal(fail.ok, false);
  });
});

describe('search helpers', () => {
  test('TMDB, AniList and network lookups', async () => {
    assert.deepEqual((await ok('GET', '/api/search/keyword?q=time')).map((k) => k.id), [4379]);
    assert.match((await ok('GET', '/api/search/person?q=pedro'))[0].name, /Pedro Pascal \(Acting\)/);
    assert.match((await ok('GET', '/api/search/company?q=pix'))[0].name, /Pixar \(US\)/);
    assert.deepEqual(await ok('GET', '/api/search/studio?q=map'), [{ id: 569, name: 'MAPPA' }]);
    assert.deepEqual(await ok('GET', '/api/search/staff?q=kana'), [{ id: 95185, name: 'Kana Hanazawa (Voice Actor)' }]);
    assert.deepEqual(await ok('GET', '/api/search/staff?q=k'), [], 'one letter is too short to search');
    assert.equal((await api('GET', '/api/search/planet?q=earth')).status, 404);
    assert.deepEqual(await ok('GET', '/api/tmdb/network/49'), { id: 49, name: 'HBO' });
    assert.equal((await api('GET', '/api/tmdb/network/12345')).status, 404);
    assert.equal((await api('GET', '/api/tmdb/network/abc')).status, 400);
    const meta = await ok('GET', '/api/tmdb/meta?kind=movie&region=GB');
    assert.deepEqual(meta.certifications.map((c) => c.code), ['U', 'PG', '12A', '15', '18']);
    assert.ok(meta.sorts.some((s) => s.id === 'revenue'));
    assert.ok(!(await ok('GET', '/api/tmdb/meta?kind=tv&region=GB')).sorts.some((s) => s.id === 'revenue'));
  });
});

describe('lists', () => {
  test('validation and feed names', async () => {
    const bad = async (body, re) => {
      const r = await api('POST', '/api/lists', body);
      assert.equal(r.status, 400);
      assert.match(r.body.error, re);
    };
    await bad({ target: 'sonarr' }, /Name is required/);
    await bad({ name: 'x', target: 'plex' }, /Target/);
    await bad({ name: '!!!', target: 'sonarr' }, /letters or numbers/);
    await bad({ name: 'x', target: 'sonarr', filters: { season: { mode: 'specific', season: 'MONSOON' } } }, /Pick a season/);
    const a = await ok('POST', '/api/lists', { name: 'Same Name', target: 'sonarr' });
    const b = await ok('POST', '/api/lists', { name: 'Same Name', target: 'sonarr' });
    assert.equal(a.slug, 'same-name');
    assert.equal(b.slug, 'same-name-2', 'auto-suffixed');
    await bad({ name: 'x', slug: 'same-name', target: 'sonarr' }, /already used/);
    // sanitising clamps and drops junk
    const c = await ok('POST', '/api/lists', {
      name: 'Clamped',
      source: 'tmdb',
      target: 'radarr',
      filters: { limit: 9999, minRating: 42, languages: ['EN', 'toolong'], tvTypes: [4], sort: 'revenue', collection: 'weird', people: [{ id: 'x' }, { id: 5, name: 'Five' }] },
    });
    assert.equal(c.filters.limit, 500);
    assert.equal(c.filters.minRating, 10);
    assert.deepEqual(c.filters.languages, ['en']);
    assert.deepEqual(c.filters.tvTypes, [], 'show types are TV-only');
    assert.equal(c.filters.collection, 'discover');
    assert.deepEqual(c.filters.people, [{ id: 5, name: 'Five' }]);
    for (const l of [a, b, c]) await ok('DELETE', `/api/lists/${l.id}`);
  });

  test('anime → Sonarr: mapping, prequel, title lookup, library and ignore markers', async () => {
    const p = await ok('POST', '/api/preview', {
      source: 'anilist',
      target: 'sonarr',
      filters: { season: { mode: 'none' }, formats: ['TV'], countries: [] },
    });
    const by = Object.fromEntries(p.items.map((i) => [i.anilistId, i]));
    assert.equal(by[101].matchSource, 'mapping');
    assert.equal(by[101].externalId, 9001);
    assert.equal(by[102].matchSource, 'prequel');
    assert.equal(by[102].externalId, 9001);
    assert.equal(by[104].matchSource, 'lookup', 'Sonarr title search for an unmapped show');
    assert.equal(by[104].externalId, 9004);
    assert.equal(by[103].inLibrary, true, 'Owned Show has tvdb 9003');
    assert.equal(by[101].scores.rt, 95, 'OMDb scores shown on cards');
  });

  test('anime filters: any-genre, studios, streaming, episodes, people, year range', async () => {
    const ids = async (filters) =>
      (await ok('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [], ...filters } })).items.map((i) => i.anilistId);
    assert.deepEqual(await ids({ genresInclude: ['Action', 'Comedy'] }), [101], 'all (native)');
    assert.deepEqual(await ids({ genresInclude: ['Comedy', 'Romance'], genreMatch: 'any' }), [101, 103]);
    assert.deepEqual(await ids({ studios: [{ id: 43, name: 'ufotable' }] }), [103]);
    assert.deepEqual(await ids({ streaming: [5] }), [101]);
    assert.deepEqual(await ids({ maxEpisodes: 13 }), [101, 102, 103], 'unknown episode count passes');
    assert.deepEqual(await ids({ people: [{ id: 95185, name: 'Kana Hanazawa' }] }), [101, 103]);
    // Leave out: the opposite sets.
    assert.deepEqual(await ids({ peopleExclude: [{ id: 95185, name: 'Kana Hanazawa' }] }), [102, 104]);
    assert.deepEqual(await ids({ studiosExclude: [{ id: 43, name: 'ufotable' }] }), [101, 102, 104]);
    assert.deepEqual(await ids({ genresExclude: ['Comedy'] }), [102, 103, 104]);
    // Included and left out at once: leaving out wins, and that's what gets saved.
    const both = await ok('POST', '/api/lists', {
      name: 'Both ways', source: 'anilist', target: 'sonarr',
      filters: { studios: [{ id: 43, name: 'ufotable' }, { id: 569, name: 'MAPPA' }], studiosExclude: [{ id: 43, name: 'ufotable' }], streaming: [5, 10], streamingExclude: [10] },
    });
    assert.deepEqual(both.filters.studios.map((x) => x.id), [569]);
    assert.deepEqual(both.filters.streaming, [5]);
    await ok('DELETE', `/api/lists/${both.id}`);
    assert.deepEqual(await ids({ countries: ['JP', 'KR'] }), [101, 102, 104]);
    assert.deepEqual(await ids({ sequels: 'only' }), [102]);
    const range = await ok('POST', '/api/preview', {
      source: 'anilist', target: 'radarr', filters: { season: { mode: 'range', fromYear: 2015, toYear: 2019 }, formats: ['MOVIE'], countries: [] },
    });
    assert.equal(range.label, 'Released 2015–2019');
    assert.deepEqual(range.items.map((i) => i.anilistId), [105, 106], 'year-only start date (2018) kept');
  });

  test('anime → Radarr: TMDB from mapping, IMDb via Radarr', async () => {
    const p = await ok('POST', '/api/preview', { source: 'anilist', target: 'radarr', filters: { season: { mode: 'none' }, formats: ['MOVIE'], countries: [] } });
    const by = Object.fromEntries(p.items.map((i) => [i.anilistId, i]));
    assert.deepEqual([by[105].matchSource, by[105].externalId, by[105].inLibrary], ['mapping', 7005, true]);
    assert.deepEqual([by[106].matchSource, by[106].externalId], ['imdb', 7006]);
  });

  test('anime scores and age ratings', async () => {
    const pv = (filters) => ok('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [], ...filters } });
    assert.deepEqual((await pv({ minRt: 90, keepUnscored: false })).items.map((i) => i.anilistId), [101]);
    assert.deepEqual((await pv({ minImdb: 6, keepUnscored: true })).items.map((i) => i.anilistId), [101, 102, 103, 104]);
    // IMDb ratings come from IMDb's own file (7.2), not OMDb's older copy (6.1).
    const imdb7 = await pv({ minImdb: 7, keepUnscored: false });
    assert.deepEqual(imdb7.items.map((i) => i.anilistId), [101, 103]);
    assert.deepEqual([imdb7.items[1].scores.imdb, imdb7.items[1].scores.imdbVotes], [7.2, 300]);
    assert.deepEqual((await pv({ minImdb: 8 })).items.map((i) => i.anilistId), [101, 102, 104], 'below the minimum is dropped; no score yet is kept');
    // No TMDB rating for these anime: kept only with keepUnrated.
    assert.equal((await pv({ maxCertification: '15', keepUnrated: false })).items.length, 0);
    assert.equal((await pv({ maxCertification: '15', keepUnrated: true })).items.length, 4);
  });

  test('overrides win over every other match', async () => {
    assert.equal((await api('PUT', '/api/overrides/104', { tvdbId: 'x' })).status, 400);
    assert.equal((await api('PUT', '/api/overrides/abc', { tvdbId: 1 })).status, 400);
    await ok('PUT', '/api/overrides/104', { tvdbId: 5555, title: 'Gamma Unmapped' });
    await ok('PUT', '/api/overrides/104', { tmdbId: 6666 }); // keeps tvdb, adds tmdb
    const o = (await ok('GET', '/api/overrides')).find((x) => x.anilist_id === 104);
    assert.deepEqual([o.tvdb_id, o.tmdb_id, o.title], [5555, 6666, 'Gamma Unmapped']);
    const p = await ok('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [] } });
    const g = p.items.find((i) => i.anilistId === 104);
    assert.deepEqual([g.matchSource, g.externalId], ['override', 5555]);
    assert.equal(await ok('PUT', '/api/overrides/104', { tvdbId: null, tmdbId: '' }), null, 'clearing both removes it');
    await ok('PUT', '/api/overrides/104', { tvdbId: 5555 });
    await ok('DELETE', '/api/overrides/104');
    assert.equal((await ok('GET', '/api/overrides')).length, 0);
  });

  test('refresh, feed, exclusions, retained titles, drip-feed and notifications', async () => {
    const list = await ok('POST', '/api/lists', {
      name: 'Anime feed',
      target: 'sonarr',
      filters: { season: { mode: 'none' }, formats: ['TV'], countries: [], dripMax: 1, keepDays: 7 },
    });
    const before = (await sinkReceived()).length;
    const r1 = await ok('POST', `/api/lists/${list.id}/refresh`);
    const l1 = r1.summary.lists[0];
    // 101 uses the one drip slot; 102 shares its series (free); 103 is owned (free); 104 waits.
    assert.equal(l1.added, 1);
    assert.equal(l1.queued, 1);
    assert.ok(sonarr.state.commands.includes('ImportListSync'), 'asked Sonarr to sync');
    const feed1 = await ok('GET', `/feed/${list.slug}.json`);
    assert.deepEqual(feed1.map((x) => x.tvdbId), [9001, 9003]);
    const notes = (await sinkReceived()).slice(before);
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /Anime feed: 1 new title for Sonarr/);

    // second refresh releases the next queued title
    await ok('POST', `/api/lists/${list.id}/refresh`);
    assert.deepEqual((await ok('GET', `/feed/${list.slug}`)).map((x) => x.tvdbId), [9001, 9003, 9004]);

    // exclusions apply to the feed immediately
    assert.equal((await api('POST', `/api/lists/${list.id}/exclusions`, { key: 'x' })).status, 400);
    await ok('POST', `/api/lists/${list.id}/exclusions`, { key: 104, title: 'Gamma Unmapped' });
    const detail = await ok('GET', `/api/lists/${list.id}`);
    assert.deepEqual(detail.exclusions.map((e) => e.item_key), [104]);
    assert.ok(detail.items.find((i) => i.key === 104).excluded);
    assert.deepEqual((await ok('GET', `/feed/${list.slug}`)).map((x) => x.tvdbId), [9001, 9003]);
    await ok('DELETE', `/api/lists/${list.id}/exclusions/104`);

    // narrowing the filters: dropped titles are kept for keepDays
    await ok('PUT', `/api/lists/${list.id}`, { ...list, filters: { ...list.filters, genresInclude: ['Romance'] } });
    await ok('POST', `/api/lists/${list.id}/refresh`);
    const kept = (await ok('GET', `/api/lists/${list.id}`)).items.filter((i) => i.retained).map((i) => i.key).sort();
    assert.deepEqual(kept, [101, 102, 104]);

    const lists = await ok('GET', '/api/lists');
    const card = lists.find((l) => l.id === list.id);
    assert.equal(card.label, 'Any date');
    assert.ok(card.feedCount >= 3);
    await ok('DELETE', `/api/lists/${list.id}`);
  });

  test('refresh all runs in the background and is logged', async () => {
    await ok('POST', '/api/lists', { name: 'Quick', target: 'radarr', filters: { season: { mode: 'none' }, formats: ['MOVIE'], countries: [] } });
    const r = await api('POST', '/api/refresh');
    assert.equal(r.status, 202);
    await waitIdle();
    const runs = await ok('GET', '/api/runs');
    assert.equal(runs[0].trigger, 'manual');
    assert.equal(runs[0].status, 'ok');
    assert.ok(radarr.state.commands.includes('ImportListSync'));
  });
});

describe('TV & movie lists', () => {
  test('standard vs daily TV, TVDB via Sonarr, movies with details filters', async () => {
    const tv = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0 } });
    const shogun = tv.items.find((i) => i.key === 126308);
    assert.deepEqual([shogun.matchSource, shogun.tvdbId], ['sonarr', 392573], 'TVDB id resolved by Sonarr');
    assert.ok(!tv.items.some((i) => i.key === 2224), 'no talk shows in a Standard list');
    const daily = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0, seriesType: 'daily' } });
    assert.deepEqual(daily.items.map((i) => i.key), [2224]);
    const credits = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0, people: [{ id: 17419, name: 'Bryan Cranston' }] } });
    assert.match(credits.label, /^Credits/);
    const mv = await ok('POST', '/api/preview', {
      source: 'tmdb', target: 'radarr', filters: { minVotes: 0, date: { mode: 'any' }, releaseType: 'any', sequels: 'exclude', maxCertification: 'PG-13', keepUnrated: true },
    });
    assert.ok(mv.items.every((i) => i.key !== 693134), 'sequel left out');
    const trending = await ok('POST', '/api/preview', { source: 'tmdb', target: 'radarr', filters: { collection: 'trending', date: { mode: 'any' }, releaseType: 'any', minRuntime: 150 } });
    assert.match(trending.label, /^Trending/);
    assert.ok(trending.items.every((i) => i.runtime >= 150));
  });

  test('IMDb filter: works without an OMDb key; RT/Metacritic say they need one', async () => {
    const status = await ok('GET', '/api/status');
    assert.ok(status.imdb.titles >= 6, 'ratings file loaded');
    assert.equal((await ok('POST', '/api/imdb/update')).error, null);
    await ok('PUT', '/api/settings', { clearOmdbApiKey: true });
    try {
      const mv = (filters) => ok('POST', '/api/preview', { source: 'tmdb', target: 'radarr', filters: { minVotes: 0, date: { mode: 'any' }, releaseType: 'any', ...filters } });
      const all = await mv({});
      assert.equal(all.items.find((i) => i.key === 872585).scores.imdb, 8.3, 'IMDb on cards without OMDb');
      const good = await mv({ minImdb: 8.2, keepUnscored: false });
      assert.deepEqual(good.items.map((i) => i.key).sort(), [693134, 872585]);
      assert.ok(!good.warnings.some((w) => /OMDb/.test(w)));
      const rt = await mv({ minRt: 90 });
      assert.equal(rt.items.length, all.items.length, 'RT filter skipped');
      assert.ok(rt.warnings.some((w) => /Rotten Tomatoes \/ Metacritic filters skipped/.test(w)));
    } finally {
      await ok('PUT', '/api/settings', { omdbApiKey: 'omdb' });
    }
  });

  test('score fields of the other list type are ignored, never saved and never error', async () => {
    const tvIds = async (filters) =>
      (await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0, ...filters } })).items.map((i) => i.key);
    // A TV list has no AniList score: a stray minimum (even junk) changes nothing.
    const plain = await tvIds({});
    assert.deepEqual(await tvIds({ minScore: 95 }), plain);
    assert.deepEqual(await tvIds({ minScore: 'abc', minPopularity: null }), plain);
    // TV items carry no AniList score.
    const tv = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0 } });
    assert.ok(tv.items.every((i) => i.score === undefined && i.rating != null));

    // An anime list has no TMDB rating or vote count.
    const animeIds = async (filters) =>
      (await ok('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [], ...filters } })).items.map((i) => i.anilistId);
    assert.deepEqual(await animeIds({ minRating: 9.9, minVotes: 100000 }), await animeIds({}));

    // Saved lists keep only their own type's fields.
    const tvList = await ok('POST', '/api/lists', { name: 'Stray score', source: 'tmdb', target: 'sonarr', filters: { minScore: 80, minRating: 7 } });
    assert.equal(tvList.filters.minScore, undefined);
    assert.equal(tvList.filters.minRating, 7);
    const animeList = await ok('POST', '/api/lists', { name: 'Stray rating', source: 'anilist', target: 'sonarr', filters: { minRating: 7, minVotes: 50, minScore: 80 } });
    assert.equal(animeList.filters.minRating, undefined);
    assert.equal(animeList.filters.minVotes, undefined);
    assert.equal(animeList.filters.minScore, 80);
    for (const l of [tvList, animeList]) {
      const run = await ok('POST', `/api/lists/${l.id}/refresh`);
      assert.equal(run.status, 'ok', JSON.stringify(run.summary));
      assert.equal(run.summary.lists[0].error, undefined, 'refreshes cleanly');
      await ok('DELETE', `/api/lists/${l.id}`);
    }
  });

  test('new on my services: needs providers, tracks the catalogue, resets when its scope changes', async () => {
    const noProv = await api('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { collection: 'arrivals', minVotes: 0 } });
    assert.equal(noProv.status, 500);
    assert.match(noProv.body.error, /streaming service/);
    const unsaved = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { collection: 'arrivals', providers: [8], minVotes: 0 } });
    assert.ok(unsaved.warnings.some((w) => /Save the list to start tracking/.test(w)));

    const list = await ok('POST', '/api/lists', { name: 'Arrivals', source: 'tmdb', target: 'sonarr', filters: { collection: 'arrivals', providers: [8], minVotes: 0, arrivalDays: 7 } });
    const r1 = await ok('POST', `/api/lists/${list.id}/refresh`);
    assert.equal(r1.summary.lists[0].total, 0, 'first scan is the baseline');
    assert.ok(r1.summary.warnings.some((w) => /Tracking started/.test(w)));
    assert.match((await ok('GET', '/api/lists')).find((l) => l.id === list.id).label, /New on your services · last 7 days/);
    // Changing which services it watches starts tracking afresh.
    await ok('PUT', `/api/lists/${list.id}`, { ...list, filters: { ...list.filters, providers: [8, 9] } });
    const r2 = await ok('POST', `/api/lists/${list.id}/refresh`);
    assert.ok(r2.summary.warnings.some((w) => /Tracking started/.test(w)));
    await ok('DELETE', `/api/lists/${list.id}`);
  });
});

describe('Sonarr / Radarr import lists', () => {
  test('options, add, rename follows, remove', async () => {
    const opts = await ok('GET', '/api/arr/sonarr/options');
    assert.deepEqual(opts.rootFolders.map((r) => r.path), ['/tv', '/anime']);
    assert.equal((await api('GET', '/api/arr/radarr/options')).status, 200);

    const list = await ok('POST', '/api/lists', { name: 'Linked', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [], seriesType: 'standard' } });
    const info = await ok('GET', `/api/lists/${list.id}/arr`);
    assert.deepEqual([info.connected, info.importList, info.recommendedSeriesType], [true, null, 'standard']);
    assert.equal(info.feedUrl, 'http://courarr.local:6161/feed/linked');

    assert.equal((await api('PUT', `/api/lists/${list.id}/arr`, { qualityProfileId: 1 })).status, 400);
    assert.equal((await api('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/anime' })).status, 400);
    const il = await ok('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/anime', qualityProfileId: 4, monitor: 'future', tags: [3], searchOnAdd: true });
    assert.deepEqual([il.seriesType, il.monitor, il.rootFolderPath, il.url], ['standard', 'future', '/anime', 'http://courarr.local:6161/feed/linked']);
    const stored = sonarr.state.importLists.get(il.id);
    assert.equal(stored.name, 'Courarr – Linked');
    assert.equal(stored.enableAutomaticAdd, true);

    // Renaming keeps the feed URL (Sonarr's link doesn't break); changing the feed name updates it.
    await ok('PUT', `/api/lists/${list.id}`, { ...list, name: 'Linked Renamed' });
    assert.equal(sonarr.state.importLists.get(il.id).name, 'Courarr – Linked Renamed');
    assert.match(sonarr.state.importLists.get(il.id).fields[0].value, /feed\/linked$/);
    await ok('PUT', `/api/lists/${list.id}`, { ...list, name: 'Linked Renamed', slug: 'linked-renamed' });
    assert.match(sonarr.state.importLists.get(il.id).fields[0].value, /feed\/linked-renamed$/);
    assert.equal((await ok('GET', `/api/lists/${list.id}/arr`)).importList.id, il.id);

    await ok('DELETE', `/api/lists/${list.id}/arr`);
    assert.ok(!sonarr.state.importLists.has(il.id));
    assert.equal((await ok('GET', `/api/lists/${list.id}/arr`)).importList, null);

    // Deleting a list removes its import list too; a list deleted on the Sonarr side is forgotten.
    const il2 = await ok('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/tv', qualityProfileId: 1 });
    sonarr.state.importLists.delete(il2.id);
    assert.equal((await ok('GET', `/api/lists/${list.id}/arr`)).importList, null);
    const il3 = await ok('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/tv', qualityProfileId: 1 });
    await ok('DELETE', `/api/lists/${list.id}`);
    assert.ok(!sonarr.state.importLists.has(il3.id));
  });

  test('Radarr import list settings', async () => {
    const list = await ok('POST', '/api/lists', { name: 'Films', target: 'radarr', filters: { season: { mode: 'none' }, formats: ['MOVIE'], countries: [] } });
    const il = await ok('PUT', `/api/lists/${list.id}/arr`, { rootFolderPath: '/movies', qualityProfileId: 1, monitor: 'movieAndCollection', minimumAvailability: 'inCinemas' });
    assert.deepEqual([il.monitor, il.minimumAvailability], ['movieAndCollection', 'inCinemas']);
    assert.equal(radarr.state.importLists.get(il.id).enableAuto, true);
    await ok('DELETE', `/api/lists/${list.id}`);
  });
});

describe('Maintainerr', () => {
  test('collections, sync, ignored titles and stopping new seasons', async () => {
    assert.equal((await api('GET', '/api/maintainerr/collections')).status, 400, 'not connected yet');
    assert.equal((await api('POST', '/api/maintainerr/sync')).status, 400);
    await ok('PUT', '/api/settings', { maintainerrUrl: url(maintainerr), maintainerrCollections: [1, 2], maintainerrStopNewSeasons: true });
    assert.equal((await ok('GET', '/api/maintainerr/collections')).length, 2);
    assert.deepEqual(await ok('POST', '/api/maintainerr/sync'), [{ collection: 'Series - Abandonment', titles: 1 }]);
    const ignored = await ok('GET', '/api/ignored');
    assert.deepEqual(ignored.map((r) => [r.title, r.tvdb_id, r.reason]), [['Breaking Bad', 81189, 'Maintainerr: Series - Abandonment']]);

    // Ignored in feeds; Sonarr's own exclusions too.
    const tv = await ok('POST', '/api/preview', { source: 'tmdb', target: 'sonarr', filters: { minVotes: 0 } });
    assert.equal(tv.items.find((i) => i.key === 1396).ignored, 'Maintainerr: Series - Abandonment');

    // Put an abandoned show in the Sonarr library and refresh: new seasons stop.
    sonarr.state.library.push({
      id: 2, title: 'Breaking Bad', tvdbId: 81189, monitorNewItems: 'all',
      seasons: [{ seasonNumber: 1, monitored: true, statistics: { episodeFileCount: 7 } }, { seasonNumber: 2, monitored: true, statistics: { episodeFileCount: 0 } }],
    });
    await ok('POST', '/api/lists', { name: 'Any TV', source: 'tmdb', target: 'sonarr', filters: { minVotes: 0 } });
    await ok('POST', '/api/refresh');
    await waitIdle();
    const run = (await ok('GET', '/api/runs'))[0];
    assert.deepEqual(run.summary.stoppedNewSeasons, ['Breaking Bad']);
    const bb = sonarr.state.library.find((s) => s.id === 2);
    assert.equal(bb.monitorNewItems, 'none');
    assert.deepEqual(bb.seasons.map((s) => s.monitored), [true, false], 'downloaded seasons untouched');
    await ok('PUT', '/api/settings', { maintainerrStopNewSeasons: false, maintainerrUrl: 'http://127.0.0.1:1' });
    // Maintainerr unreachable: last known collections stay in force, with a warning.
    await ok('POST', '/api/refresh');
    await waitIdle();
    assert.ok((await ok('GET', '/api/runs'))[0].summary.warnings.some((w) => /Maintainerr/.test(w)));
    assert.equal((await ok('GET', '/api/ignored')).length, 1);
  });
});

describe('failures', () => {
  test('a failing list is reported, keeps its last feed, and triggers an error notification', async () => {
    await ok('PUT', '/api/settings', { clearTmdbApiKey: true, notifyOnError: true });
    const list = await ok('POST', '/api/lists', { name: 'Needs TMDB', source: 'tmdb', target: 'radarr', filters: {} });
    const before = (await sinkReceived()).length;
    const r = await ok('POST', `/api/lists/${list.id}/refresh`);
    assert.equal(r.status, 'error');
    assert.match(r.summary.lists[0].error, /TMDB API key/);
    assert.match((await ok('GET', `/api/lists/${list.id}`)).last_error, /TMDB API key/);
    const notes = (await sinkReceived()).slice(before);
    assert.equal(notes.at(-1).event, 'error');
    assert.equal((await api('GET', '/api/tmdb/meta?kind=tv')).status, 400);
    assert.equal((await api('GET', '/api/search/keyword?q=heist')).status, 400);
    await ok('PUT', '/api/settings', { tmdbApiKey: 'test' });
  });

  test('AniList retries on rate limits and server errors, then surfaces the error', async () => {
    anilistControl.fail = [429, 502];
    const p = await ok('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'none' }, formats: ['TV'], countries: [] } });
    assert.ok(p.items.length > 0, 'recovered after retries');
    anilistControl.fail = [500, 500, 500];
    const r = await api('POST', '/api/preview', { source: 'anilist', target: 'sonarr', filters: { season: { mode: 'current' }, formats: ['OVA'], countries: [] } });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /AniList/);
    anilistControl.fail = [];
  });

  test('mapping update: downloads, and keeps the cached copy when the source is down', async () => {
    const m = await ok('POST', '/api/mapping/update');
    assert.equal(m.entries, 5);
    anilistControl.mappingFails = true;
    const kept = await ok('POST', '/api/mapping/update');
    assert.equal(kept.entries, 5);
    assert.match(kept.lastError, /HTTP 503/);
    anilistControl.mappingFails = false;
  });
});
