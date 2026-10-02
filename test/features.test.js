import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-features-'));
process.env.OMDB_BASE_URL = 'http://127.0.0.1:7073';
process.env.TMDB_BASE_URL = 'http://127.0.0.1:7074/3';
process.env.IMDB_RATINGS_URL = 'off';

const { applyDrip, feedFor, markIgnored } = await import('../server/builder.js');
const { omdbClient, scoreCheck, scoresFor, summariseOmdb } = await import('../server/omdb.js');
const { request: notifyRequest } = await import('../server/notify.js');
const { ignoreIndex, ignoredReason, toIgnoredRow } = await import('../server/maintainerr.js');
const { scanCatalogue, tmdbClient } = await import('../server/tmdb.js');
const { start: startTmdb } = await import('./fixtures/mock-tmdb.mjs');
const store = await import('../server/db.js');

// --- a tiny OMDb stand-in ---
const OMDB = {
  tt0903747: { Response: 'True', imdbRating: '9.5', imdbVotes: '2,100,000', Metascore: 'N/A', Ratings: [{ Source: 'Rotten Tomatoes', Value: '96%' }] },
  tt1160419: { Response: 'True', imdbRating: '8.0', Metascore: '74', Ratings: [{ Source: 'Rotten Tomatoes', Value: '83%' }] },
  tt0000001: { Response: 'True', imdbRating: 'N/A', Metascore: 'N/A', Ratings: [] },
};
let omdbServer;
let tmdbServer;
let omdbCalls = 0;
before(async () => {
  omdbServer = http.createServer((req, res) => {
    omdbCalls++;
    const q = new URL(req.url, 'http://x').searchParams;
    res.setHeader('Content-Type', 'application/json');
    if (q.get('apikey') === 'limit') return res.end(JSON.stringify({ Response: 'False', Error: 'Request limit reached!' }));
    if (q.get('apikey') !== 'k') return res.end(JSON.stringify({ Response: 'False', Error: 'Invalid API key!' }));
    res.end(JSON.stringify(OMDB[q.get('i')] || { Response: 'False', Error: 'Incorrect IMDb ID.' }));
  });
  await new Promise((r) => omdbServer.listen(7073, r));
  tmdbServer = await startTmdb(7074);
});
after(() => {
  for (const s of [omdbServer, tmdbServer]) {
    s.closeAllConnections();
    s.close();
  }
});

test('OMDb scores: parsing, caching, filter semantics', async () => {
  assert.deepEqual(summariseOmdb(OMDB.tt1160419), { imdb: 8, imdbVotes: null, rt: 83, metacritic: 74 });
  const c = omdbClient('k');
  const first = await scoresFor(c, ['tt0903747', 'tt1160419', 'tt0000001']);
  assert.equal(first.get('tt0903747').rt, 96);
  assert.equal(first.get('tt0903747').metacritic, null);
  const calls = omdbCalls;
  await scoresFor(c, ['tt0903747', 'tt1160419']);
  assert.equal(omdbCalls, calls, 'second lookup is served from the cache');

  const rt90 = scoreCheck({ minRt: 90, keepUnscored: true });
  assert.ok(rt90(first.get('tt0903747')));
  assert.ok(!rt90(first.get('tt1160419')));
  assert.ok(rt90(first.get('tt0000001')), 'no RT score + keepUnscored → kept');
  assert.ok(!scoreCheck({ minRt: 90, keepUnscored: false })(first.get('tt0000001')));
  assert.ok(scoreCheck({ minImdb: 8, minMetacritic: 70 })(first.get('tt1160419')));
  await assert.rejects(omdbClient('bad').get('tt0903747'), /Invalid API key/);
});

test('OMDb quota reached: unchecked titles never pass a score filter', async () => {
  const warnings = new Set();
  const s = await scoresFor(omdbClient('limit'), ['tt7000001', 'tt7000002', 'tt7000003', 'tt7000004', 'tt7000005', 'tt0903747'], (w) => warnings.add(w));
  assert.deepEqual([...warnings], ['OMDb daily request limit reached']);
  assert.deepEqual(s.get('tt7000005').unchecked, ['imdb', 'rt', 'metacritic'], 'later calls after the limit are unchecked too');
  const rt = scoreCheck({ minRt: 50, keepUnscored: true });
  assert.ok(!rt(s.get('tt7000001')), 'couldn’t check ≠ no score');
  assert.ok(rt(s.get('tt0903747')), 'cached answers still count');
  assert.ok(rt(null), 'no IMDb id at all: unscored, kept');
  assert.ok(!scoreCheck({ minRt: 50, keepUnscored: false })(null));
  assert.equal((await scoresFor(null, ['tt7000009'], () => {}, { omdb: false })).size, 0, 'IMDb-only without the ratings file: nothing to say');
});

test('drip-feed releases N new titles per refresh, best-ranked first', () => {
  const t0 = new Date('2026-09-28T03:00:00Z');
  const t1 = new Date('2026-09-29T03:00:00Z');
  const fresh = (keys, extra = {}) => keys.map((k) => ({ key: k, title: `T${k}`, externalId: k * 10, ...extra[k] }));

  const r1 = applyDrip([], fresh([1, 2, 3, 4, 5], { 2: { inLibrary: true } }), 2, t0);
  // #2 is already owned, so it goes straight in without using the allowance.
  assert.deepEqual(r1.map((i) => [i.key, !!i.queued]), [[1, false], [2, false], [3, false], [4, true], [5, true]]);
  assert.deepEqual(feedFor({ target: 'radarr' }, r1).map((x) => x.id), [10, 20, 30]);

  const r2 = applyDrip(r1, fresh([1, 2, 3, 4, 5, 6]), 2, t1);
  assert.deepEqual(r2.filter((i) => i.queued).map((i) => i.key), [6]);
  assert.equal(r2.find((i) => i.key === 1).fedAt, t0.toISOString(), 'earlier titles keep their date');

  // Lists saved before drip existed: everything already in the feed stays there.
  const legacy = fresh([1, 2, 3]);
  assert.ok(applyDrip(legacy, fresh([1, 2, 3, 4]), 1, t1).every((i) => !i.queued));
  // A sequel of a series already in the feed goes straight in, free.
  const shared = applyDrip(r1, [...fresh([1, 2, 3]), { key: 7, title: 'T1 S2', externalId: 10 }, ...fresh([4])], 1, t1);
  assert.deepEqual(shared.filter((i) => !i.queued).map((i) => i.key), [1, 2, 3, 7, 4]);
  // No limit set: nothing is queued.
  assert.ok(applyDrip([], fresh([1, 2, 3]), 0, t0).every((i) => !i.queued));
});

test('notification payloads per service', () => {
  const evt = {
    kind: 'new',
    list: { name: 'Fall anime', target: 'sonarr' },
    titles: [{ title: 'Frieren', year: 2023, cover: 'https://img/x.jpg' }, { title: 'Dandadan', year: 2024 }],
  };
  const d = notifyRequest({ type: 'discord', webhookUrl: 'https://discord.com/api/webhooks/1/abc' }, evt);
  assert.equal(d.body.embeds[0].title, 'Fall anime: 2 new titles for Sonarr');
  assert.match(d.body.embeds[0].description, /Frieren \(2023\)\nDandadan \(2024\)/);
  assert.equal(d.body.embeds[0].thumbnail.url, 'https://img/x.jpg');

  const t = notifyRequest({ type: 'telegram', botToken: '1:A', chatId: '42' }, evt);
  assert.equal(t.url, 'https://api.telegram.org/bot1:A/sendMessage');
  assert.equal(t.body.chat_id, '42');

  const n = notifyRequest({ type: 'ntfy', topic: 'courarr', token: 'tk' }, evt);
  assert.equal(n.url, 'https://ntfy.sh/courarr');
  assert.equal(n.headers.Authorization, 'Bearer tk');
  assert.equal(n.headers.Title, 'Fall anime: 2 new titles for Sonarr');

  const g = notifyRequest({ type: 'gotify', server: 'http://g:80/', token: 'x' }, { kind: 'error', lists: [{ name: 'A', error: 'boom' }] });
  assert.equal(g.url, 'http://g:80/message?token=x');
  assert.equal(g.body.priority, 7);
  assert.match(g.body.message, /A: boom/);
});

test('Maintainerr items are matched per kind (movie TVDB ids never hit series)', () => {
  const show = toIgnoredRow(
    { mediaServerId: '1', tmdbId: 286723, tvdbId: 457843, mediaData: { title: 'Outcast’s Restaurant', providerIds: { imdb: ['tt36600399'] } } },
    { title: 'Series - Abandonment', type: 'show' },
  );
  const movie = toIgnoredRow(
    { mediaServerId: '2', tmdbId: 82690, tvdbId: 237, mediaData: { title: 'Wreck-It Ralph', providerIds: { imdb: ['tt1772341'] } } },
    { title: 'Leaving Soon', type: 'movie' },
  );
  assert.equal(movie.tvdbId, null);
  const idx = ignoreIndex([show, movie].map((r) => ({ ...r, tvdb_id: r.tvdbId, tmdb_id: r.tmdbId, imdb_id: r.imdbId })));
  assert.equal(ignoredReason(idx, 'show', { tvdbId: 457843 }), 'Maintainerr: Series - Abandonment');
  assert.equal(ignoredReason(idx, 'show', { tvdbId: 237 }), null);
  assert.equal(ignoredReason(idx, 'movie', { tmdbId: 82690 }), 'Maintainerr: Leaving Soon');
  assert.equal(ignoredReason(idx, 'show', { tmdbId: 82690 }), null, 'a movie TMDB id is not a TV TMDB id');

  const ctx = { ignore: idx, arrExcluded: { sonarr: new Set([999]) } };
  const items = markIgnored([{ key: 1, tvdbId: 457843, externalId: 457843 }, { key: 2, externalId: 999 }, { key: 3, externalId: 5 }], 'sonarr', ctx);
  assert.deepEqual(items.map((i) => !!i.ignored), [true, true, false]);
  assert.deepEqual(feedFor({ target: 'sonarr', source: 'anilist' }, items), [{ title: undefined, tvdbId: 5 }]);
});

test('new-on-my-services: the first scan is the baseline; later appearances are arrivals', async () => {
  const list = store.createList({ name: 'arrivals', slug: 'arrivals', source: 'tmdb', target: 'sonarr', filters: {} });
  const f = { providers: [8], languages: [], genresInclude: [], genresExclude: [], countries: [], networks: [], tvStatuses: [], tvTypes: [], seriesType: 'standard', excludeAnime: true };
  const scan = await scanCatalogue(tmdbClient('test'), 'tv', f, 'GB');
  assert.equal(scan.truncated, false);
  const first = store.recordCatalogue(list.id, scan.results.map((r) => r.id).slice(0, 2));
  assert.equal(first.firstSeen.size, 2);
  await new Promise((r) => setTimeout(r, 5));
  const second = store.recordCatalogue(list.id, scan.results.map((r) => r.id));
  const arrived = [...second.firstSeen].filter(([, seen]) => seen > second.baseline).map(([id]) => id);
  assert.deepEqual(arrived.sort(), scan.results.map((r) => r.id).slice(2).sort());
  store.resetCatalogue(list.id);
  assert.equal(store.catalogueState(list.id).baseline, null);
});
