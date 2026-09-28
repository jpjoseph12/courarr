import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'courarr-retain-'));
const { mergeRetained, feedFor } = await import('../server/builder.js');

const now = new Date('2026-09-28T03:00:00Z');
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000).toISOString();

test('fresh results are stamped; nothing is kept when keepDays is 0', () => {
  const out = mergeRetained([{ key: 1, lastSeen: daysAgo(1) }], [{ key: 2 }], 0, now);
  assert.deepEqual(out, [{ key: 2, lastSeen: now.toISOString(), retained: false }]);
});

test('dropped titles stay for keepDays, then go', () => {
  const prev = [
    { key: 1, title: 'still here', lastSeen: daysAgo(1) },
    { key: 2, title: 'dropped yesterday', lastSeen: daysAgo(1), excluded: false },
    { key: 3, title: 'dropped long ago', lastSeen: daysAgo(8) },
  ];
  const out = mergeRetained(prev, [{ key: 1, title: 'still here' }], 7, now);
  assert.deepEqual(out.map((i) => [i.key, i.retained]), [[1, false], [2, true]]);
  // The original lastSeen is kept, so the grace period doesn't restart every refresh.
  assert.equal(out[1].lastSeen, daysAgo(1));
  assert.ok(!('excluded' in out[1]));
});

test('retained titles remain in the feed', () => {
  const items = mergeRetained([{ key: 9, title: 'Kept', externalId: 99, lastSeen: daysAgo(2) }], [], 7, now);
  assert.deepEqual(feedFor({ source: 'anilist', target: 'sonarr' }, items), [{ title: 'Kept', tvdbId: 99 }]);
});
