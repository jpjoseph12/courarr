// IMDb's daily ratings file: download, lookup, conditional re-download and bad-file handling.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';

const LAST_MODIFIED = 'Fri, 02 Oct 2026 00:47:09 GMT';
const TSV = ['tconst\taverageRating\tnumVotes', 'tt0903747\t9.5\t2684233', 'tt22248376\t8.9\t85354', 'tt0000001\t5.7\t2231', 'nm0000001\t9.9\t1'].join('\n');
let body = zlib.gzipSync(TSV);
let status = 200;
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  if (status !== 200) {
    res.statusCode = status;
    return res.end();
  }
  if (req.headers['if-modified-since'] === LAST_MODIFIED) {
    res.statusCode = 304;
    return res.end();
  }
  res.setHeader('Last-Modified', LAST_MODIFIED);
  res.end(body);
});

let imdb;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-imdb-'));
  process.env.IMDB_RATINGS_URL = `http://127.0.0.1:${server.address().port}/title.ratings.tsv.gz`;
  imdb = await import('../server/imdb.js');
});
after(() => server.close());

test('downloads the ratings and looks titles up', async () => {
  assert.equal(imdb.imdbRatings(['tt0903747']), null, 'nothing before the first download');
  assert.equal(await imdb.ensureImdb(), true);
  const r = imdb.imdbRatings(['tt0903747', 'tt22248376', 'tt9999999', 'not-an-id', null]);
  assert.deepEqual(Object.fromEntries(r), {
    tt0903747: { imdb: 9.5, imdbVotes: 2684233 },
    tt22248376: { imdb: 8.9, imdbVotes: 85354 },
  });
  const info = imdb.imdbInfo();
  assert.equal(info.enabled, true);
  assert.equal(info.titles, 3, 'non-title rows are skipped');
  assert.equal(info.error, null);
});

test('a fresh copy is not downloaded again; a forced check sends If-Modified-Since', async () => {
  const before = requests;
  await imdb.ensureImdb();
  await imdb.ensureImdb({ wait: true });
  assert.equal(requests, before, 'still fresh: no request');
  await imdb.ensureImdb({ force: true });
  assert.equal(requests, before + 1);
  assert.equal(imdb.imdbInfo().titles, 3, '304 keeps the ratings');
});

test('a broken download keeps the previous ratings', async () => {
  body = zlib.gzipSync('something\telse\n1\t2');
  // The 304 path would short-circuit, so pretend the file changed by clearing the stored date.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(process.env.CONFIG_DIR, 'cache', 'imdb-ratings.db'));
  db.prepare("DELETE FROM meta WHERE key = 'last_modified'").run();
  db.close();
  assert.equal(await imdb.ensureImdb({ force: true }), true);
  assert.match(imdb.imdbInfo().error, /unexpected format/);
  assert.equal(imdb.imdbRatings(['tt0903747']).get('tt0903747').imdb, 9.5);

  status = 503;
  await imdb.ensureImdb({ force: true });
  assert.match(imdb.imdbInfo().error, /HTTP 503/);
  assert.equal(imdb.imdbInfo().titles, 3);

  status = 200;
  body = zlib.gzipSync(TSV.replace('9.5', '9.4'));
  await imdb.ensureImdb({ force: true });
  assert.equal(imdb.imdbInfo().error, null);
  assert.equal(imdb.imdbRatings(['tt0903747']).get('tt0903747').imdb, 9.4, 'next good file replaces it');
});
