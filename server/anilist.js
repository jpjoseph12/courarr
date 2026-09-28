import { log } from './config.js';

const ENDPOINT = 'https://graphql.anilist.co';
// AniList allows 90 req/min but drops to 30/min when degraded; stay under the lower limit.
const MIN_GAP_MS = 2100;
const PER_PAGE = 50;
const MAX_PAGES = 10;

export const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];

// ---------- seasons ----------

export function seasonOf(date) {
  return { season: SEASONS[Math.floor(date.getUTCMonth() / 3)], year: date.getUTCFullYear() };
}

export function shiftSeason({ season, year }, n) {
  let i = SEASONS.indexOf(season) + n;
  year += Math.floor(i / 4);
  i = ((i % 4) + 4) % 4;
  return { season: SEASONS[i], year };
}

/** The "current" season, switching to the upcoming one `rolloverDays` before it starts. */
export function currentSeason(rolloverDays = 0, at = new Date()) {
  return seasonOf(new Date(at.getTime() + rolloverDays * 86_400_000));
}

/** Turns a list's season filter into AniList query variables (plus a human label). */
export function resolveSeasonFilter(sf = {}, rolloverDays = 0, at = new Date()) {
  const cur = currentSeason(rolloverDays, at);
  let s;
  switch (sf.mode) {
    case 'current':
      s = cur;
      break;
    case 'next':
      s = shiftSeason(cur, 1);
      break;
    case 'previous':
      s = shiftSeason(cur, -1);
      break;
    case 'specific':
      s = { season: sf.season, year: Number(sf.year) };
      break;
    case 'year': {
      const year = Number(sf.year) || cur.year;
      return {
        vars: { startDate_greater: year * 10000, startDate_lesser: (year + 1) * 10000 },
        label: `Released in ${year}`,
      };
    }
    case 'currentYear':
      return {
        vars: { startDate_greater: cur.year * 10000, startDate_lesser: (cur.year + 1) * 10000 },
        label: `Released in ${cur.year}`,
      };
    default:
      return { vars: {}, label: 'Any date' };
  }
  const name = s.season.charAt(0) + s.season.slice(1).toLowerCase();
  return { vars: { season: s.season, seasonYear: s.year }, label: `${name} ${s.year}` };
}

// ---------- transport ----------

let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gql(query, variables = {}, attempt = 0) {
  const wait = lastCall + MIN_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.status === 429 && attempt < 3) {
    const retryAfter = Number(res.headers.get('retry-after')) || 60;
    log(`AniList rate limited, retrying in ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return gql(query, variables, attempt + 1);
  }
  if (res.status >= 500 && attempt < 2) {
    await sleep(5000);
    return gql(query, variables, attempt + 1);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    const msg = json?.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`AniList: ${msg}`);
  }
  return json.data;
}

// ---------- media search ----------

const MEDIA_QUERY = `
query (
  $page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int,
  $format_in: [MediaFormat], $status_in: [MediaStatus],
  $genre_in: [String], $genre_not_in: [String], $tag_in: [String], $tag_not_in: [String],
  $popularity_greater: Int, $averageScore_greater: Int,
  $startDate_greater: FuzzyDateInt, $startDate_lesser: FuzzyDateInt,
  $countryOfOrigin: CountryCode, $sort: [MediaSort]
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(
      type: ANIME, isAdult: false, season: $season, seasonYear: $seasonYear,
      format_in: $format_in, status_in: $status_in,
      genre_in: $genre_in, genre_not_in: $genre_not_in, tag_in: $tag_in, tag_not_in: $tag_not_in,
      popularity_greater: $popularity_greater, averageScore_greater: $averageScore_greater,
      startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser,
      countryOfOrigin: $countryOfOrigin, sort: $sort
    ) {
      id idMal
      title { romaji english native }
      synonyms format status season seasonYear episodes
      startDate { year month day }
      averageScore popularity genres countryOfOrigin siteUrl
      coverImage { large color }
      studios(isMain: true) { nodes { name } }
      relations {
        edges {
          relationType
          node { id type relations { edges { relationType node { id type } } } }
        }
      }
    }
  }
}`;

const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

/**
 * Runs a list's filters against AniList and returns raw media, capped at filters.limit.
 * Filters the API cannot express (several countries, sequel handling) are applied here.
 */
export async function searchMedia(filters, rolloverDays) {
  const season = resolveSeasonFilter(filters.season, rolloverDays);
  const countries = filters.countries || [];
  const vars = {
    ...season.vars,
    format_in: filters.formats,
    status_in: filters.statuses,
    genre_in: filters.genresInclude,
    genre_not_in: filters.genresExclude,
    tag_in: filters.tagsInclude,
    tag_not_in: filters.tagsExclude,
    popularity_greater: Number(filters.minPopularity) > 0 ? Number(filters.minPopularity) - 1 : undefined,
    averageScore_greater: Number(filters.minScore) > 0 ? Number(filters.minScore) - 1 : undefined,
    countryOfOrigin: countries.length === 1 ? countries[0] : undefined,
    sort: [filters.sort || 'POPULARITY_DESC', 'ID'],
  };
  for (const k of Object.keys(vars)) if (!nonEmpty(vars[k])) delete vars[k];

  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const out = [];
  for (let page = 1; page <= MAX_PAGES && out.length < limit; page++) {
    const data = await gql(MEDIA_QUERY, { ...vars, page, perPage: PER_PAGE });
    for (const m of data.Page.media) {
      m.isSequel = m.relations.edges.some((e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME');
      if (countries.length > 1 && !countries.includes(m.countryOfOrigin)) continue;
      if (filters.sequels === 'exclude' && m.isSequel) continue;
      if (filters.sequels === 'only' && !m.isSequel) continue;
      out.push(m);
      if (out.length >= limit) break;
    }
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return { media: out, seasonLabel: season.label };
}

// ---------- genre / tag metadata ----------

let metaCache = null;
export async function getMeta() {
  if (metaCache && Date.now() - metaCache.at < 24 * 3600_000) return metaCache.data;
  const data = await gql(`{ GenreCollection MediaTagCollection { name category isAdult } }`);
  metaCache = {
    at: Date.now(),
    data: {
      genres: data.GenreCollection.filter((g) => g !== 'Hentai'),
      tags: data.MediaTagCollection.filter((t) => !t.isAdult).map((t) => ({ name: t.name, category: t.category })),
    },
  };
  return metaCache.data;
}
