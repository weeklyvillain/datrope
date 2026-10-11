# Running Datrope

Each Datrope instance is one server: its channels, voice channels, direct messages, roles and
welcome page. There is nothing to create after installing; registering an account joins the server.

Requirements: a machine with Docker and Docker Compose, and a domain pointing at it.

```bash
cd deploy
cp .env.example .env   # then edit DATROPE_DOMAIN, POSTGRES_PASSWORD and LIVEKIT_API_SECRET
docker compose up -d --build
```

Open `https://<your domain>/register`. The first account you create owns the server and is the
instance admin. Everyone who registers after that becomes a member of the server. New accounts
need an invite by default (Server settings → Invites); change this under Server settings → Sign-ups.

## Features

- Text channels, direct messages and file uploads.
- Messages in Markdown: bold, italic, strikethrough, code, quotes, lists, links and `||spoilers||`.
- Replies, with a quote line that jumps to the original message.
- Mentions: `@username` highlights the message for that person.
- Reactions, with Unicode emoji and the server's custom emoji.
- Custom emoji (Server settings → Emoji): PNG, GIF or WebP, up to 256 KB each and 200 per server.
- Link previews for the first link in a message.
- Categories to group channels (drag to reorder, or pick one in the channel settings); collapsing one is remembered per device.
- Channel topics, shown in the channel header and written in Markdown.
- Pinned messages, up to 50 per channel, listed under the header's pin button.
- Threads: start one from a message in a text channel; replies open in a side panel.
- A text chat beside every voice channel.
- A "New messages" line at the first unread message, with a bar to jump to it or mark the channel read.
- Voice, camera and screen sharing (see below).
- Avatars (PNG, JPEG, WebP or GIF up to 2 MB, cropped to 256 × 256; GIFs are cropped by the server and stay animated), a profile banner (up to 5 MB, cropped 3:1 to 960 × 320, likewise), up to five https links with site names, pronouns and "About me".
- A profile popover on every name and avatar, and a full profile in the side panel (people with Manage roles can change roles there).
- A member list with avatars, presence and status.
- Message search in the header (operators `from:`, `in:`, `has:link`/`has:file`, `before:` and `after:`); it covers only the channels you can read and your DMs.
- A mentions inbox, with unread count and "Mark all read".
- Browser notifications, set per device in Your settings.
- Voice layouts: a grid of everyone, or a stage with one large tile and a strip of the rest.
- Per-person volume (0-200 %) and "Mute for me", just for you: set on your device only, never sent, and a small badge on the tile reminds you.
- A soundboard (Server settings → Soundboard, needs Manage expressions): short sounds anyone with permission to speak and the "Use soundboard" permission (on for @everyone by default) can play in a call. Up to 100 sounds per server; OGG, MP3 or WAV, at most 5 seconds and 512 KB each, with one emoji and a name of up to 32 characters. One play per person every 2 seconds. Shift-click a sound to preview it only for yourself.

Link previews make the server fetch pages from the internet. It only fetches public addresses
(never loopback, private or other internal ranges, also after redirects), reads at most 1 MB of
HTML, and caches each result, failures included, for 24 hours.

## Voice and video

Voice, camera and screen sharing run through [LiveKit](https://livekit.io), which Compose starts
with everything else. Calls do not pass through Caddy, so open these ports to the machine (and
forward them on your router if it is behind NAT):

| Port | Used for |
|---|---|
| 7882/udp | all call audio and video |
| 7881/tcp | the same, for networks that block UDP |
| 3478/udp | TURN, for people behind strict firewalls |
| 30000-30050/udp | TURN relay |

LiveKit finds the machine's public IP address by itself. If it cannot be reached, joining voice
says so and text chat keeps working.

## Music bot

Anyone in a voice channel can queue music with the music panel there: links (YouTube, SoundCloud,
Bandcamp, Vimeo, Spotify), YouTube searches, whole playlist links, the server's saved playlists, or
tracks members uploaded to the server's music library. The bot joins the channel as "Music", and
everyone in the channel shares the queue, pause, skip, stop, shuffle, repeat and clearing the queue.
It leaves when the queue runs out or the channel empties.

The server image includes ffmpeg and yt-dlp. YouTube changes often and old yt-dlp versions stop
working, so rebuild the image now and then (`docker compose build --pull server`). Playing
YouTube this way is against YouTube's terms of service; the library works without it.
`DATROPE_FFMPEG` and `DATROPE_YTDLP` point at other binaries.

- **Sources:** links go through yt-dlp's YouTube, SoundCloud, Bandcamp and Vimeo extractors only.
  `DATROPE_MUSIC_SOURCES` replaces the list (comma-separated yt-dlp extractor names or regexes).
  The generic extractor, which would fetch any URL, is never allowed.
- **Spotify links** play by searching YouTube for each track. They need the Spotify app set up
  for Connections (below); without it they are refused.
- **Uploads** (up to 100 MB) are converted to Opus when uploaded, with their title, artist and
  cover art read from the file. `DATROPE_MUSIC_LIBRARY_MB` caps the library (default 2048).
- **Cache:** links that play to the end are kept in `music-cache` in the data directory so they replay without
  downloading again (not tracks over 20 minutes or live streams). `DATROPE_MUSIC_CACHE_MB` caps it
  (default 2048); `0` turns it off.

## Twitch, YouTube and Spotify

- **Stream alerts:** a channel's settings, Alerts tab, follow YouTube channels (no setup) or
  Twitch streamers. A message is posted when they post a video or go live.
- **Connections:** members link Twitch or Spotify under Settings, Connections, and others see
  when they are live or what they are listening to.

Twitch and Spotify need app credentials, which an instance admin enters under Server settings,
Integrations. Create an app at dev.twitch.tv/console or developer.spotify.com/dashboard and add
the redirect URL that page shows.

## Images

The `imgproxy` container resizes stored images (avatars, emoji, banners, attachments) to the size
clients show them, as WebP when the browser supports it. The server keeps each resized copy in
`/data/variants` on the files volume and deletes it along with the original. The copies can always
be made again, so backups may skip `variants/`. While imgproxy is down, the server serves the
originals. To turn resizing off, remove `DATROPE_IMGPROXY_URL` from the server's environment.

## Backups

Back up the database (this can run while the stack is up):

```bash
docker compose exec -T postgres pg_dump -U datrope datrope > datrope-$(date +%F).sql
```

Uploaded files live in the `datrope_files` volume. Back them up with:

```bash
docker run --rm -v datrope_files:/data:ro -v "$PWD":/backup alpine tar czf /backup/datrope-files-$(date +%F).tgz -C /data .
```

Add `--exclude=./variants` to skip the resized copies.

To restore, run this before starting the server (it keeps the files owned by the server's user):

```bash
docker run --rm -v datrope_files:/data -v "$PWD":/backup alpine sh -c 'tar xzf /backup/datrope-files-YYYY-MM-DD.tgz -C /data && chown -R 65532:65532 /data'
```

Restore into a fresh stack. The dump already contains the schema and the migration
history, so restore into an empty database *before* the server first starts:

```bash
docker compose up -d postgres        # only the database; it must have a fresh, empty volume
docker compose ps postgres           # wait until it shows "healthy"
docker compose exec -T postgres psql -U datrope -d datrope -v ON_ERROR_STOP=1 < datrope-YYYY-MM-DD.sql
docker compose up -d                 # now start everything; migrations are then no-ops
```

Warning: a fresh volume means no existing data. To reset an existing stack for a restore,
`docker compose down -v` deletes the database volume (and Caddy's certificates) permanently.
Only run it if you have a backup you trust.

## Updating

```bash
git pull && docker compose up -d --build
```

Database migrations run automatically when the server starts.

Upgrading to the release with voice and video: `LIVEKIT_API_SECRET` is now required, and the
server refuses to start without it. Add it to `.env`, using letters and digits only (it is
placed inside `LIVEKIT_KEYS`), for example:

```bash
echo "LIVEKIT_API_SECRET=$(openssl rand -hex 32)" >> .env
```

Then open the ports listed under [Voice and video](#voice-and-video).

Upgrading to the release with one server per instance: communities are gone, and the upgrade
migrates them automatically. The oldest community becomes the server and its owner becomes the
server owner (instance admins keep their admin rights), and every account that is not disabled
(or banned from it) becomes a member. Channels from the other communities move into the server,
renamed `<community> · <channel>`. Their `@everyone` overrides now apply to the server's
`@everyone`, so private channels stay private; overrides for their other roles are dropped, and
accounts banned from a folded community are denied viewing its channels. Moderation (kick, ban,
voice moderation, deleting others' messages) now follows role order, so after upgrading review
the order under **Server settings → Roles**. Take a backup first.
