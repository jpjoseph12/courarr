# Publishing Courarr to Unraid Community Applications

The repository is already set up the way the [Community Apps submission portal](https://ca.unraid.net/submit) expects. What's already in place:

| Requirement | Where |
|---|---|
| Public, active GitHub repository | `jpjoseph12/courarr` |
| OSI-approved licence at the root | `LICENSE` (MIT) |
| `ca_profile.xml` with a non-empty `<Profile>` | repo root |
| One Docker template per app, under `templates/` | `templates/courarr.xml` |
| `TemplateURL` pointing at that exact raw file | checked by `test/template.test.js` |
| Icon, README, screenshots, requirements, changelog, licence, minimum Unraid version | in the template |
| Non-privileged container, `PUID`/`PGID`/`UMASK`, appdata path | in the template; CI smoke-tests the image |

`test/template.test.js` runs in CI and fails if the template stops being well-formed, loses a required field, or points at a file, image, port or variable that doesn't exist.

## What's left for you

These need your own accounts, so they can't be automated:

1. **Create a support thread** on the Unraid forums. Community Apps expects one per app.
   - Go to [forums.unraid.net](https://forums.unraid.net) → *Docker Containers* → *Docker Engine* (or whichever board the portal suggests) → start a topic.
   - A draft is below.
   - Then put the thread URL in `<Support>` in `templates/courarr.xml`, and add `<Forum>` to `ca_profile.xml`. GitHub issues can stay under `<Project>`.
2. **Submit the repository** at [ca.unraid.net/submit](https://ca.unraid.net/submit): sign in, add `https://github.com/jpjoseph12/courarr`, then run **Validate** and **Scan** and fix anything they flag.
3. **Wait for moderator review.** Once approved, Courarr shows up in the **Apps** tab of every Unraid server.
4. **Keep it maintained.**
   - Update `<Changes>` and `<Date>` in the template for notable releases.
   - Answer questions in the support thread.
   - Tell the CA moderators if you ever stop maintaining it.

Optional: tag a release (`git tag v1.0.0 && git push --tags`). CI then publishes `:1.0.0` and `:1.0` images alongside `:latest`, so people can pin a version.

## Draft support thread

> **[Support] Courarr: auto-updating anime, TV & movie lists for Sonarr and Radarr**
>
> Courarr builds lists from saved searches and serves each one as a feed that Sonarr or Radarr imports. Examples:
> - "this season's 50 most popular anime"
> - "new scripted series from the last 30 days"
> - "films out on digital this month rated 6.5+"
>
> Lists refresh daily at 3 AM or on demand.
>
> - **Anime** comes from AniList and is added to Sonarr as *Anime* series. **TV & movies** come from TMDB and are added as *Standard* (or *Daily* for talk shows and news).
> - Filters: season or year range, genres, streaming service, network, people, studios, runtime, age rating, IMDb/RT/Metacritic scores.
> - Courarr adds the import lists to Sonarr/Radarr for you with the right series type, root folder and quality profile.
> - Also: drip-feed big lists, skip titles your Maintainerr rules flag, "new on my streaming services", and notifications (Discord, Telegram, ntfy, Gotify).
> - The first visit creates your login and walks you through connecting Sonarr, Radarr and the free TMDB/OMDb keys.
>
> **Install:** Apps → search *Courarr* → Install. AppData defaults to `/mnt/user/appdata/courarr`, and the web UI is on port 6161.
> **Docs and troubleshooting:** https://github.com/jpjoseph12/courarr#readme
> **Image:** `ghcr.io/jpjoseph12/courarr` (amd64 and arm64)
>
> **Before asking for help, please include:**
> - your Courarr version (shown at the top of Settings)
> - the container log (Docker tab → Courarr icon → Logs)
> - which list isn't behaving, plus a screenshot of its filters
>
> **Forgot your password?** Edit the container, set *Reset login* to `true`, start it, create a new login, then set it back to `false`.
