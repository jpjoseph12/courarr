<p align="center"><img src="public/icon.png" width="96" alt="Courarr"></p>

<h1 align="center">Courarr</h1>

<p align="center">Auto-updating lists for <b>Sonarr</b> and <b>Radarr</b>: seasonal anime from AniList, and regular TV & movies from TMDB.</p>

Courarr builds lists from saved searches and serves each one as a feed that Sonarr or Radarr imports. Examples:

- "this season's 50 most popular anime"
- "new scripted series that premiered in the last 30 days, no anime"
- "movies released on digital in the last 60 days rated 6.5+"

Lists refresh every night at 3 AM (configurable) or when you click **Refresh**.

A *cour* is an anime broadcast season, hence the name.

## Two kinds of list

| | **Anime** | **TV & movies** |
|---|---|---|
| Source | [AniList](https://anilist.co) | [TMDB](https://www.themoviedb.org) (free API key) |
| Sonarr series type | **Anime** (or Standard) | **Standard**, or **Daily** for talk shows and news. Anime is left out by default. |
| Radarr | anime films | any films |

The kinds stay separate, so every show reaches Sonarr with the right series type:
- Anime lists only contain anime and use *Anime* (absolute numbering).
- Standard TV lists leave out anime and date-based shows.
- *Daily* lists contain only talk shows and news, which Sonarr matches by air date.

Each list can use its own root folder, e.g. `/tv/anime`, `/tv` and `/tv/daily`.

### Filters

Every list kind has the same set of filters wherever the data supports it.

| | Anime → Sonarr | Anime → Radarr | TV → Sonarr | Movies → Radarr |
|---|---|---|---|---|
| **When**: this/next/last season, a year, a **year range** (with decade buttons), last N years/days, next N days | ✓ | ✓ | ✓ plus "airing this week" | ✓ plus digital vs cinema release |
| **Genres**: require or exclude, match **all or any** | ✓ | ✓ | ✓ | ✓ |
| Tags / keywords | ✓ | ✓ | ✓ | ✓ |
| **Where to watch** | streaming site (Crunchyroll, HIDIVE…) | same | streaming service by region, **network / channel** | streaming service by region |
| **People** | staff & voice actors | same | cast & crew (via their credits) | cast & crew |
| **Studios / companies** | animation studio | same | production company | production company |
| **Runtime** | per episode | film length | per episode | film length |
| **Episodes / seasons** | episodes | – | seasons & episodes, "has an upcoming episode" | – |
| **Age rating** (max for your region, optionally keep unrated) | via TMDB* | via TMDB* | ✓ | ✓ |
| Sequels | ✓ | ✓ | – | first film vs sequels (by collection) |
| Status | ✓ | ✓ | ✓ plus show type | ✓ |
| Popularity / score / rating / votes, rank by, keep top N | ✓ | ✓ | ✓ | ✓ |
| **Keep titles for N days after they drop off** | ✓ | ✓ | ✓ | ✓ |

\* AniList has no age ratings, so anime lists borrow TMDB's through the ID mapping (needs a TMDB key). Titles with no TMDB rating are kept by default.

Episode counts and runtimes that aren't announced yet never exclude a title, so new shows aren't dropped.

## Features

- **Web UI**: build lists with filters and preview the results with posters before saving.
- **Add to Sonarr/Radarr in one click** (optional connection). Courarr creates the Custom List import list with the right series type, root folder, quality profile, monitor option and tags. It keeps that import list in step when you rename the list, and removes it when you delete the list.
- **Automatic dates**: "this season", "next season", "last 30 days" and similar windows move forward on every refresh.
- **Sequels handled**: "Show Season 2" is sent as the same series, which is how Sonarr stores seasons.
- **Fixes when matching fails**: exclude a title from a list, or set an anime title's TVDB/TMDB ID by hand.
- **Library badges**: shows which titles are already in your library, and tells Sonarr/Radarr to sync right after a refresh.
- **Self-contained**: one container and a SQLite database in `/config`.

## Install on Unraid

1. **Docker** tab → at the bottom, **Template repositories** → add `https://github.com/jpjoseph12/courarr` → **Save**.
2. **Add Container** → **Template** → pick **Courarr** → **Apply**.
3. Open the WebUI (port `6161`), go to **Settings** and add:
   - your Sonarr/Radarr URL and API key (optional, but needed for one-click adding),
   - a TMDB key (only for TV & movie lists).

Unraid passes your server's time zone to the container, so "3 AM" is 3 AM local time.

## Docker / Compose

```bash
docker run -d --name courarr -p 6161:6161 \
  -e TZ=Europe/London -v /path/to/config:/config \
  ghcr.io/jpjoseph12/courarr:latest
```

or use the included [`docker-compose.yml`](docker-compose.yml).

| Variable | Default | |
|---|---|---|
| `TZ` | `Etc/UTC` | Time zone for the refresh schedule |
| `PUID` / `PGID` | `99` / `100` | User/group that owns `/config` |
| `UMASK` | `002` | |
| `PORT` | `6161` | Port inside the container |

## TMDB key

TV & movie lists need a free TMDB key. Get one at themoviedb.org → Settings → API, then paste either the *API Key* or the *API Read Access Token* into Courarr's Settings.

## Adding a list without connecting Sonarr/Radarr

Copy the list's feed URL from its card (`http://<server>:6161/feed/<name>`), then:

- **Sonarr** → Settings → Import Lists → **+** → **Custom List** → paste the URL. Set **Series Type** to *Anime* for anime lists or *Standard* for TV lists.
- **Radarr** → Settings → Import Lists → **+** → **Custom Lists** → paste the URL.

## How IDs are matched

Sonarr's Custom List needs TVDB IDs (Sonarr v4 ignores the others), and Radarr's needs TMDB IDs.

**Anime (AniList):**

1. **Manual**: an ID you set with the **#** button.
2. **Mapped**: the community [Fribb/anime-lists](https://github.com/Fribb/anime-lists) mapping, updated daily.
3. **Via prequel** (Sonarr): sequels use the earlier season's TVDB series.
4. **Via IMDb** (Radarr, needs a connection): Radarr lookup by the IMDb ID from the mapping.
5. **Title match** (needs a connection): Sonarr/Radarr search, accepted only on an exact title match with the year within ±1.

**TV & movies (TMDB):**

- Movies use their TMDB ID directly.
- Shows use the TVDB ID that TMDB lists. If TMDB doesn't have one yet, Courarr asks Sonarr to resolve the TMDB ID (needs a connection).

Titles with no ID yet show as **Unmatched** and stay out of the feed until one exists. The nightly refresh picks them up once they're mapped.

## API

| | |
|---|---|
| `GET /feed/:slug` | The list in Sonarr/Radarr Custom List format |
| `POST /api/refresh` | Refresh all enabled lists |
| `POST /api/lists/:id/refresh` | Refresh one list |
| `GET /api/health` | Health check |

## Development

```bash
npm install
npm run dev     # http://localhost:6161, data in ./.config
npm test
```

You can develop without a TMDB key: run `node test/fixtures/mock-tmdb.mjs 7071`, start Courarr with `TMDB_BASE_URL=http://localhost:7071/3`, and use the API key `test`.

Plain Node 24 (built-in `node:sqlite`), Express and a dependency-free front end. There's no build step.

Anime data comes from [AniList](https://anilist.co), and anime ID mappings from [Fribb/anime-lists](https://github.com/Fribb/anime-lists). TV and movie data comes from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT
