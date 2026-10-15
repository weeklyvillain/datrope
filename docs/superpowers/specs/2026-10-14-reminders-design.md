# Reminders — design

**Date:** 2026-10-14
**Status:** approved in brainstorming, awaiting spec review

## Goal

Users can ask to be reminded about a message, or about anything via a slash command. When the time comes, a **System** account sends them a DM. Origin: "remind me på meddelanden där du får dm från system efter tiden / klockslaget, även ett vanligt remind me kommando".

Success:
- "Remind me" on any message, with a preset (20 min, 1 h, 3 h, tomorrow 09:00, next Monday 09:00) or a custom date and time.
- `/remind <when> <text>` sets a free-text reminder. `/reminders` lists the pending ones and can cancel them.
- At the due time (within about a second), a DM from System arrives. It quotes the message, with Jump to message.
- Reminders survive server restarts. Overdue ones fire on boot.

Out of scope (YAGNI): snooze, editing a reminder, recurring reminders, Swedish words in `/remind`, reminders for other people.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Who sends | A real **System user** row. Each user has a 1:1 DM with it, and that DM is read-only. |
| Time input | Presets in a submenu. **Custom…** opens a wheel dialog (day / hour / minute). |
| Timezone | The client resolves every input to an absolute UTC `due_at`. The server never parses times. |
| `/remind` syntax | Compact English, see [Syntax](#remind-syntax). |
| Manage | `/reminders` and a ⏰ button in the System DM header open a side-panel list with cancel. An Undo toast follows each set. |
| DM content | `Reminder: <note>` plus a **live** quote card, resolved per viewer when read. A deleted or inaccessible message shows "Message unavailable". No snapshot is stored. |
| Scheduler | Wake-on-next timer backed by the DB (approach 1). |
| UI | Setting reminders as in mockup A, the dialog from mockup C (`docs/superpowers/mockups/Reminders.html`). |

## Server

### Migration `00048_reminders.sql`

The number may collide with parallel branches; renumber at merge.

```sql
-- +goose Up
ALTER TABLE users ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX users_one_system ON users (is_system) WHERE is_system;
-- 'system!' fails the username pattern, so no account can ever collide with it.
-- password_hash '!' matches no bcrypt hash: nobody can log in as System.
-- disabled keeps System out of the server's owner and member queries.
INSERT INTO users (id, username, display_name, password_hash, disabled, is_system)
VALUES (4194303, 'system!', 'System', '!', TRUE, TRUE);

CREATE TABLE reminders (
    id         BIGINT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    due_at     TIMESTAMPTZ NOT NULL,
    note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    channel_id BIGINT,  -- the message reminded about; no FK: it may be deleted later
    message_id BIGINT,
    fired_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) = (message_id IS NULL))
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE fired_at IS NULL;
CREATE INDEX reminders_user_idx ON reminders (user_id) WHERE fired_at IS NULL;

ALTER TABLE messages ADD COLUMN reminder_id BIGINT; -- set on kind = 'reminder' messages

-- +goose Down
ALTER TABLE messages DROP COLUMN reminder_id;
DROP TABLE reminders;
DELETE FROM users WHERE is_system;
ALTER TABLE users DROP COLUMN is_system;
```

System's fixed ID is `auth.SystemUserID = 1<<22 - 1` (4194303): the snowflake generator could only produce it in its epoch's first millisecond, so it never collides with a real user, nor with the small IDs migration tests seed by hand (id 1 did).

### System user

- `auth.SystemUserID` is the constant. The public user JSON gains `system: true` (`omitempty`).
- User counts (first user becomes admin), `ListUsers`, `@username` resolution and login lookups add `NOT is_system`, so logging in as `system` fails like an unknown user (the hash `'!'` would never verify anyway). Its username `system!` fails the username pattern, so no account can collide with it and the username index is untouched (the migration stays expand-only for zero-downtime updates); a person may register as `system`.
- System is never a community member, so it never appears in member lists or mentions. User search, if any, excludes `is_system`.
- `channels.createDM` gets an internal `SystemDM(ctx, userID)` that finds or creates the 1:1 DM between `userID` and System, skipping the shared-community check. The public `POST /api/dms` rejects System as a recipient (`INVALID_RECIPIENTS`).
- In a DM whose other participant is System, sending a message, creating a poll and creating a thread return 403 `SYSTEM_DM` ("you can't reply to System"). Reactions are allowed. System's messages can't be edited or deleted by the user (they already fail the author check).

### Package `internal/reminders`

`Service{db, bus, channels, messages}`. It is registered in `app.New` like the others, and `Start()` runs when a database is present.

Endpoints (huma, `auth` required, IDs as strings like elsewhere):

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/reminders` | `{due_at, note?, channel_id?, message_id?}` → `Reminder` (201) |
| GET | `/api/reminders` | → `{reminders: Reminder[]}`, pending only, sorted by `due_at` |
| DELETE | `/api/reminders/{id}` | 204; 404 if it isn't yours or has already fired |

`Reminder = {id, due_at, note, channel_id?, message_id?, quote?}`. `quote` is the same type as on the DM message (see below), so the list can show "Maja · #general".

Validation on create:
- `due_at` must be more than 0 s and at most 366 days from now → `INVALID_DUE_AT`.
- `note` is at most 500 characters → `VALIDATION_FAILED`.
- With `message_id`: the caller must be able to read `channel_id` (`channels.Access(..., ReadMessages)`), and the message must exist in it, not deleted → `404 message`.
- At most 100 pending per user → `TOO_MANY_REMINDERS` (400).

Creating or deleting a reminder publishes `REMINDERS_UPDATE` to the user over the gateway, so other tabs refresh the list.

### Scheduler

```
loop:
  next := SELECT min(due_at) FROM reminders WHERE fired_at IS NULL
  wait := clamp(next - now, 0, 1 min)        // 1 min if none
  select { case <-time.After(wait): case <-s.wake: case <-ctx.Done(): return }
  s.fireDue(ctx)
```

- `s.wake` is a `chan struct{}` with a buffer of 1. Create and cancel do a non-blocking send.
- `fireDue` claims in batches of 50:
  ```sql
  UPDATE reminders SET fired_at = now()
  WHERE id IN (SELECT id FROM reminders WHERE fired_at IS NULL AND due_at <= now()
               ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED)
  RETURNING id, user_id, note, channel_id, message_id
  ```
  For each claimed row it calls `messages.PostReminder(ctx, r)`. Errors are logged and not retried. The row is already marked fired, so a broken row can't loop, and the risk is losing one reminder rather than spamming. Batches repeat until one comes back short.
- Restart recovery: the first loop pass runs immediately on `Start()`, so overdue reminders fire at boot.
- The clock is injectable (`now func() time.Time`) for tests.

### Delivery: `messages.PostReminder`

1. `chID := channels.SystemDM(ctx, r.UserID)`.
2. Insert a message: `author_id = SystemUserID`, `kind = 'reminder'`, `content = "Reminder"` or `"Reminder: <note>"` (what notifications and the DM list preview show), `reminder_id = r.ID`. The jump target lives on the reminder row, which is joined during hydration.
3. Hydrate and publish `MESSAGE_CREATE` like any DM message, so unread counts, desktop notifications and web push follow the normal DM path.

### Hydration: `Message.reminder`

`Kind` enum gains `reminder`. For messages with `kind = 'reminder'`, hydration adds:

```
reminder: { note: string, target?: { channel_id, message_id },
            quote?: { author: UserRef|webhook name, channel_name, created_at, excerpt } ,
            unavailable?: true }
```

- If the reminder has no target, there is no quote (a free-text `/remind`).
- Otherwise, load the target message. If it's missing or deleted, or the **viewer** fails `channels.Access(ReadMessages)` on its channel, set `unavailable: true` and send no quote or target.
- `excerpt` is the first 200 characters of content (plus `…` when cut). It is empty for an attachment-only message, and the client then shows "Attachment".
- The viewer is the requesting user on list, and the owner (the only reader) on publish.

## Web client

### Time resolution — `chat/remind-time.ts` (pure, tested)

- `presets(now)` returns `[{label, due}]`: +20m, +1h, +3h, tomorrow 09:00, next Monday 09:00 (always the *next* one, never today).
- `parseWhen(text, now)` returns `{due, rest} | null`. See the syntax below.
- `relative(due, now)` returns "in 18 h 58 min".

### `/remind` syntax

`/remind <when> <text>`. `when` is the leading token(s):

| Input | Meaning |
|---|---|
| `20m`, `2h`, `1d`, `1h30m` | duration from now (units `m h d`, combinable, total > 0) |
| `14:30`, `9:05` | today at that time, or tomorrow if it has passed |
| `tomorrow` / `tomorrow 9` / `tomorrow 14:30` | tomorrow 09:00 by default |
| `mon` … `sun` [`HH[:MM]`] | next such weekday (a week out if it's today), 09:00 by default |

Bare hours (`9`) are only accepted after `tomorrow` or a weekday. Bare `/remind` opens the wheel dialog with no quote. An unparseable `when`, or a missing text, returns `{error: "Usage: /remind <20m|2h|14:30|tomorrow 9|fri 13:00> <text>"}`. On success, the command calls `ctx.createReminder` and returns `{done: true}`, then a toast "Reminder set for Thu 09:00" with Undo.

`/reminders` returns `{done: true}` after opening the side panel `{kind: "reminders"}`.

`CommandContext` gains `createReminder(body)` and `openReminders()`. `ModalKind` gains `"reminder"`.

### Message action

- **Desktop** (`MessageToolbar` → More actions): a `Remind me` submenu (shadcn `DropdownMenuSub`) with the 5 presets, each with its resolved time right-aligned ("14:24", "Thu 09:00"), then a separator, then `Custom…`.
- **Phone** (`message-actions.ts` sheet): `Remind me` opens the wheel dialog directly.
- Hidden on messages in the System DM itself.
- On success: the toast "Reminder set for <time>" with Undo (which calls DELETE).

### Wheel dialog — `app/dialogs/ReminderDialog.tsx`

- shadcn `Dialog`. Title: "Remind me about this message", or "New reminder" without a message.
- A quote of the message (author · #channel, excerpt), when there is a message.
- Three scroll wheels: day (Today, Tomorrow, then weekday + date for 12 more days), hour 00–23, minute 00–55 in steps of 5. Defaults to the next full quarter hour + 1 h. Keyboard: arrow keys on the focused wheel, and each wheel is a `role="spinbutton"` with an `aria-label`.
- Chips `+20m`, `+1h`, `+3h` move the wheels to now + that.
- A live preview "in X h Y min". If the time is in the past, the preview shows "That time has passed" and Set is disabled.
- A note `Input` (optional, max 500).
- Footer: Cancel, and **Set reminder** (primary).

### System DM rendering

- An author with `system: true` gets the ⏰ avatar on `bg-primary` and a `SYSTEM` badge (like the existing WEBHOOK badge). No profile popover.
- A `kind: "reminder"` message renders `Reminder` (plus `: <note>` in bold when there is one), and below it the quote card: `author · #channel · time`, excerpt, and a `Jump to message` button (`openMessage`). With `unavailable`: "Message unavailable — it was deleted, or you no longer have access."
- In a DM whose other participant is System, the composer is replaced by a muted bar "You can't reply to System.", and the header gets a ⏰ button (tooltip "Reminders") that opens the panel. The message toolbar shows only react and copy.
- The DM list shows System with its avatar like any DM.

### Reminders side panel

`side-panel` gains `{kind: "reminders"}` with the title "Reminders". It shows pending reminders from `GET /api/reminders`, refetched on `REMINDERS_UPDATE`. Each row shows the time (`Today 15:04`, `Thu 09:00`, `17 Oct 13:30`), the note or "—", and below that `author · #channel` (or nothing), with a ✕ that cancels. Clicking a row with a target jumps to it. Empty state: "No reminders. Use /remind or Remind me on a message."

### Core client

`clients/core`: regenerate `schema.d.ts`, then add `createReminder`, `listReminders` and `deleteReminder` to the API client, and handle the `REMINDERS_UPDATE` event (no store; the panel fetches).

## Error handling

| Case | Behaviour |
|---|---|
| Message deleted before firing | Still fires; the quote shows "Message unavailable". |
| Access lost before firing | Same; nothing leaks. |
| User deleted | `ON DELETE CASCADE` removes their reminders. |
| Server down at due time | Fires on boot (claim query matches `due_at <= now()`). |
| Post fails | Logged and dropped (already marked fired) to avoid a retry storm. |
| Two server instances | `FOR UPDATE SKIP LOCKED` keeps each reminder firing once. |

## Testing

Go (`pgtest`/`apptest`, as in existing packages):
- Create validation: past or too-far `due_at`, note too long, a message in a channel you can't read (404), the 100-pending limit.
- List/delete only see your own pending reminders. Deleting another user's returns 404.
- Scheduler with an injected clock: a due reminder fires once and posts a `kind=reminder` message from System in the user's System DM. A second pass doesn't refire it. A not-yet-due one stays pending.
- **Restart recovery:** insert an overdue row, construct a fresh `Service`, `Start()` it, and assert the DM arrives.
- Hydration: a live quote for the owner; `unavailable` after the target is deleted and after the owner loses channel access.
- System DM: replying returns 403 `SYSTEM_DM`; `POST /api/dms` with System returns `INVALID_RECIPIENTS`; logging in as `system` fails.

Web (vitest):
- `remind-time.test.ts`: every syntax row, the past-clock rollover, weekday-today → next week, DST-agnostic local times, rejects.
- `commands.test.ts`: `/remind` success, error and bare cases; `/reminders`.
- `ReminderDialog` test: the chips move the wheels, a past time disables Set, submit sends `due_at` as UTC ISO.

Manual or browser preview: set a 1-minute reminder from the submenu, watch the System DM arrive, Jump to message, cancel from the panel.
