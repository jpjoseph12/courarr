<p align="center"><img src="public/icon.png" width="96" alt="Courarr"></p>

<h1 align="center">Courarr</h1>

<p align="center">Seasonal anime lists from AniList, served as Custom Lists for <b>Sonarr</b> and <b>Radarr</b>.</p>

A *cour* is an anime broadcast season. Courarr lets you build lists like "this season's 50 most popular shows", "new (non-sequel) shows next season" or "this year's anime movies". It turns each list into a feed URL that Sonarr or Radarr imports. Lists refresh every night at 3 AM (configurable) or when you click **Refresh**.

- **Web UI**: build lists with season, format, status, genre, tag, country, popularity and score filters. Preview the results with cover art before saving.
- **Sonarr and Radarr**: series feeds use TVDB IDs; movie feeds use TMDB IDs.
- **Seasons roll forward**: "this season" and "next season" move on their own, switching a configurable number of days before a season starts.
- **Sequels handled**: "Show Season 2" usually has no ID of its own yet, so Courarr uses the earlier season's series. That's also how Sonarr stores it.
- **Fixes when matching fails**: exclude a title from a list, or set its TVDB/TMDB ID by hand.
- **Optional Sonarr/Radarr connection**: exact-title lookups for brand-new shows, "already in library" badges, and an import-list sync right after each refresh.
- **Self-contained**: one container and a SQLite database in `/config`. No accounts or API keys needed to get started.

## Install on Unraid

1. **Docker** tab → at the bottom, **Template repositories** → add `https://github.com/jpjoseph12/courarr` → **Save**.
2. **Add Container** → **Template** → pick **Courarr** under *User templates*/*jpjoseph12* → **Apply**.
3. Open the WebUI (port `6161`).

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

## Connecting a list

Copy a list's feed URL from its card (`http://<server>:6161/feed/<name>`), then:

- **Sonarr** → Settings → Import Lists → **+** → **Custom List** → paste the URL. Set **Series Type: Anime**, then pick a root folder, quality profile and monitor option. *Future Episodes* works well if you already own earlier seasons.
- **Radarr** → Settings → Import Lists → **+** → **Custom Lists** → paste the URL and pick a root folder and quality profile.

Sonarr and Radarr check import lists on their own timer (Radarr every 12 h at most). If you add a Sonarr/Radarr URL and API key in Courarr's **Settings**, Courarr also asks them to sync right after each refresh.

## How matching works

AniList has one entry per season, while Sonarr/Radarr need TVDB/TMDB IDs. For each title Courarr tries these in order:

1. **Manual**: an ID you set with the **#** button (applies to every list).
2. **Mapped**: the community [Fribb/anime-lists](https://github.com/Fribb/anime-lists) mapping, downloaded daily.
3. **Via prequel** (Sonarr): sequels use the earlier season's TVDB series.
4. **Via IMDb** (Radarr, needs a connection): Radarr lookup by the IMDb ID from the mapping.
5. **Title match** (needs a connection): Sonarr/Radarr search, accepted only on an exact title match with the year within ±1.

Brand-new shows can take a few days after they're announced to get a TVDB entry and a mapping. They show as **No match** until then, and the nightly refresh picks them up once they're mapped.

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

Plain Node 24 (built-in `node:sqlite`), Express and a dependency-free front end. There's no build step.

Anime data comes from [AniList](https://anilist.co). ID mappings come from [Fribb/anime-lists](https://github.com/Fribb/anime-lists).

## License

MIT
