# New channel types: announcement, forum, gallery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three channel types next to text and voice:
- **Announcement:** only members with *Manage messages* post (with an optional title). Everyone else reads, reacts and replies in threads. Posts show as cards.
- **Forum:** each post is a thread with a title, tags and its own replies. The channel shows a filterable post list, and the open post appears in the side panel.
- **Gallery:** only photos and videos are posted (with an optional caption). The channel shows a grid, and the selected item appears in the side panel with its comments (a thread).

**Architecture:**
- **Server:**
  - `channels.type` gains `announcement`, `forum` and `gallery`.
  - `channels` gains `tags TEXT[]` (on a forum: the tags it offers; on a forum post: the tags applied) and `require_tag`.
  - `messages` gains `title` (announcements only).
  - A forum post is an ordinary `thread` channel whose parent is the forum and whose `parent_message_id` is NULL. Its first message is the post body.
  - Threads already take their parent's permissions, visibility, search and inbox handling, so posts and gallery comments get all of that for free.
  - New routes: `POST /api/channels/{id}/posts`, `PATCH /api/channels/{id}/post` and `DELETE /api/channels/{id}/post`.
  - New events: `POST_UPDATE` and `POST_DELETE`, scoped to the forum.
- **Clients:**
  - `@datrope/core` gains the types, the post API, the post events, `posts` state and a `canPost` helper.
  - The web app gains the five-type create dialog, forum tag settings, sidebar icons, and one view per type: `AnnouncementView`, `ForumView` with `PostPanel`, and `GalleryView` with `GalleryItemPanel`.

**Tech Stack:** Go (Huma, pgx, goose) · Postgres · `@datrope/core` (openapi-fetch, zustand) · React 18 + shadcn/ui · Tailwind v4 · Vitest · Playwright. No new dependencies.

**Spec:** this plan is the spec; decisions confirmed by the user on 2026-10-10:
- Posting in announcements = *Manage messages*.
- Forum "done" is just a tag; the author or a moderator can change a post's title and tags.
- Gallery uploads go through an Upload button and a dialog.
- Not in scope: "Notify everyone", "Seen by N of M" and "Follow post".
- Announcement titles stay.

**Mockups (binding):** `docs/superpowers/mockups/`:
- `ChannelAnnouncement.dc.html`;
- `ChannelForum.dc.html`;
- `ChannelGallery.dc.html`;
- `CreateChannel.dc.html`.

Where the mockups differ from the decisions above, the decisions win:
- The create dialog has no "Who can post" select and no gallery "Allow" checkboxes; it shows hints instead.
- No "Seen by", no "notified everyone" and no Follow bell.

## Global Constraints

- **Never commit.** (AGENTS.md §5.) The controller stages each reviewed task with `git add`; nobody commits, amends, tags or pushes.
- **Writing files:** the Write/Edit tools may be blocked on project files on this machine. If they are, write via a Bash heredoc or a short python script.
- **Running tests:**
  - Go tests: from **PowerShell**, with `$env:GOTOOLCHAIN='local'; go test ./...` in `server/`. They need Docker (testcontainers).
  - JS tests: `pnpm -r test`, `pnpm -r typecheck` and `pnpm lint` from the repo root.
- **Regenerating the API types:** after any server API change, run `pnpm --filter @datrope/core gen`. It rewrites `clients/core/openapi.json` and `src/schema.d.ts`; never hand-edit them.
- **UI:**
  - shadcn/ui components and token utilities only; no hard-coded colours; dark only.
  - Lucide icons: `Megaphone` (announcement), `MessagesSquare` (forum), `Images` (gallery), `Hash` (text), `Volume2` (voice).
  - Keep accessible names stable; e2e selects by role and label.
- **Copy:**
  - Sentence case.
  - Buttons are verbs: "Create", "Post", "New post", "Upload", "Save".
  - Errors say what happened and how to fix it.
- **Limits:**
  - Post title: 1–100 runes, trimmed.
  - Announcement title: 0–100 runes, trimmed.
  - Forum tags: 1–24 runes each, trimmed, unique ignoring case, at most 20 per forum; a post carries at most 5 of its forum's tags.
  - Post body: ≤ 4000 characters, the same as messages.
  - Attachments: ≤ 10 per post or gallery item.
- **Error codes (new):**
  - `NOT_ALLOWED_HERE` (400): sending a plain message to a forum; a title outside announcements; a thread in a forum.
  - `MEDIA_ONLY` (400): a gallery message without attachments, or with any attachment that is not `image/*` or `video/*`.
  - `TAG_REQUIRED` (400) and `UNKNOWN_TAG` (400).
- **Permissions:**
  - Announcement top-level send: `SEND_MESSAGES` **and** `MANAGE_MESSAGES`. Otherwise 403 `MISSING_PERMISSION`. Replies inside an announcement thread need only `SEND_MESSAGES`, as before.
  - Create post: `SEND_MESSAGES | CREATE_THREADS`, plus `ATTACH_FILES` if it has attachments.
  - Edit or delete post: the post's creator or `MANAGE_MESSAGES`.
  - Forum tags and `require_tag`: `MANAGE_CHANNELS`, through the existing `update-channel`.

## Review Focus

1. **A thread in an announcement channel:** a member without *Manage messages* must still be able to reply. The check looks at the channel the message is sent to (type `thread`), not at the parent. Test in Task 2.
2. **A gallery item with a non-media file:** must be rejected after the upload is claimed, and the transaction rolled back, so the upload is not attached to anything. Test in Task 2.
3. **Removing a tag from a forum** removes it from every post in that forum in the same transaction. Test in Task 1.
4. **A forum post whose author left or was deleted:** the list still loads (`author` absent, `created_by` NULL). Test in Task 2.
5. **Changing a channel's type is not possible** (no API). The voice join check must also reject the new types; it lists types rather than checking for `voice`. Test in Task 1.

---

### Task 1: Server — new types, tags and the voice check

**Files:**
- Create: `server/internal/db/migrations/00026_channel_types.sql`
- Modify: `server/internal/channels/channels.go` (constants, `Channel`, `channelCols`, `scanChannel`)
- Modify: `server/internal/channels/handlers.go` (create and update requests and handlers)
- Create: `server/internal/channels/tags.go` (`normalizeTags`)
- Modify: `server/internal/voice/voice.go:228`
- Test: `server/internal/channels/channels_test.go`, `server/internal/channels/tags_test.go`, the voice tests

**Interfaces:**
- Produces:
  - `channels.TypeAnnouncement = "announcement"`, `TypeForum = "forum"`, `TypeGallery = "gallery"`.
  - `Channel.Tags []string \`json:"tags"\`` (never nil; `[]`).
  - `Channel.RequireTag bool \`json:"require_tag"\``.
  - `Channel.CreatedBy *id.ID \`json:"created_by,omitempty" doc:"Threads and forum posts: who started it"\``.
  - The `Type` enum becomes `text,voice,welcome,dm,thread,announcement,forum,gallery`.
  - `func normalizeTags(in []string, max int) ([]string, error)`: trims each tag, rejects empty or > 24 runes and duplicates ignoring case (400 `VALIDATION_FAILED`), and rejects more than `max` tags.

- [ ] **Step 1: The migration**

```sql
-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check
    CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread', 'announcement', 'forum', 'gallery'));
ALTER TABLE channels
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN require_tag BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN title TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE messages DROP COLUMN title;
ALTER TABLE channels DROP COLUMN require_tag, DROP COLUMN tags;
DELETE FROM channels WHERE type IN ('announcement', 'forum', 'gallery');
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread'));
```

- [ ] **Step 2: Failing tests** in `channels_test.go`, following the existing helpers there:
  - Creating each of `announcement`, `forum` and `gallery` returns 201 with that type, and `tags: []` for non-forums.
  - Creating a forum with `{"tags":["Feature"," Bug ","feature"]}` gives 400 (duplicate ignoring case).
  - `{"tags":["Feature","Bug"],"require_tag":true}` stores both.
  - `tags` or `require_tag` on a non-forum gives 400 `VALIDATION_FAILED`.
  - `PATCH /api/channels/{forum}` with `{"tags":["Bug"]}` removes "Feature" from the forum, **and** a post thread in that forum that had `{"Feature","Bug"}` now has `{"Bug"}`. Insert that thread row directly with SQL in the test: `type='thread'`, `parent_channel_id=forum`, `tags='{Feature,Bug}'`.
- [ ] **Step 3: Failing tests** for `normalizeTags` (table test: trimming, the empty tag, 25 runes, a duplicate in different case, 21 tags with max 20) and for voice:
  - Joining voice in an `announcement`, `forum` or `gallery` channel gives 400 `NOT_VOICE_CHANNEL`.
- [ ] **Step 4: Implement:**
  - Add the constants.
  - Extend `channelCols` with `tags, require_tag, created_by` and scan them; `ListDMs` hard-codes its column list, so update it too.
  - `CreateChannelRequest` gains `Tags []string \`json:"tags,omitempty" maxItems:"20"\`` and `RequireTag bool \`json:"require_tag,omitempty"\``, and its enum becomes `text,voice,announcement,forum,gallery`.
  - `UpdateChannelRequest` gains `Tags *[]string` and `RequireTag *bool`. Both are forum-only; otherwise 400.
  - On update, in one transaction:
    ```sql
    UPDATE channels SET tags = $2 WHERE id = $1
    UPDATE channels SET tags = ARRAY(SELECT t FROM unnest(tags) t WHERE t = ANY($2)) WHERE parent_channel_id = $1 AND type = 'thread'
    ```
  - Voice: replace the check with `if c.Type != channels.TypeVoice && c.Type != channels.TypeDM`.
- [ ] **Step 5:** Run `go test ./internal/channels/... ./internal/voice/...` from PowerShell. Expected: PASS.
- [ ] **Step 6: Checkpoint.** Report changed files; the controller reviews and stages.

### Task 2: Server — announcement and gallery rules, forum posts

**Files:**
- Modify: `server/internal/messages/messages.go` (`Message.Title`, `messageCols`, `scanMessage`)
- Modify: `server/internal/messages/handlers.go` (send and edit)
- Modify: `server/internal/messages/threads.go` (create-thread types, `ThreadListItem`, post events)
- Create: `server/internal/messages/posts.go` (create, edit and delete post routes)
- Modify: `server/internal/channels/threads.go` (`CreatePost`, `UpdatePost`, `DeletePost`)
- Test: `server/internal/messages/posts_test.go`, `server/internal/messages/messages_test.go`, `server/internal/messages/threads_test.go`

**Interfaces:**
- Consumes (Task 1): `channels.TypeAnnouncement`, `TypeForum`, `TypeGallery`; `Channel.Tags`, `Channel.RequireTag`, `Channel.CreatedBy`.
- Produces:
  - `Message.Title string \`json:"title,omitempty"\``.
  - `SendRequest.Title string \`json:"title,omitempty" maxLength:"100"\``.
  - `EditRequest.Title *string \`json:"title,omitempty" maxLength:"100"\``.
  - `ThreadListItem` gains:
    - `Author *auth.PublicUser \`json:"author,omitempty"\``;
    - `Excerpt string \`json:"excerpt,omitempty" doc:"Forum posts: the start of the first message"\``;
    - `FirstMessageID *id.ID \`json:"first_message_id,omitempty"\``.
  - `channels.Service.CreatePost(ctx context.Context, tx pgx.Tx, forum *Channel, creatorID id.ID, title string, tags []string) (*Channel, error)`:
    - validates tags against `forum.Tags`, max 5, and `RequireTag`, returning 400 `UNKNOWN_TAG` or `TAG_REQUIRED`;
    - inserts `type='thread', parent_channel_id=forum.ID, parent_message_id NULL, created_by=creatorID, name=title, tags=…`.
  - `channels.Service.UpdatePost(ctx, post *Channel, title *string, tags *[]string) (*Channel, error)`.
  - `channels.Service.DeletePost(ctx, post *Channel) error` deletes the thread channel. Its messages are removed by cascade; attachment blobs stay until the existing cleanup removes them.
  - The `messages.Threads` interface gains these three methods.
  - Routes:
    - `POST /api/channels/{id}/posts` takes `CreatePostRequest{Title string (1–100), Content string (≤4000), Tags []string (maxItems 5), AttachmentIDs []id.ID (maxItems 10)}` and returns 201 `ThreadListItem`.
    - `PATCH /api/channels/{id}/post` takes `UpdatePostRequest{Title *string, Tags *[]string}` and returns `ThreadListItem`. `{id}` is the post's thread ID.
    - `DELETE /api/channels/{id}/post` returns 204.
  - Events, both scoped to the forum's `ChannelID`:
    - `POST_UPDATE` with `PostUpdate{ChannelID id.ID (forum), Post ThreadListItem}`;
    - `POST_DELETE` with `PostDeleted{ChannelID id.ID (forum), ID id.ID (post)}`.

- [ ] **Step 1: Failing tests (announcement)** in `messages_test.go`:
  - A member without `MANAGE_MESSAGES` gets 403 sending to an announcement.
  - The owner gets 201, and `title` round-trips through send and list (trimmed).
  - `title` on a text channel gives 400 `NOT_ALLOWED_HERE`.
  - The member **can** create a thread on the owner's announcement and reply in it (201).
  - Editing a title works for the author.
- [ ] **Step 2: Failing tests (gallery):**
  - Text only gives 400 `MEDIA_ONLY`.
  - A PNG upload plus caption gives 201.
  - A `text/plain` upload gives 400 `MEDIA_ONLY`, and afterwards that upload is still unclaimed: sending it to a text channel then succeeds.
  - Creating a thread on a gallery item and replying works.
  - Use the existing upload test helpers in `messages_test.go` / `embed_test.go`.
- [ ] **Step 3: Failing tests (forum)** in `posts_test.go`:
  - `send-message` to a forum gives 400 `NOT_ALLOWED_HERE`.
  - `create-thread` on a forum gives 400 `NO_THREADS_HERE`.
  - Create post: 201. The thread lists under `GET /api/channels/{forum}/threads` with `author`, `excerpt` (first 200 runes of the body), `tags` on `channel` and `first_message_id`. The post's messages list holds the body.
  - An unknown tag gives `UNKNOWN_TAG`; no tag with `require_tag` gives `TAG_REQUIRED`.
  - A member without `CREATE_THREADS` (deny override) gets 403.
  - Update by the author works; by another member it gives 403; by a moderator with `MANAGE_MESSAGES` it works.
  - Delete removes the post from the list.
  - The list still works after the author's user row is gone; `author` is absent.
  - Subscribe to the bus as the existing thread tests do, and assert one `POST_UPDATE` on create, one on a reply in the post (the summary's `message_count` is 2), and one `POST_DELETE`.
- [ ] **Step 4: Implement:**
  - `send-message`:
    - after `access`, if `ch.Type == TypeForum` return `NOT_ALLOWED_HERE`;
    - if `in.Body.Title != ""` and the type is not announcement, return `NOT_ALLOWED_HERE`;
    - if announcement and `!have.Has(perms.ManageMessages)`, return `httpx.MissingPermission()`. Change `ch, _, err := access(...)` to keep the perms;
    - for a gallery, an empty attachment list gives `MEDIA_ONLY` before inserting; after `Claim`, any attachment whose `ContentType` lacks an `image/` or `video/` prefix returns `MEDIA_ONLY`, and the deferred rollback undoes the claim;
    - insert `title`.
  - `edit-message`: the same title rule. `UPDATE … SET title = COALESCE($5, title)`.
  - `create-thread`: allow text, voice, announcement and gallery.
  - `publishThread`: when `thread.ParentMessageID == nil` and the parent is a forum, publish `POST_UPDATE` with the full list item (build it with a shared `postItem(ctx, thread)` helper that `list-threads` also uses).
  - `list-threads`: fill `Author`, `Excerpt` and `FirstMessageID` for threads with no parent message. Use one query: `SELECT DISTINCT ON (channel_id) channel_id, id, content FROM messages WHERE channel_id = ANY($1) AND NOT deleted ORDER BY channel_id, id`; the author comes from `Channel.CreatedBy` via `users.PublicUsers`.
  - `posts.go`: in one transaction, `CreatePost` then insert the first message, then `Claim` attachments. Commit, then publish `MESSAGE_CREATE` for the body (scoped to the post) and `POST_UPDATE`.
- [ ] **Step 5:** Run `go test ./internal/...` from PowerShell. Expected: all PASS.
- [ ] **Step 6:** Run `pnpm --filter @datrope/core gen` and check that the diff in `schema.d.ts` contains the new routes and fields.
- [ ] **Step 7: Checkpoint.**

### Task 3: Core client — types, API, events and state

**Files:**
- Modify: `clients/core/src/types.ts`, `client.ts`, `store.ts`, `index.ts`, `perms.ts`
- Test: `clients/core/src/store.test.ts`, `client.test.ts`, `perms.test.ts`

**Interfaces:**
- Consumes (Task 2): the regenerated schema; the `POST_UPDATE` and `POST_DELETE` payloads.
- Produces:
  - `type ChannelType = Channel["type"]`.
  - `PostUpdate` and `PostDeleted` types.
  - Store state: `posts: Record<string /* forumId */, ThreadListItem[] | undefined>`.
  - Store events:
    - `POST_UPDATE` replaces the item with the same `channel.id` or adds it;
    - `POST_DELETE` removes the item and also removes the post's channel and messages if loaded;
    - `CHANNEL_DELETE` of a forum drops `posts[forumId]`.
  - Client methods:
    - `client.loadPosts(forumId): Promise<void>` fills `posts[forumId]` from `listThreads`;
    - `client.createPost(forumId, {title, content, tags, attachments: Attachment[]}): Promise<ThreadListItem>`;
    - `client.updatePost(postId, {title?, tags?}): Promise<ThreadListItem>`;
    - `client.deletePost(postId): Promise<void>`.
  - `client.send(channelId, content, attachments, replyTo, title?)`: optional trailing `title`.
  - `client.createChannel(...)`: if there is no such method yet, do not add one; the web dialog calls `client.api.POST` directly as it does today.
  - `canPost(ch: Channel, perms: number): boolean` in `perms.ts`:
    - `false` for a forum;
    - for an announcement, `hasPerm(perms, Perm.SendMessages) && hasPerm(perms, Perm.ManageMessages)`;
    - otherwise `hasPerm(perms, Perm.SendMessages)`.
    - Export it from `index.ts`.

- [ ] **Step 1: Failing store tests:**
  - `POST_UPDATE` adds, then replaces in place.
  - `POST_DELETE` removes the post and its channel.
  - `CHANNEL_DELETE` of the forum drops its posts.
- [ ] **Step 2: Failing tests:**
  - `canPost` for each type, in `perms.test.ts`.
  - `createPost` posts the right body, in `client.test.ts`, following the existing msw pattern.
- [ ] **Step 3: Implement.** Run `pnpm --filter @datrope/core test` and `pnpm --filter @datrope/core typecheck`. Expected: PASS.
- [ ] **Step 4: Checkpoint.**

### Task 4: Web — create dialog, settings, sidebar and routing

**Files:**
- Modify: `clients/web/src/app/dialogs/CreateChannelDialog.tsx`
- Create: `clients/web/src/app/channel-types.ts`: `CHANNEL_TYPES` (value, label, description, icon) and `channelIcon(type)`
- Modify: `clients/web/src/app/sidebar/ChannelTree.tsx` (icons from `channelIcon`; unread for `announcement` and `gallery` like `text`)
- Modify: `clients/web/src/app/dialogs/ChannelSettingsDialog.tsx` (forums: a tags editor and a "Require a tag on new posts" checkbox)
- Create: `clients/web/src/app/TagsEditor.tsx`
- Modify: `clients/web/src/app/Home.tsx` (route `announcement`, `forum` and `gallery` to their views; Tasks 5–7 create them, so stub each as `ChannelView` for now)
- Modify: `clients/web/src/app/ChannelView.tsx` (`threads` true for announcement and gallery too; composer `canSend` uses `canPost`)
- Test: `clients/web/src/app/channel-types.test.ts`

**Interfaces:**
- Consumes (Task 3): `canPost`.
- Produces:
  - `CHANNEL_TYPES: { value: "text" | "voice" | "announcement" | "forum" | "gallery"; label: string; description: string; icon: LucideIcon }[]`, in the order Text, Voice, Announcement, Forum, Gallery. Labels and descriptions are exactly as in `CreateChannel.dc.html`:
    - Text: "Chat, share links and files."
    - Voice: "Talk, share your screen and camera."
    - Announcement: "Only moderators post. Everyone can react and reply."
    - Forum: "Posts with a title and tags, each with its own replies."
    - Gallery: "A grid of photos and videos with comments."
  - `TagsEditor({ value: string[]; onChange(v: string[]): void; max?: number })`: tag chips each with a "Remove {tag}" button, and an input labelled "Add a tag" that adds on Enter. It ignores empty input and duplicates ignoring case, and caps at 24 characters per tag and `max` tags (default 20).

- [ ] **Step 1: Failing test:** `CHANNEL_TYPES` has the five values in order, and `channelIcon` returns `Hash` for an unknown type.
- [ ] **Step 2: Dialog.** Follow `CreateChannel.dc.html`:
  - a `RadioGroup` of five card rows (`RadioGroupItem` plus a `Label` holding the icon, label and description);
  - the selected row gets `border-primary`;
  - "Name" with the per-type placeholder (`general`, `Lounge`, `announcements`, `ideas`, `photos`);
  - "Category";
  - then, per type:
    - announcement: the hint "Members with Manage messages can post. Everyone else can react and reply in threads.";
    - forum: "Tags" (`TagsEditor`, starting with Feature, Bug and Question) and the checkbox "Require a tag on new posts";
    - gallery: the hint "Only photos and videos can be posted here.".
  - Send `tags` and `require_tag` only for forums.
- [ ] **Step 3: Settings, sidebar and routing.** ChannelSettingsDialog for a forum saves `tags` and `require_tag` with the existing save button.
- [ ] **Step 4:** Run `pnpm -r typecheck`, `pnpm -r test` and `pnpm lint`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Web — announcement view

**Files:**
- Create: `clients/web/src/app/announcement/AnnouncementView.tsx`
- Modify: `clients/web/src/app/MessageList.tsx` (a `variant?: "chat" | "cards"` prop; `cards` puts every message in its own `Card` with the full header, never grouped, and shows `title` as an `h3` above the content)
- Modify: `clients/web/src/app/Composer.tsx` (a `withTitle?: boolean` prop adds an `Input` labelled "Title" above the textarea, sent as `title`; the send button says "Post" when `withTitle` is set)
- Modify: `clients/web/src/app/Home.tsx` (route to `AnnouncementView`)

**Interfaces:**
- Consumes: `canPost` (Task 3); `client.send(..., title)` (Task 3).
- Produces: `AnnouncementView({ channelId })`.

- [ ] **Step 1:** `AnnouncementView` reuses `ChannelView`'s header, side panel and thread handling. Extract nothing new unless needed; the simplest route is a `kind` prop on `ChannelView` that switches the list variant and the composer. The page:
  - the header icon is `Megaphone`;
  - the list uses `variant="cards"` inside a centred `max-w-3xl` column;
  - "Reply in thread" on each card opens or creates the thread (the existing `onOpenThread` and `canCreateThread`);
  - posters (`canPost`) get the composer with `withTitle` and the placeholder "Write an announcement";
  - everyone else gets a `role="note"` line with a `Lock` icon: "Only members with Manage messages can post here. React to a post or reply in its thread."
- [ ] **Step 2:** A Vitest/RTL test, if `MessageList` already has component tests; otherwise cover it in the Task 8 e2e.
- [ ] **Step 3:** Typecheck, test and lint: PASS. Check it in the browser with the preview (`.claude/launch.json`: datrope-server and datrope-web): create an announcement as the owner, post with a title, and see the card.
- [ ] **Step 4: Checkpoint.**

### Task 6: Web — forum view, post panel and new post dialog

**Files:**
- Create: `clients/web/src/app/forum/ForumView.tsx` (header, toolbar, post list)
- Create: `clients/web/src/app/forum/PostRow.tsx`
- Create: `clients/web/src/app/forum/PostPanel.tsx` (side panel: title, tags, Edit, Delete, first message, replies, composer)
- Create: `clients/web/src/app/forum/PostDialog.tsx` (new post and edit post: Title, Tags as toggle chips from the forum's tags, Message, attachments, and "Post" / "Save")
- Create: `clients/web/src/app/forum/filter.ts`, which exports `filterPosts(items, { query, tag, sort })`
- Modify: `clients/web/src/app/side-panel/panel.ts` (a `{ kind: "post"; postId: string }` panel)
- Modify: `clients/web/src/app/Home.tsx`
- Test: `clients/web/src/app/forum/filter.test.ts`

**Interfaces:**
- Consumes: `posts`, `loadPosts`, `createPost`, `updatePost`, `deletePost` (Task 3); `TagsEditor` is not used here (the post picks from the forum's tags); `timeAgo`, `repliesText` and `byActivity` from `threads.ts`.
- Produces:
  - `filterPosts(items: ThreadListItem[], f: { query: string; tag: string | null; sort: "activity" | "newest" | "replies" }): ThreadListItem[]`;
  - `query` matches the title or excerpt ignoring case;
  - "Done" has no special meaning; it is just a tag.

- [ ] **Step 1: Failing `filter.test.ts`:** query on the title and on the excerpt; tag filter; the three sorts (activity uses `byActivity`; newest by ID; replies by `summary.message_count` descending).
- [ ] **Step 2: Implement `ForumView`** per `ChannelForum.dc.html`:
  - header: `MessagesSquare`, the name, the topic, and a "New post" button (if `canPost` would allow posting: `SendMessages` and `CreateThreads`);
  - toolbar: the "Search posts" input, tag chips (`role="group" aria-label="Filter by tag"`, "All" plus the forum's tags, `aria-pressed`) and a "Sort" `NativeSelect` ("Latest activity", "Newest", "Most replies");
  - list: `role="list" aria-label="Posts"`; each row is a button with the title, excerpt, tags as `Badge variant="outline"`, "by {name}", up to 3 participant avatars, the reply count (`message_count - 1`, or "No replies") and `timeAgo`;
  - the selected row gets `bg-accent`;
  - empty states: "No posts yet. Start one with New post." and "No posts match."
  - Load with `client.loadPosts` on mount.
- [ ] **Step 3: `PostPanel`:**
  - It uses `SidePanel` with the title "Post", tag badges, and Edit and Delete buttons for the creator or `MANAGE_MESSAGES` (Delete asks for confirmation in a `Dialog`: "Delete this post?" / "Delete").
  - It shows the post's messages through `MessageList` (`useChannelFeed(postId)`) and a `Composer` with the placeholder "Reply to post".
  - Opening a post sets the panel `{kind:"post", postId}`; switching channels closes it, as threads do.
- [ ] **Step 4: `PostDialog`:**
  - Title (`FormField`, required, maxLength 100).
  - Tags as toggle `Badge`-style buttons (`aria-pressed`), max 5, with the hint "Pick at least one tag." when `require_tag`.
  - Message (`Textarea`) and attach files (reuse the Composer upload pattern: `client.upload(forumId, file, name)`; uploads go to the forum ID).
  - `ErrorText`; "Post" or "Save".
- [ ] **Step 5:** Typecheck, test and lint: PASS. In the browser preview: create a forum with tags, post, reply, change tags, filter, delete.
- [ ] **Step 6: Checkpoint.**

### Task 7: Web — gallery view, upload dialog and item panel

**Files:**
- Create: `clients/web/src/app/gallery/GalleryView.tsx`
- Create: `clients/web/src/app/gallery/UploadDialog.tsx`
- Create: `clients/web/src/app/gallery/GalleryItemPanel.tsx`
- Create: `clients/web/src/app/gallery/items.ts`, which exports `galleryItems(messages, { kind, uploader })` and `isMedia(contentType)`
- Modify: `clients/web/src/app/side-panel/panel.ts` (a `{ kind: "media"; messageId: string; attachmentId: string }` panel)
- Modify: `clients/web/src/app/Home.tsx`
- Test: `clients/web/src/app/gallery/items.test.ts`

**Interfaces:**
- Consumes: `useChannelFeed` and `client.loadOlder` for paging; `client.send` with attachments; `createThread`; `ThreadPanel`'s `ThreadBody` pattern for comments; `attachments/ImageViewer.tsx` and `VideoPlayer.tsx` for previews.
- Produces:
  - `type GalleryItem = { message: Message; attachment: Attachment; kind: "photo" | "video" }`;
  - `galleryItems(messages: Message[], f: { kind: "all" | "photo" | "video"; uploader: string | null }): GalleryItem[]`: newest first, one item per media attachment, skipping deleted messages;
  - `sections(items: GalleryItem[], now: Date): { label: string; items: GalleryItem[] }[]`, with the labels "This week", then month names ("September", or "September 2025" when it is not this year).

- [ ] **Step 1: Failing `items.test.ts`:** a two-attachment message gives two items; the photo and video filters; the uploader filter; deleted messages are skipped; section labels around a week boundary and a year boundary.
- [ ] **Step 2: Implement `GalleryView`** per `ChannelGallery.dc.html`:
  - header: `Images`, the name, the topic, and an "Upload" button (if `canPost` and `ATTACH_FILES`);
  - toolbar: chips "All", "Photos", "Videos" (`role="group" aria-label="Show"`), an "Uploaded by" select and "{n} items";
  - grid: `grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2`, square tiles (`ThumbnailURL ?? URL`, `object-cover`). Each tile is a `button` with `aria-label="Photo: {caption or filename}, by {name}"` and the uploader's avatar; a video gets a play badge;
  - "Load more" calls `client.loadOlder` when there are older pages;
  - empty state: "No photos or videos yet."
- [ ] **Step 3: `UploadDialog`:**
  - "Choose files" (`accept="image/*,video/*"`, multiple, ≤ 10), with a thumbnail and progress or error per file, and the client refusing anything else with "Only photos and videos can be posted here."
  - "Caption" (`Textarea`, optional), then "Upload", which calls `client.send(channelId, caption, attachments)`.
- [ ] **Step 4: `GalleryItemPanel`:**
  - `SidePanel` titled with the caption's first line or the filename;
  - "Open full size", which opens the existing `ImageViewer` or plays the video;
  - "Download" (`<a download href={url}>`);
  - a large preview, "Previous item" and "Next item" buttons, and "{i} of {n}";
  - the uploader and time, the caption (`Markdown`), the file name and size, and the size in pixels when known;
  - "Comments": the thread's messages, created on first comment. The composer, labelled "Comment", calls `client.createThread(channelId, messageId)` first if `message.thread` is absent, then sends to the thread.
- [ ] **Step 5:** Typecheck, test and lint: PASS. In the browser preview: upload two photos and a video, filter, open, go to the next item, comment.
- [ ] **Step 6: Checkpoint.**

### Task 8: End-to-end test and final verification

**Files:**
- Modify: `clients/web/e2e/chat.spec.ts` (a new `test(...)` block, using the fixtures already there)

- [ ] **Step 1: The e2e test.** The owner and a friend:
  - The owner creates an announcement "news", posts the title "Game night" with a body, and sees the card.
  - The friend sees the note "Only members with Manage messages can post here." and replies in the thread.
  - The owner creates a forum "ideas" with the tags Feature and Bug and "Require a tag on new posts", and posts "Soundboard" tagged Feature.
  - The friend filters by "Bug" (sees "No posts match."), filters by "Feature", opens the post and replies.
  - The owner creates a gallery "photos" and uploads `e2e/fixtures/<an existing image fixture>` with the caption "Board night".
  - The friend sees the tile, opens it and comments "Nice".
  - Select by role and label only.
- [ ] **Step 2: Full local run:**
  - `pnpm lint`, `pnpm -r typecheck` and `pnpm -r test`;
  - `go test ./...` (PowerShell, in `server/`);
  - e2e per `local-dev-environment`: `down -v`, then `up -d --build --wait`, then `pnpm --filter web e2e`, then `down -v`. If Docker is stopped, ask the user before starting it.
- [ ] **Step 3: Checkpoint.** The final whole-branch review.
