<p align="center"><img src="public/icon.png" width="96" alt="Courarr"></p>

<h1 align="center">Courarr</h1>

<p align="center">Auto-updating lists for <b>Sonarr</b> and <b>Radarr</b>: seasonal anime from AniList, and regular TV & movies from TMDB.</p>

Courarr builds lists from saved searches and serves each one as a feed that Sonarr or Radarr imports. Examples:

- "this season's 50 most popular anime"
- "new scripted series that premiered in the last 30 days, no anime"
- "movies released on digital in the last 60 days rated 6.5+"

Lists refresh every night at 3 AM (configurable) or when you click **Refresh**. A *cour* is an anime broadcast season, hence the name.

**Contents:** [Features](#features) · [What you need](#what-you-need) · [Install](#install) · [Networking](#networking-which-address-goes-where) · [First-time setup](#first-time-setup) · [Updating & backups](#updating-backups--uninstalling) · [Security](#security) · [Troubleshooting](#troubleshooting) · [How it works](#how-ids-are-matched) · [Development](#development)

---

## Features

### Two kinds of list

| | **Anime** | **TV & movies** |
|---|---|---|
| Source | [AniList](https://anilist.co) (no key needed) | [TMDB](https://www.themoviedb.org) (free API key) |
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
| **Original language / country** | country | country | ✓ | ✓ |
| **People** | staff & voice actors | same | cast & crew (via their credits) | cast & crew |
| **Studios / companies** | animation studio | same | production company | production company |
| **Runtime** | per episode | film length | per episode | film length |
| **Episodes / seasons** | episodes | – | seasons & episodes, "has an upcoming episode" | – |
| **Age rating** (max for your region, optionally keep unrated) | via TMDB¹ | via TMDB¹ | ✓ | ✓ |
| **Critic & audience scores**: IMDb, Rotten Tomatoes, Metacritic | ✓² | ✓² | ✓² | ✓² |
| Sequels | ✓ | ✓ | – | first film vs sequels (by collection) |
| Status | ✓ | ✓ | ✓ plus show type | ✓ |
| Popularity / score / rating / votes, rank by, keep top N | ✓ | ✓ | ✓ | ✓ |

¹ AniList has no age ratings, so anime lists borrow TMDB's through the ID mapping (needs a TMDB key).
² Via [OMDb](https://www.omdbapi.com) (free key), cached for a week.

Titles with no rating, score, episode count or runtime yet are kept by default, so new releases aren't dropped.

### Smart extras

- **New on my streaming services** (TV & movies): lists titles that newly *arrived* on the services you pick in the last N days.
  - Courarr records the catalogue at every refresh and lists what's new since the last one.
  - Pair it with an **original language** so foreign-language originals don't flood in.
- **Drip-feed**: at most N new titles per refresh, best-ranked first.
  - The rest wait in a queue, so a new 50-title list doesn't make Sonarr/Radarr grab everything at once.
  - Titles you already own don't count.
- **Keep after drop-off**: a title stays in the feed for N days after it falls out of the results, so it doesn't flicker in and out.
- **Notifications**: Discord, Telegram, ntfy, Gotify or a JSON webhook.
  - Sent when titles are added to a list's feed, and when a refresh fails.
  - Can be switched off per list.
- **Maintainerr**: pick collections, e.g. *Series - Abandonment*, and their titles are never sent by any list.
  - Optionally, Sonarr also stops monitoring new seasons of those shows.
  - Titles on Sonarr's/Radarr's own import-list exclusions are skipped too.
- **Add to Sonarr/Radarr in one click**: Courarr creates the import list with the right series type, root folder, quality profile, monitor option and tags, and keeps it in step with renames and deletes.
- **Fixes when matching fails**: exclude a title from a list, or set an anime title's TVDB/TMDB ID by hand.
- **Self-contained**: one small container and a SQLite database in `/config`. No separate database.

---

## What you need

Whatever you run it on, Courarr needs one port and one folder. Everything else is optional.

| What | Container side | Map it to | Required? |
|---|---|---|---|
| **Port** | `6161` (TCP) | any free port on the host, e.g. `6161` | **Yes**. It serves the web UI *and* the feed URLs Sonarr/Radarr read. |
| **Config folder** | `/config` | a persistent folder, e.g. `/mnt/user/appdata/courarr` or `./config` | **Yes**. It holds the database (lists, settings, API keys) and caches. Without it, everything is lost when the container is recreated. |
| `TZ` | environment variable | your time zone, e.g. `Europe/London`, `America/New_York` | Recommended. Scheduled refreshes use it, so "3 AM" is *your* 3 AM (default UTC). |
| `PUID` / `PGID` | environment variables | the user/group that should own `/config` | Optional. Default `99`/`100` (Unraid's `nobody:users`). On most Linux hosts use `1000`/`1000`; `id -u` and `id -g` show yours. |
| `UMASK` | environment variable | e.g. `002` | Optional. Default `002`. |
| `PORT` | environment variable | a port number | Rarely needed. Changes the port *inside* the container. Change the host side of the port mapping instead. |

There's **nothing else to mount**. Courarr never touches your media files; Sonarr and Radarr do the downloading. It needs outbound internet access to reach AniList, TMDB, OMDb and GitHub, plus network access to Sonarr, Radarr and Maintainerr if you connect them.

Image: `ghcr.io/jpjoseph12/courarr:latest` (linux/amd64 and linux/arm64, so Raspberry Pi 4/5 and ARM NAS models work too). Every build is also tagged `sha-<commit>`, so you can pin an exact build; release tags such as `:0.1.0` appear once versions are tagged.

**API keys are entered in the web UI, not as environment variables.** See [First-time setup](#first-time-setup).

---

## Install

### Unraid 7

Unraid 7 no longer has the "Template repositories" box, so the template is added once from the terminal. After that, the install and any later changes happen in the normal Docker UI.

1. Open a terminal (the **>_** icon at the top right) and run:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user && wget -qO /boot/config/plugins/dockerMan/templates-user/my-Courarr.xml https://raw.githubusercontent.com/jpjoseph12/courarr/main/unraid/courarr.xml
   ```
2. **Docker** tab → **Add Container** → **Template** → pick **Courarr** (under *User templates*).
3. Check the fields and click **Apply**. The defaults are:

   | Field | Default |
   |---|---|
   | WebUI Port | `6161` |
   | AppData | `/mnt/user/appdata/courarr` |
   | PUID / PGID / UMASK (under *Show more settings*) | `99` / `100` / `002` |

4. Click the Courarr icon → **WebUI**, then follow [First-time setup](#first-time-setup).

The container is managed by Unraid like any other app:
- **Edit** changes the port, paths or variables.
- **Check for Updates** pulls new versions.
- Unraid sets `TZ` automatically.

### Unraid 6

**Docker** tab → at the bottom, **Template repositories** → add `https://github.com/jpjoseph12/courarr` → **Save**. Then **Add Container** → **Template** → **Courarr** → **Apply**.

### Unraid: filling the form by hand

If you'd rather not use a template, **Add Container** with these values:

| Field | Value |
|---|---|
| Name | `Courarr` |
| Repository | `ghcr.io/jpjoseph12/courarr:latest` |
| Network Type | `Bridge` |
| WebUI | `http://[IP]:[PORT:6161]/` |
| Icon URL | `https://raw.githubusercontent.com/jpjoseph12/courarr/main/public/icon.png` |
| **Add Port**: container `6161` → host `6161` (TCP) | |
| **Add Path**: container `/config` → host `/mnt/user/appdata/courarr` (read/write) | |
| **Add Variable**: `PUID` = `99`, `PGID` = `100` | |

### Docker Compose

Save this as `docker-compose.yml` in a new folder and run `docker compose up -d`:

```yaml
services:
  courarr:
    image: ghcr.io/jpjoseph12/courarr:latest
    container_name: courarr
    restart: unless-stopped
    ports:
      - "6161:6161"            # host:container. Change the left side if 6161 is taken.
    environment:
      - TZ=Europe/London       # your time zone
      - PUID=1000              # `id -u`
      - PGID=1000              # `id -g`
    volumes:
      - ./config:/config       # database, settings and cache. Keep this!
```

Open `http://<your-server>:6161`.

**Running it in the same Compose file as Sonarr/Radarr?** Put them on the same network and they can use each other's service names. The [Networking](#networking-which-address-goes-where) section explains which address goes where.

```yaml
services:
  courarr:
    image: ghcr.io/jpjoseph12/courarr:latest
    restart: unless-stopped
    ports: ["6161:6161"]
    environment: [TZ=Europe/London, PUID=1000, PGID=1000]
    volumes: ["./courarr:/config"]
  sonarr:
    image: lscr.io/linuxserver/sonarr:latest
    # …your existing Sonarr settings…
  radarr:
    image: lscr.io/linuxserver/radarr:latest
    # …your existing Radarr settings…
# In Courarr → Settings:  Sonarr URL = http://sonarr:8989,  Radarr URL = http://radarr:7878,
#                         Feed base URL = http://courarr:6161
```

### docker run

```bash
docker run -d --name courarr --restart unless-stopped \
  -p 6161:6161 \
  -e TZ=Europe/London -e PUID=1000 -e PGID=1000 \
  -v /path/to/courarr/config:/config \
  ghcr.io/jpjoseph12/courarr:latest
```

### Synology, QNAP, TrueNAS, Portainer, CasaOS…

Every container GUI asks for the same things. Use the table in [What you need](#what-you-need):

- **Image**: `ghcr.io/jpjoseph12/courarr:latest`. Some GUIs need the registry `ghcr.io` added first, or accept the full name directly.
- **Port**: container `6161` → any free host port.
- **Volume**: container `/config` → a folder on your storage, e.g. `/volume1/docker/courarr` on Synology.
- **Environment**: `TZ`, plus `PUID`/`PGID` for the user that owns that folder.

Portainer also accepts the Compose file above as a *Stack*.

### Without Docker

Courarr is a plain Node.js app, so it runs anywhere Node **24 or newer** runs:

```bash
git clone https://github.com/jpjoseph12/courarr.git && cd courarr
npm ci --omit=dev
CONFIG_DIR=./config PORT=6161 TZ=Europe/London npm start
```

Keep it running with systemd, pm2 or similar. `CONFIG_DIR` is where the database lives, and it defaults to `/config`.

---

## Networking: which address goes where

Courarr and Sonarr/Radarr talk in **both directions**, and each direction has its own setting:

| Direction | Setting | What to enter |
|---|---|---|
| Courarr → Sonarr / Radarr / Maintainerr (lookups, one-click adding, "in library") | Courarr **Settings** → Sonarr/Radarr/Maintainerr **URL** | An address the *Courarr container* can reach. |
| Sonarr / Radarr → Courarr (reading the feeds) | Courarr **Settings → Feed base URL** | An address *Sonarr/Radarr* can reach Courarr at. Courarr puts it in every import list it creates. |

Which address works depends on how your containers are networked:

| Your setup | Sonarr URL in Courarr | Feed base URL |
|---|---|---|
| Separate containers in **bridge** mode (Unraid default) | `http://<server-ip>:8989`, e.g. `http://192.168.1.10:8989` | leave blank, or `http://<server-ip>:6161` |
| Same **Compose file / custom Docker network** | `http://sonarr:8989` (the service/container name) | `http://courarr:6161` |
| Sonarr on a **different machine** | that machine's IP and port | `http://<courarr-host-ip>:6161` |

Two rules of thumb:
- **Don't use `localhost`.** Inside a container, `localhost` is the container itself, not your server.
- **Leaving Feed base URL blank** uses the address in your browser's address bar, which is fine when that address is also reachable from Sonarr/Radarr (e.g. your server's LAN IP).

---

## First-time setup

Open the web UI → **Settings**. Nothing is required for anime lists; everything else is optional and switched on by adding its key.

| Feature | What to add | Where to get it |
|---|---|---|
| Anime lists | *nothing* | AniList is free and needs no key |
| TV & movie lists, age ratings on anime | **TMDB** API key *or* Read Access Token | themoviedb.org → *Settings → API* (free) |
| Critic & audience score filters | **OMDb** API key | omdbapi.com/apikey.aspx (free, 1,000 lookups/day) |
| One-click **Add to Sonarr/Radarr**, "in library" badges, instant sync, better matching | **Sonarr** / **Radarr** URL + API key | Sonarr/Radarr → *Settings → General → API Key* |
| Skip titles flagged by Maintainerr | **Maintainerr** URL (+ API key if yours uses one) | e.g. `http://<server-ip>:6246` → press **Test**, then tick the collections |
| Notifications | Discord webhook, Telegram bot, ntfy topic, Gotify app token or any webhook URL | the service's own settings, then press **Send test** |

Also in Settings:
- **Refresh schedule**: 3 AM daily by default.
- **Your region**: for streaming services, age ratings and digital release dates.
- **Default original languages**: new TV & movie lists start with these, e.g. English.

Each connection has a **Test** button. Keys are stored in `/config/courarr.db` and are never shown again in the browser.

Then:
1. **Lists → New list**, or start from a template → **Preview** → **Create list**.
2. On the list page, click **Add to Sonarr** / **Add to Radarr**, or copy the feed URL into Sonarr/Radarr yourself:
   - **Sonarr** → *Settings → Import Lists → + → Custom List*, and set **Series Type** to match the list (Anime / Standard / Daily).
   - **Radarr** → *Settings → Import Lists → + → Custom Lists*.

---

## Updating, backups & uninstalling

**Update** by pulling the new image and recreating the container:
- **Unraid:** Docker tab → **Check for Updates** → **Update**.
- **Compose:** `docker compose pull && docker compose up -d`.
- **docker run:** `docker pull …`, then remove and re-create the container with the same options.

Your lists and settings live in `/config` and carry over.

**Back up** by copying the `/config` folder; Unraid's *Appdata Backup* plugin includes it automatically. It holds `courarr.db` (everything you set up, **including API keys**) and `cache/` (downloaded data that re-fetches itself if lost).

**Uninstall** by removing the container, then deleting the config folder. Remove the *Courarr – …* import lists from Sonarr/Radarr too; deleting a list inside Courarr does that for you.

---

## Security

- **The web UI has no login**, like most apps meant for a home network. Anyone who can reach port 6161 can change your lists and read the connection settings.
- **Don't expose it to the internet.** If you want remote access, use a VPN (WireGuard, Tailscale) or a reverse proxy that adds authentication (Authelia, Authentik, basic auth).
- **API keys are stored in plain text** in `/config/courarr.db`, the same way Sonarr and Radarr store theirs. Treat that folder, and its backups, as private.
- **The feed URLs** (`/feed/<name>`) need to stay reachable by Sonarr/Radarr. If you put Courarr behind an authenticating proxy, allow `/feed/*` from them.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Sonarr/Radarr **Test** fails in Courarr | Use an address the Courarr container can reach, not `localhost` (see [Networking](#networking-which-address-goes-where)). Check the API key. |
| Sonarr/Radarr can't read the feed ("unable to connect" on the import list) | Set **Feed base URL** to an address Sonarr/Radarr can reach, e.g. `http://<server-ip>:6161`. Open the list again and click **Edit → Save** in the Sonarr/Radarr bar to update the import list. |
| Radarr says "No results were returned" when adding the list | The feed is empty. Refresh the list first, or widen its filters. Courarr's own **Add to Radarr** skips this check. |
| Titles show as **Unmatched** | Brand-new shows can take a few days to get a TVDB/TMDB ID. The nightly refresh picks them up. For anime you can set one by hand with **#**. |
| TV & movie lists say "Add a TMDB API key" | Add it in Settings → TMDB → **Test**. |
| Refresh happens at the wrong hour | Set `TZ` on the container (Unraid does this for you). |
| "Permission denied" writing `/config` | Set `PUID`/`PGID` to the owner of the host folder, or `chown` it to them. |
| Page looks broken after an update | Hard-refresh the browser (Ctrl+F5). |

**Logs:** `docker logs courarr`, or on Unraid, the container's **Logs** link. The **Activity** page in Courarr shows every refresh and what it did.

---

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

Titles with no ID yet show as **Unmatched** and stay out of the feed until one exists.

## API

| | |
|---|---|
| `GET /feed/:slug` | The list in Sonarr/Radarr Custom List format |
| `POST /api/refresh` | Refresh all enabled lists |
| `POST /api/lists/:id/refresh` | Refresh one list |
| `GET /api/health` | Health check (used by the container's `HEALTHCHECK`) |

## Development

```bash
npm install
npm run dev     # http://localhost:6161, data in ./.config
npm test
```

You can develop without keys:
- **TMDB:** run `node test/fixtures/mock-tmdb.mjs 7071`, then start Courarr with `TMDB_BASE_URL=http://localhost:7071/3` and use the API key `test`.
- **Maintainerr and webhooks:** `node test/fixtures/mock-services.mjs` stands in for Maintainerr (:7075) and a webhook receiver (:7099).

Plain Node 24 (built-in `node:sqlite`), Express and a dependency-free front end. There's no build step. Every push to `main` runs the tests and publishes `ghcr.io/jpjoseph12/courarr` for amd64 and arm64.

Anime data comes from [AniList](https://anilist.co), and anime ID mappings from [Fribb/anime-lists](https://github.com/Fribb/anime-lists). TV and movie data comes from [TMDB](https://www.themoviedb.org), and scores from [OMDb](https://www.omdbapi.com). This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT
