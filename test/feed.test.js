import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-feed-'));
const { feedFor } = await import('../server/builder.js');

const items = [
  { anilistId: 1, title: 'A', externalId: 100 },
  { anilistId: 2, title: 'A Season 2', externalId: 100 }, // sequel → same TVDB series
  { anilistId: 3, title: 'B', externalId: null },
  { anilistId: 4, title: 'C', externalId: 300, excluded: true },
  { anilistId: 5, title: 'D', externalId: 500 },
];

test('Sonarr feed: tvdbId objects, deduped, skips unmatched and excluded', () => {
  assert.deepEqual(feedFor({ target: 'sonarr' }, items), [
    { title: 'A', tvdbId: 100 },
    { title: 'D', tvdbId: 500 },
  ]);
});

test('Radarr feed: TMDB id in "id" (what Radarr Custom Lists parse)', () => {
  assert.deepEqual(feedFor({ target: 'radarr' }, items), [
    { id: 100, title: 'A' },
    { id: 500, title: 'D' },
  ]);
});
