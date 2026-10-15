# Thirteen features and fixes: design

Date: 2026-10-14. Mockups (to be made before building UI): `docs/superpowers/mockups/VoiceStats.html`, `TeamRandomizer.html`, `MemberBanner.html`. Each will have three very different concepts to choose from.

The work is split into three batches. Each item stands on its own and can ship separately.

- **Batch A, bugs and quick fixes:** 10 screenshare fit, 11 desktop links, 12 refresh auto-rejoin, 3 mobile copy, 13 slow System page.
- **Batch B, client UX:** 2 rich composer, 6 banner in members list, 7 members filtered by channel access, 8 auto time.
- **Batch C, new features:** 1 AFK channel, 4 voice stats and peer ping, 5 team randomizer, 9 upload TTL.

The next free migration number is `00043`.

---

## A1. Screenshare fits the 16:9 box (item 10)

**Problem.** In the stage view, the large tile is `size-full` (`Tile.tsx:19-23`, `StageView.tsx:37-45`). It is not held to 16:9, so a share can overflow the box when the stage cell is wider or taller than 16:9.

**Design.**
- The `large` tile becomes a 16:9 box that is limited by both the cell's width and its height: `aspect-video max-h-full max-w-full`, with `h-full w-auto` or `w-full h-auto` chosen by container query. It is centred in the stage cell (`grid place-items-center`).
- `TrackVideo` keeps `size-full object-contain`, so the video letterboxes inside the box.
- Strip and grid tiles are already `aspect-video`. Check that their parents never force the height past the width ratio.

**Verify.** Check in the browser with a tall, narrow window and with a wide, short window. A screenshare and a camera tile must never overflow the box.

## A2. Desktop links open in the default browser (item 11)

**Problem.** Server webviews depend on Tauri's `on_new_window`, which is an unstable API (`shell.rs:778`). The web client never calls an opener itself, so `target=_blank` clicks can do nothing.

**Design.**
- **Rust:** add a command `desktop_open_url(url)` that validates the URL and calls the existing `open_external` (http, https and mailto only). Add it to `SERVER_PERMISSIONS` so remote server webviews may call it.
- **Web** (`clients/web/src/desktop.ts`): when running in the desktop app, install one capture-phase `click` listener (and an `auxclick` listener for middle-click) on `document`.
  - It applies to an `<a href>` with an external origin, or with `target=_blank`.
  - It calls `preventDefault()` and then `invoke("desktop_open_url")`.
  - Same-origin links that are in-app routes are left alone.
- `on_new_window` and `on_navigation` stay as a fallback.

**Verify.** In the desktop dev build, clicking message links, embed links and profile links opens them in the system browser.

## A3. Refresh keeps you in the call (item 12)

**Problem.** livekit-client's `disconnectOnPageLeave` drops you on refresh, and nothing remembers the call. On `Disconnected`, `voice.ts:217` tears everything down without trying again.

**Design.**
- **Remember the call.**
  - On a successful join, write `{channelId, selfMute, selfDeaf}` to `sessionStorage["voice.resume"]`. This is per tab and survives a refresh, but not a new tab.
  - Clear it on an explicit leave, on a move to no channel, and on any terminal disconnect reason (kicked, banned, removed, permission lost, room deleted).
- **Resume on load.** After the gateway is READY, if `voice.resume` is set and the channel still exists and is joinable, call `Voice.join()` with the stored mute and deafen state.
- **Retry.**
  - On `RoomEvent.Disconnected` with a non-terminal reason (network, signal close, server shutdown), keep the view and enter a new status, `"retrying"`.
  - Back-off delays: 1, 2, 5, 10 and 15 s, then every 15 s, up to 2 minutes in total. After that, give up with the current error.
  - Each attempt is a full `join()`, with a fresh token.
  - `online` and `visibilitychange` (when the tab becomes visible) trigger an attempt right away.
- **UI.**
  - VoicePanel shows "Disconnected · reconnecting… (attempt n)" with a Cancel button. Cancel works like leave.
  - The existing `"reconnecting"` state (LiveKit's ICE restart) shows "Reconnecting…".
- **Server:** no change. `DepartureTimeout: 20` already covers the gap.

**Tests.** Vitest for the back-off schedule and the terminal/non-terminal split, using fake timers and a stubbed `join`.

## A4. Copy messages on the phone (item 3)

**Problem.** A long press on message text marks the text and also opens the menu.

**Design.**
- Message rows on coarse pointers get `select-none`, next to the existing `[-webkit-touch-callout:none]`. A long press then opens only the sheet.
- In `MessageSheet`, "Copy text" moves to the top of the action list, just after the reactions row. It copies the message's plain text, meaning the raw content with custom emoji kept as `:name:`.
- The copy uses `navigator.clipboard.writeText`, with a fallback of a hidden textarea plus `execCommand("copy")` for older WebViews. A toast says "Copied".
- Links and images keep their native long-press menu (`nativeMenu`).

## A5. System page loads slowly (item 13)

**Cause** (read from the code, not measured).
- `GET /api/admin/system/stats` waits on the updater's `/containers`.
- `/containers` calls Docker `stats?stream=false` for each running container (`updater/docker.go:102`). Docker blocks about 1–2 s to take two CPU samples.
- The page renders nothing until the whole response arrives.

**Design.**
- **Updater:** a background sampler refreshes container stats every 5 s, using Docker's streaming stats or the existing one-shot calls in parallel. `/containers` answers at once with the latest cache: the list is fresh, and the CPU and memory come from the last sample. At start-up, before the first sample, it returns the containers without numbers.
- **Server:** the stats handler is unchanged, apart from the shorter updater latency.
- **Client:** `System.tsx` shows host stats as soon as they arrive, and shows skeleton rows for containers until the numbers come in.

**Verify.** Measure the endpoint before and after with the dev updater, using `curl -w %{time_total}`. The target is under 200 ms.

---

## B1. Rich composer with inline emoji (item 2)

**Goal.** Emoji show as images or glyphs while you type, instead of as `:code:`.

**Design.** A new component, `RichInput` (`clients/web/src/chat/RichInput.tsx`). It is a small custom contenteditable with no editor library, because the only atoms are emoji.

- **Model.**
  - The DOM holds text nodes and emoji atoms: `<img data-emoji=":name:" contenteditable=false>` for custom emoji, and plain unicode characters for unicode emoji.
  - `serialize(root)` walks the DOM and returns the same string that is sent today: custom emoji become `:name:`, and `<br>` and line `div`s become `\n`.
  - `deserialize(text)` does the reverse, for drafts, edit mode and the edit-last-message shortcut.
  - The server does not change.
- **Auto-convert.** When a typed `:name:` is closed (by the second `:`, or by choosing it in autocomplete), the text is replaced with an atom or a unicode character.
- **Must keep:**
  - the mention, emoji and command autocomplete (`findTrigger` runs on the text before the caret, computed from the DOM selection);
  - inserting from the picker at the caret;
  - paste as plain text, then auto-convert;
  - Enter sends and Shift+Enter adds a new line;
  - Up arrow on an empty input edits the last message;
  - edit mode, drafts per channel, the max length counter, IME composition (no conversion while `isComposing`), the mobile keyboard, and undo (best effort, through the native contenteditable stack);
  - focus handling (`Composer.tsx:45` currently uses `querySelector("textarea")`).
- **Accessibility.** `role="textbox" aria-multiline="true"` with the same accessible name as the current textarea, so the Playwright selectors keep working. `aria-placeholder` and a CSS placeholder.
- **Other emoji fields:** status, custom status, about me and channel name use `RichInput` with `singleLine`, which blocks Enter and line breaks.

**Tests.**
- Vitest: round trips of `serialize`/`deserialize` (custom, unicode, unknown `:x:`, new lines, mentions), caret-to-text offset mapping, and auto-convert.
- Playwright: the existing chat e2e must pass.

**Risk:** highest of all the items. It ships behind nothing, but it lands as its own change.

## B2. Banner as a dimmed background in the members list (item 6)

**Design.**
- Every member who has a `banner_url` gets the banner behind their row, inside `MemberList.tsx`.
- The banner is `object-cover`, at low opacity, with a gradient to `bg-sidebar` from left to right so names stay readable. It is lazy loaded, using `sizedImage(url, 256)`.
- The exact treatment (opacity, gradient, hover state) is chosen from three mockups. The member list API already has `banner_url`; check that the member payload includes it, and add it if not.

## B3. Members list shows only people with access (item 7)

**Design.**
- `MemberList` takes the current channel and filters `s.server.members` to those with `ViewChannel` in `channelPerms(server, roles, userId, roleIds, channel)`. That function already exists in `clients/core/src/perms.ts`.
- It is memoised on members, roles and the channel's overrides.
- The server does not change, because members are already sent in full.
- **Tests:** Vitest for the filter with an @everyone deny plus a role allow, and with a member override.

## B4. Auto time (item 8)

**Design.**
- **Sender time zone.** The client sends `tz` (its IANA zone, from `Intl.DateTimeFormat().resolvedOptions().timeZone`) with every message.
  - Migration `00043_message_tz.sql` adds a nullable `messages.tz text`.
  - The server validates it with `time.LoadLocation` (invalid means null) and returns it on messages.
  - Edits keep the original `tz`.
- **Detection** (`clients/web/src/lib/time-mention.ts`): a remark step in `remarkChat` matches:
  - `9pm`, `9 pm`, `9:30pm`, `9.30 pm`, and `am`/`pm` in any case;
  - 24-hour `21:00` or `21.00`, only with two-digit minutes and hours 0–23;
  - an optional explicit zone after the time (`CET`, `CEST`, `EST`, `PST`, `UTC`, `GMT`, `UTC+2`, `GMT-5`), which overrides the sender's `tz`.
  - Not matched: bare numbers (`at 9`), anything inside code spans or URLs, and ratios like `2:1` (minutes must be two digits from 00 to 59).
- **Rendering.**
  - A time chip, `<span class="time-mention">`, shows the time on today's date (the message's date in the sender's zone), converted to the reader's zone and clock preference.
  - If the reader's zone gives the same time, the chip shows the time with no conversion marker.
  - A tooltip shows the original: "9:00 PM in Europe/Stockholm (sender)".
  - Messages with no `tz` (old ones, webhooks) are not converted, unless the time has an explicit zone.
- **Clock preference.**
  - A new user setting, "Clock: Auto / 12-hour / 24-hour", in Appearance. It is stored with the other prefs (`prefs.ts`, localStorage).
  - `message-time.ts`'s `twelve()` reads the preference first and falls back to the locale.
  - It applies to message timestamps and to time chips.
- **Tests:** Vitest for the parser (positive and negative cases) and for conversion across DST, using a fixed `Date`.

---

## C1. AFK voice channel (item 1)

**Settings.**
- Migration `00044_afk.sql` adds to `servers`:
  - `afk_channel_id bigint NULL REFERENCES channels ON DELETE SET NULL`;
  - `afk_timeout_seconds int NOT NULL DEFAULT 900 CHECK (afk_timeout_seconds IN (300, 900, 1800, 3600))`.
- They are returned on the server object and edited in a new "Voice" section of the server settings, gated by `ManageServer`. The section has a voice channel select (with "None") and a timeout select.
- The server validates that the channel is a voice channel in the same server.

**Idle detection (client).**
- `voice.ts` tracks `lastActive`, updated when the local participant `isSpeaking` turns true and on join.
- While deafened, the user counts as idle even if their mic picks up sound.
- A 30 s check runs: if the user is not in the AFK channel and `now - lastActive > timeout`, the client calls `POST /api/voice/afk`.

**Server.**
- `POST /api/voice/afk` checks that the caller is in a voice channel of a server with an AFK channel set. It then uses the existing `Move` to send them to the AFK channel, which pushes `VOICE_MOVE` to that client.
- The client may lie, but it can only move itself.

**In the AFK channel.**
- `JoinToken` sets `CanPublish: false` for the microphone source when the channel is the server's AFK channel. Camera and screen share are also off.
- The client shows a toast, "Moved to AFK after 15 min of silence", and disables the mic button with a tooltip.
- Users can leave and join another channel normally.

**Tests:** apptest cases:
- the setting must be a voice channel in the same server;
- the afk endpoint moves the caller and emits `VOICE_MOVE`;
- it rejects when no AFK channel is set;
- the join token has no publish permission in the AFK channel. Use `lktest` to check the token grants.

## C2. Voice stats graph and peer ping (item 4)

**Your connection.**
- `stats.ts` samples every 1 s while connected, into a ring buffer of 30 samples of `{t, rttMs, jitterMs, lossPct}`. This replaces the 2 s interval.
- The `ConnectionQuality` popover or tooltip becomes a small panel with:
  - three SVG sparklines (ping, jitter and packet loss), with the current value and the 30 s average for each;
  - a quality label.
- No chart library is used. The look is chosen from three mockups.

**Peers.**
- Every 5 s, each client publishes its current server RTT as a LiveKit participant attribute, `ping` (string ms), using `localParticipant.setAttributes`. LiveKit sends this only to people in the room.
- Show it in two places:
  - on the hover or long-press of a call tile;
  - in the member rows of the in-call VoiceMembers list.
- The format is "42 ms to server · ≈85 ms to you". The estimate is the round trip you ↔ server ↔ peer, which is the peer's RTT plus mine. It excludes SFU forwarding time, hence the "≈".
- The token must allow `canUpdateOwnMetadata`. Check `JoinToken`.

**Tests:** Vitest for the ring buffer and average, and for the peer estimate formatting.

## C3. Team randomizer (item 5)

**UI.**
- A "Teams" button in CallControls opens a dialog with:
  - the number of teams (2–8, default 2);
  - players per team (optional; blank means split evenly);
  - the pool: participants of the call as checkboxes, all checked, with select all and none.
- "Draw" sends the request. The look of the result panel is chosen from three mockups.

**Server.**
- `POST /api/voice/{channelId}/teams` with `{teams, per_team?, user_ids}`.
- The server checks that the caller is in that channel, that every `user_id` is currently in the channel, and that `teams * per_team <= len(user_ids)`.
- It shuffles with `crypto/rand` (Fisher–Yates) and deals players round-robin into teams up to `per_team` each. The rest go on the bench.
- It publishes `VOICE_TEAMS {channel_id, by, teams: [[user_id]], bench: [user_id], at}` to the call's listeners, using the soundboard pattern (`soundboard.go:35-76`).
- Nothing is stored.

**Client.**
- When `VOICE_TEAMS` arrives, the call shows a dismissible teams panel with "Team 1…n" and the bench, avatars and names, and "drawn by X".
- The panel has Re-roll, which sends the same settings again, and Dismiss, which only hides it locally.
- Add the event type to `clients/core/src/types.ts`.

**Tests:** apptest cases:
- the result is split correctly (sizes, no duplicates, the bench gets the rest);
- a user who is not in the call is rejected;
- the event reaches only call listeners.

## C4. Upload TTL (item 9)

**Rules.**
- Migration `00045_upload_ttl.sql`:
  - `instance_settings.upload_ttl_rules jsonb NOT NULL DEFAULT '[]'`, an array of `{min_bytes, ttl_hours}` with at most 5 tiers. `min_bytes` is at least 1 MB, `ttl_hours` is from 1 to 8760, and `min_bytes` values are unique.
  - `attachments.expires_at timestamptz NULL`, `attachments.keep bool NOT NULL DEFAULT false` and `attachments.expired_at timestamptz NULL`.
  - An index on `(expires_at) WHERE expired_at IS NULL AND NOT keep AND expires_at IS NOT NULL`.
- Rules are edited in the admin Uploads section (`server-settings/Uploads.tsx`) as a small table: "Files over [500] MB are deleted after [7] days", plus add and remove. Empty means the feature is off.

**Expiry date.**
- In `Claim` (when a message is sent), set `expires_at = now + ttl` of the tier with the largest `min_bytes <= size`.
- Only new uploads are affected; existing files stay permanent.

**Sweep.**
- `files.Sweep` (hourly) selects rows with `expires_at < now` that are not kept and not expired.
- It sets `expired_at = now` and removes the blob and thumbnail if nothing else references them (reuses `removeIfUnused`, so deduplicated blobs survive).
- It emits `MESSAGE_UPDATE` for each affected message.

**API and rendering.**
- Attachments return `expires_at`, `keep` and `expired`.
- Expired attachments render a "File expired" placeholder (filename and size, no download), and the GET endpoints return 410 `FILE_EXPIRED`.
- Gallery and album lists exclude expired files.
- Attachments with an expiry show a badge: "Expires in 3 days".

**Actions** (uploader, or `ManageMessages` in the channel, with the same rank rule as message delete):
- `PATCH /api/attachments/{id}` with `{keep: true|false}`, labelled "Keep forever" or "Allow expiry". Turning `keep` off recomputes `expires_at` from the current rules.
- `DELETE /api/attachments/{id}`, labelled "Remove file". It removes the file now, using the same path as expiry, and keeps the message.
- Both are offered in the message context menu, the mobile sheet, and the gallery FileMenu. Both emit `MESSAGE_UPDATE`.

**Tests:** apptest cases:
- tier choice at claim;
- sweep expires the file and keeps a deduplicated blob that is still referenced elsewhere;
- `keep` prevents expiry;
- removal permissions (uploader, a moderator who outranks, and a stranger who is rejected);
- the 410 after expiry;
- the gallery hides expired files.

---

## Out of scope

- Server-side idle detection for AFK.
- True peer-to-peer latency.
- Changing the TTL of existing uploads when the rules change.
- Saving team draws.
- A per-community TTL.
- Rich-text formatting in the composer (bold and so on stay as markdown text).
