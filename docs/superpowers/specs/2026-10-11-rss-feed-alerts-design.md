# RSS feed alerts

Date: 2026-10-11

## Goal

A channel can follow any RSS or Atom feed and gets a message for each new entry.
The first use is Counter-Strike 2 patch notes (the data behind
counter-strike.net/news/updates), but nothing is game-specific: any Steam game
(`https://store.steampowered.com/feeds/news/app/<appid>`), blog or news site with
a feed works the same way.

Success: an admin adds `https://store.steampowered.com/feeds/news/app/730` with
the name `Counter-Strike 2` and the title filter `Update` to `#cs2`, and the next
CS2 patch shows up there as a readable message (title, patch notes, link), while
non-patch posts ("Rush Hour") are skipped.

## Decisions

- **Delivery:** a message in a text or announcement channel, like stream alerts. No separate updates view.
- **Filtering:** optional per-feed title filter, case-insensitive substring. Empty means every entry.
- **Format:** title, entry body converted from HTML to Markdown and truncated, then the link.
- **Name:** optional per-feed display name, defaulting to the feed's title (Steam's is "730 RSS Feed", so the override matters).
- **Storage:** extend `stream_alerts` with a new platform `rss` instead of a new table, reusing its handlers, permissions, per-channel limit and UI.
- No Steam-specific code, no generic "source plug-in" abstraction. RSS is the generic interface.

## Data

Migration `00036_feed_alerts.sql`:

- `stream_alerts.platform` CHECK allows `'rss'`.
- New column `title_filter TEXT NOT NULL DEFAULT ''`.

For `rss` rows:

| Column | Meaning |
|---|---|
| `account` | The feed URL, trimmed, `http`/`https` only. |
| `display_name` | The name messages are posted under: the Name field, else the feed's title, else the URL host. |
| `last_item` | ID of the newest entry already handled: `<guid>` (RSS) or `<id>` (Atom), falling back to `<link>`. |
| `title_filter` | Substring entry titles must contain. |

`UNIQUE (channel_id, platform, account)` stays: a channel follows a feed once.

## API

`CreateAlertRequest` gains:

- `platform` enum adds `rss`.
- `name` (optional, max 100): display name for `rss`. Ignored for other platforms.
- `title_filter` (optional, max 100). Ignored for other platforms.

`StreamAlert` gains `title_filter` (empty for other platforms). `URL` for `rss` is the feed URL.

Create, for `rss`:

1. Parse `account` as an absolute `http`/`https` URL, else `BAD_ACCOUNT` ("use a feed URL starting with https://").
2. Fetch and parse it once (see Fetching). Failure → `BAD_ACCOUNT` ("that URL is not an RSS or Atom feed").
3. Set `display_name` as described under Data.
4. `last_item` = ID of the feed's newest entry, so the backlog is never posted (same as YouTube seeding).

List and delete are unchanged.

## Fetching and parsing

New file `server/internal/integrations/feeds.go`.

- HTTP client: `linkpreview.NewClient(linkpreview.Public, 15*time.Second)`, so a feed URL can't make the server reach private networks. Response body capped at 2 MB.
- Parsing with `encoding/xml` into a small struct covering RSS 2.0 (`channel/title`, `item/{title,link,guid,description,content:encoded}`) and Atom (`feed/title`, `entry/{title,link@href,id,content,summary}`). Body = `content:encoded` / `content`, falling back to `description` / `summary`.
- Entries are taken in document order, newest first (true for Steam, Atom and almost every feed).

## Polling

- `pollFeeds(ctx)` runs from `Service.Poll`, but only every 10 minutes (the service ticks every 30 s; feeds keep their own last-run time).
- Load all `rss` rows, fetch each distinct URL once per round. A failed fetch is skipped until the next round.
- Per alert:
  - New entries = those before `last_item` in the feed. If `last_item` is not in the feed at all, only the newest entry counts as new (avoids a flood after a feed rewrites its IDs).
  - Cap at 5 new entries per round.
  - Drop entries whose title does not contain `title_filter` (case-insensitive).
  - Update `last_item` to the newest entry ID first, then post the remaining entries oldest first. Updating first matches YouTube and means a crash never re-posts.

## Message format

Posted with `poster.PostAs(channelID, display_name, content)`:

```
📰 **<title>**
<body as Markdown, at most 1500 characters, cut at a line or word boundary, then "…">
<link>
```

- Title: HTML entities unescaped, then `escapeMarkdown`.
- HTML → Markdown in `server/internal/integrations/feedhtml.go`, using `golang.org/x/net/html` (added to `go.mod` as a direct dependency if needed). Handles `p`, `br`, `h1`–`h6` (as bold lines), `ul`/`ol`/`li` (`- ` / `1. `), `b`/`strong`, `i`/`em`, `a` (`[text](href)`, http/https only, else plain text), `code`, `pre`; `script`/`style`/`img`/`iframe` are dropped; other tags keep their text. Text nodes go through `escapeMarkdown`. Runs of blank lines collapse to one.
- Empty body: title and link only.
- The link gets a link preview as usual.

## Web client

`clients/web/src/app/dialogs/AlertsTab.tsx`:

- Platform select gains "RSS feed", placeholder `https://store.steampowered.com/feeds/news/app/730`.
- When `rss` is chosen, two more optional fields: **Name** and **Title contains**.
- List rows for `rss` show the lucide `Rss` icon and, when set, the filter (`Title contains "Update"`) in muted text.
- Regenerate the API types after the server change.

## Errors

- Invalid URL or non-feed on create: `BAD_ACCOUNT`, shown inline like other alert errors.
- Fetch or parse failure while polling: skipped, retried next round, logged at debug with `linkpreview.LogURL`.
- Malformed HTML in a body: the converter emits whatever text it could read.

## Testing

Go, in `integrations`:

- Parser: RSS 2.0 fixture (a trimmed copy of the CS2 Steam feed) and an Atom fixture: title, entries, IDs, body fallback.
- HTML → Markdown: lists, links (non-http dropped), headings, entities, escaping, script removal, truncation.
- Poll, against an `httptest` server and `pgtest`:
  - first round after create posts nothing;
  - one new entry → one message with the expected content and author name;
  - title filter skips "Rush Hour" but still advances `last_item`;
  - three new entries → posted oldest first; more than 5 → capped;
  - unknown `last_item` → only the newest is posted;
  - fetch error → nothing posted, `last_item` unchanged;
  - two channels following one URL → one fetch.
- Create handler: bad URL, non-feed URL, name defaulting.
- A private-address feed URL is refused (via the `linkpreview` client).

Web: Playwright test in the existing alerts spec: add an RSS feed with a name and filter, see it listed, delete it.

## Out of scope

- Steam News API and its `patchnotes` tag.
- Per-feed poll intervals, ETag/If-Modified-Since, regex filters, per-feed format toggles.
- A browsable updates page.
