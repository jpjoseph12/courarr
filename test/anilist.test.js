import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CONFIG_DIR ??= (await import('node:os')).tmpdir() + '/courarr-test';
const { currentSeason, shiftSeason, resolveSeasonFilter, mediaQuery } = await import('../server/anilist.js');

const d = (s) => new Date(`${s}T12:00:00Z`);
const at = d('2026-09-28');

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
  assert.deepEqual(resolveSeasonFilter({ mode: 'current' }, 14, at), {
    vars: { season: 'FALL', seasonYear: 2026 },
    label: 'Fall 2026',
  });
  assert.equal(resolveSeasonFilter({ mode: 'next' }, 14, at).label, 'Winter 2027');
  assert.equal(resolveSeasonFilter({ mode: 'previous' }, 14, at).label, 'Summer 2026');
  // Year-only fuzzy dates (20250000) must stay inside the range.
  assert.deepEqual(resolveSeasonFilter({ mode: 'year', year: 2025 }, 14, at).vars, {
    startDate_greater: 20249999,
    startDate_lesser: 20260000,
  });
  assert.deepEqual(resolveSeasonFilter({ mode: 'none' }, 14, at).vars, {});
});

test('year ranges', () => {
  const r = resolveSeasonFilter({ mode: 'range', fromYear: 2010, toYear: 2019 }, 0, at);
  assert.deepEqual(r.vars, { startDate_greater: 20099999, startDate_lesser: 20200000 });
  assert.equal(r.label, 'Released 2010–2019');
  assert.equal(resolveSeasonFilter({ mode: 'lastYears', years: 3 }, 0, at).vars.startDate_greater, 20239999);
});

const base = {
  season: { mode: 'none' }, formats: [], statuses: [], countries: [], genresInclude: [], genresExclude: [],
  tagsInclude: [], tagsExclude: [], sequels: 'include', sort: 'POPULARITY_DESC', limit: 50,
};
const media = (o) => ({ genres: [], episodes: null, duration: null, studios: { nodes: [] }, countryOfOrigin: 'JP', isSequel: false, ...o });

test('genre match: all is native, any is local', () => {
  const all = mediaQuery({ ...base, genresInclude: ['Action', 'Romance'] }, 0, at);
  assert.deepEqual(all.vars.genre_in, ['Action', 'Romance']);
  assert.equal(all.heavyLocal, false);

  const any = mediaQuery({ ...base, genresInclude: ['Action', 'Romance'], genreMatch: 'any' }, 0, at);
  assert.equal(any.vars.genre_in, undefined);
  assert.equal(any.heavyLocal, true);
  assert.ok(any.local(media({ genres: ['Romance'] })));
  assert.ok(!any.local(media({ genres: ['Comedy'] })));
});

test('streaming, studios, episode and runtime bounds', () => {
  const q = mediaQuery(
    { ...base, streaming: [5], studios: [{ id: 569, name: 'MAPPA' }], maxEpisodes: 13, minRuntime: 20 },
    0,
    at,
  );
  assert.deepEqual(q.vars.licensedById_in, [5]);
  assert.ok(q.local(media({ studios: { nodes: [{ id: 569 }] }, episodes: 12, duration: 24 })));
  assert.ok(!q.local(media({ studios: { nodes: [{ id: 1 }] }, episodes: 12, duration: 24 })));
  assert.ok(!q.local(media({ studios: { nodes: [{ id: 569 }] }, episodes: 24, duration: 24 })));
  // Unannounced episode counts / runtimes pass, so new shows aren't dropped.
  assert.ok(q.local(media({ studios: { nodes: [{ id: 569 }] }, episodes: null, duration: null })));
});

test('min score: shows AniList hasn’t scored yet are kept unless keepUnscored is off', () => {
  const keep = mediaQuery({ ...base, minScore: 70 }, 0, at);
  assert.equal(keep.vars.averageScore_greater, undefined, 'AniList’s own filter would drop unscored shows');
  assert.equal(keep.heavyLocal, true);
  assert.ok(keep.local(media({ averageScore: 75 })));
  assert.ok(keep.local(media({ averageScore: 70 })));
  assert.ok(!keep.local(media({ averageScore: 69 })));
  assert.ok(keep.local(media({ averageScore: null })), 'no score yet → kept');

  const strict = mediaQuery({ ...base, minScore: 70, keepUnscored: false }, 0, at);
  assert.equal(strict.vars.averageScore_greater, 69);
  assert.equal(strict.heavyLocal, false);
});
