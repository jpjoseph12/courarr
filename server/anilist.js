import { log } from './config.js';

const ENDPOINT = 'https://graphql.anilist.co';
// AniList allows 90 req/min but drops to 30/min when degraded; stay under the lower limit.
const MIN_GAP_MS = 2100;
const PER_PAGE = 50;
const MAX_PAGES = 10;
// Filters AniList can't express are applied locally, so scan further to still fill the list.
const MAX_PAGES_LOCAL = 20;

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
      return { vars: yearRangeVars(year, year), label: `Released in ${year}` };
    }
    case 'currentYear':
      return { vars: yearRangeVars(cur.year, cur.year), label: `Released in ${cur.year}` };
    case 'range': {
      const from = Number(sf.fromYear) || cur.year;
      const to = Math.max(Number(sf.toYear) || from, from);
      return { vars: yearRangeVars(from, to), label: from === to ? `Released in ${from}` : `Released ${from}–${to}` };
    }
    case 'lastYears': {
      const n = Math.max(1, Number(sf.years) || 5);
      return { vars: yearRangeVars(cur.year - n + 1, cur.year), label: `Last ${n} year${n > 1 ? 's' : ''}` };
    }
    default:
      return { vars: {}, label: 'Any date' };
  }
  const name = s.season.charAt(0) + s.season.slice(1).toLowerCase();
  return { vars: { season: s.season, seasonYear: s.year }, label: `${name} ${s.year}` };
}

// FuzzyDateInt is YYYYMMDD with zeros for unknown parts (a year-only date is YYYY0000),
// so the lower bound sits just below it to keep year-only dates in range.
const yearRangeVars = (from, to) => ({ startDate_greater: from * 10000 - 1, startDate_lesser: (to + 1) * 10000 });

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
  $countryOfOrigin: CountryCode, $licensedById_in: [Int], $sort: [MediaSort]
) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(
      type: ANIME, isAdult: false, season: $season, seasonYear: $seasonYear,
      format_in: $format_in, status_in: $status_in,
      genre_in: $genre_in, genre_not_in: $genre_not_in, tag_in: $tag_in, tag_not_in: $tag_not_in,
      popularity_greater: $popularity_greater, averageScore_greater: $averageScore_greater,
      startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser,
      countryOfOrigin: $countryOfOrigin, licensedById_in: $licensedById_in, sort: $sort
    ) {
      id idMal
      title { romaji english native }
      synonyms format status season seasonYear episodes duration
      startDate { year month day }
      averageScore popularity genres countryOfOrigin siteUrl
      coverImage { large color }
      studios(isMain: true) { nodes { id name } }
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
const inRange = (v, min, max) => v == null || ((!min || v >= min) && (!max || v <= max)); // unknown passes

/**
 * Turns a list's filters into AniList variables plus a local predicate for what the API
 * can't express: several countries, "any" genre match, sequels, studios, and episode /
 * runtime bounds (AniList's own bounds drop shows whose counts aren't announced yet).
 */
export function mediaQuery(filters, rolloverDays = 0, at = new Date()) {
  const f = filters;
  const season = resolveSeasonFilter(f.season, rolloverDays, at);
  const countries = f.countries || [];
  const anyGenre = f.genreMatch === 'any' && f.genresInclude?.length > 0;
  const studios = new Set((f.studios || []).map((x) => x.id));
  const vars = {
    ...season.vars,
    format_in: f.formats,
    status_in: f.statuses,
    genre_in: anyGenre ? undefined : f.genresInclude,
    genre_not_in: f.genresExclude,
    tag_in: f.tagsInclude,
    tag_not_in: f.tagsExclude,
    popularity_greater: Number(f.minPopularity) > 0 ? Number(f.minPopularity) - 1 : undefined,
    averageScore_greater: Number(f.minScore) > 0 ? Number(f.minScore) - 1 : undefined,
    countryOfOrigin: countries.length === 1 ? countries[0] : undefined,
    licensedById_in: f.streaming,
    sort: [f.sort || 'POPULARITY_DESC', 'ID'],
  };
  for (const k of Object.keys(vars)) if (!nonEmpty(vars[k])) delete vars[k];

  const local = (m) => {
    if (countries.length > 1 && !countries.includes(m.countryOfOrigin)) return false;
    if (f.sequels === 'exclude' && m.isSequel) return false;
    if (f.sequels === 'only' && !m.isSequel) return false;
    if (anyGenre && !f.genresInclude.some((g) => m.genres?.includes(g))) return false;
    if (!inRange(m.episodes, f.minEpisodes, f.maxEpisodes)) return false;
    if (!inRange(m.duration, f.minRuntime, f.maxRuntime)) return false;
    if (studios.size && !(m.studios?.nodes || []).some((st) => studios.has(st.id))) return false;
    return true;
  };
  const heavyLocal =
    anyGenre || studios.size > 0 || f.minEpisodes > 0 || f.maxEpisodes > 0 || f.minRuntime > 0 || f.maxRuntime > 0;
  return { vars, local, heavyLocal, label: season.label };
}

/**
 * Runs a list's filters against AniList and returns raw media, capped at filters.limit.
 * `allowedIds` (people filter) and `acceptBatch` (async checks such as age rating, run
 * once per page) narrow the results further.
 */
export async function searchMedia(filters, rolloverDays, { allowedIds = null, acceptBatch = null } = {}) {
  const { vars, local, heavyLocal, label } = mediaQuery(filters, rolloverDays);
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 500);
  const maxPages = heavyLocal || allowedIds || acceptBatch ? MAX_PAGES_LOCAL : MAX_PAGES;
  const out = [];
  for (let page = 1; page <= maxPages && out.length < limit; page++) {
    const data = await gql(MEDIA_QUERY, { ...vars, page, perPage: PER_PAGE });
    let batch = data.Page.media.filter((m) => {
      m.isSequel = m.relations.edges.some((e) => e.relationType === 'PREQUEL' && e.node.type === 'ANIME');
      return (!allowedIds || allowedIds.has(m.id)) && local(m);
    });
    if (acceptBatch && batch.length) {
      const ok = await acceptBatch(batch);
      batch = batch.filter((_, i) => ok[i]);
    }
    for (const m of batch) {
      out.push(m);
      if (out.length >= limit) break;
    }
    if (!data.Page.pageInfo.hasNextPage) break;
  }
  return { media: out, seasonLabel: label };
}

// ---------- studios & staff ----------

export async function searchStudios(q) {
  if (!q || q.length < 2) return [];
  const data = await gql(`query ($q: String) { Page(perPage: 15) { studios(search: $q) { id name } } }`, { q });
  return data.Page.studios.map((s) => ({ id: s.id, name: s.name }));
}

export async function searchStaff(q) {
  if (!q || q.length < 2) return [];
  const data = await gql(
    `query ($q: String) { Page(perPage: 15) { staff(search: $q) { id name { full } primaryOccupations } } }`,
    { q },
  );
  return data.Page.staff.map((s) => ({
    id: s.id,
    name: s.name.full + (s.primaryOccupations?.length ? ` (${s.primaryOccupations[0]})` : ''),
  }));
}

const staffCache = new Map();
const STAFF_PAGES = 6; // 300 credits of each kind is plenty for a filter

/** Every anime a staff member worked on or voiced (cached for a day). */
export async function staffMediaIds(staffId) {
  const hit = staffCache.get(staffId);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.ids;
  const ids = new Set();
  const q = `query ($id: Int, $page: Int) { Staff(id: $id) {
    staffMedia(type: ANIME, page: $page, perPage: 50) { pageInfo { hasNextPage } nodes { id } }
    characterMedia(page: $page, perPage: 50) { pageInfo { hasNextPage } nodes { id type } } } }`;
  for (let page = 1; page <= STAFF_PAGES; page++) {
    const { Staff: st } = await gql(q, { id: staffId, page });
    if (!st) break;
    st.staffMedia.nodes.forEach((n) => ids.add(n.id));
    st.characterMedia.nodes.filter((n) => n.type === 'ANIME').forEach((n) => ids.add(n.id));
    if (!st.staffMedia.pageInfo.hasNextPage && !st.characterMedia.pageInfo.hasNextPage) break;
  }
  staffCache.set(staffId, { at: Date.now(), ids });
  return ids;
}

// ---------- genre / tag metadata ----------

let metaCache = null;
export async function getMeta() {
  if (metaCache && Date.now() - metaCache.at < 24 * 3600_000) return metaCache.data;
  const data = await gql(`{ GenreCollection MediaTagCollection { name category isAdult }
    ExternalLinkSourceCollection(type: STREAMING, mediaType: ANIME) { id site } }`);
  metaCache = {
    at: Date.now(),
    data: {
      genres: data.GenreCollection.filter((g) => g !== 'Hentai'),
      tags: data.MediaTagCollection.filter((t) => !t.isAdult).map((t) => ({ name: t.name, category: t.category })),
      streaming: [...new Map(data.ExternalLinkSourceCollection.map((x) => [x.site, { id: x.id, name: x.site }])).values()]
        .sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
  return metaCache.data;
}
