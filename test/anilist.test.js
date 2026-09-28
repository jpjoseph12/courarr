import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CONFIG_DIR ??= (await import('node:os')).tmpdir() + '/courarr-test';
const { currentSeason, shiftSeason, resolveSeasonFilter } = await import('../server/anilist.js');

const d = (s) => new Date(`${s}T12:00:00Z`);

test('season from month', () => {
  assert.deepEqual(currentSeason(0, d('2026-01-15')), { season: 'WINTER', year: 2026 });
  assert.deepEqual(currentSeason(0, d('2026-06-30')), { season: 'SPRING', year: 2026 });
  assert.deepEqual(currentSeason(0, d('2026-09-28')), { season: 'SUMMER', year: 2026 });
  assert.deepEqual(currentSeason(0, d('2026-12-01')), { season: 'FALL', year: 2026 });
});

test('rollover switches to the upcoming season early', () => {
  assert.deepEqual(currentSeason(14, d('2026-09-28')), { season: 'FALL', year: 2026 });
  assert.deepEqual(currentSeason(14, d('2026-12-20')), { season: 'WINTER', year: 2027 });
  assert.deepEqual(currentSeason(14, d('2026-09-01')), { season: 'SUMMER', year: 2026 });
});

test('shiftSeason wraps years', () => {
  assert.deepEqual(shiftSeason({ season: 'FALL', year: 2026 }, 1), { season: 'WINTER', year: 2027 });
  assert.deepEqual(shiftSeason({ season: 'WINTER', year: 2026 }, -1), { season: 'FALL', year: 2025 });
  assert.deepEqual(shiftSeason({ season: 'SPRING', year: 2026 }, 4), { season: 'SPRING', year: 2027 });
});

test('season filter → AniList variables', () => {
  const at = d('2026-09-28');
  assert.deepEqual(resolveSeasonFilter({ mode: 'current' }, 14, at), {
    vars: { season: 'FALL', seasonYear: 2026 },
    label: 'Fall 2026',
  });
  assert.equal(resolveSeasonFilter({ mode: 'next' }, 14, at).label, 'Winter 2027');
  assert.equal(resolveSeasonFilter({ mode: 'previous' }, 14, at).label, 'Summer 2026');
  assert.deepEqual(resolveSeasonFilter({ mode: 'year', year: 2025 }, 14, at).vars, {
    startDate_greater: 20250000,
    startDate_lesser: 20260000,
  });
  assert.deepEqual(resolveSeasonFilter({ mode: 'none' }, 14, at).vars, {});
});
