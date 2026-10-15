# Watch together: wait for the slowest viewer

Date: 2026-10-14. Status: approved in chat, awaiting spec review.

## Problem

Watch-together keeps a server-authoritative clock (`position` at `updated_at`, plus elapsed time while playing). Each client seeks back when it drifts more than `DRIFT_S` (1.5 s). A viewer on a slow connection buffers, falls behind, gets seeked forward, buffers again, and never catches up. Everyone else plays on, so the group isn't watching the same moment.

## Goal

When any viewer is loading, everyone else pauses at the same moment. When the slowest viewer has loaded, everyone plays together. This applies:

- after start, play and seek, when everyone is loading at once;
- to unexpected stalls during playback.

A single bad connection must not freeze the room. The room waits at most **10 s** for a viewer. A viewer who hits that cap is *excused*: they stop holding the room until they have stayed loaded for **30 s**. Meanwhile they catch up by seeking, as they do today.

The others see **"Waiting for Anna, Bo…"**, or "Loading…" when the room is waiting only for themselves.

Out of scope:

- Twitch live, which has no shared position and never waits.
- Playback-rate nudging for small drift (possible follow-up).
- Any change to the gateway protocol.

## Server (`server/internal/watch`)

### State

`WatchState` gains:

| field | type | meaning |
|---|---|---|
| `seq` | int64 | Bumps on every user action (start, play, pause, seek). Buffering reports name the `seq` they answer. |
| `waiting` | []id.ID (never null) | Viewers the room is holding for. |

The clock runs only if `!paused && len(waiting) == 0 && kind != twitch_live`. `at(now)` implements this. Any change to `waiting`, or to whether the clock runs, first folds the position: `position, updated_at = at(now), now`. That keeps "`position` at `updated_at`" true.

`Service` also keeps, per channel (unexported):

- per watch (dropped when the watch is replaced or stopped):
  - `since map[userID]int64`: when each viewer in `waiting` entered it;
  - `waited map[userID]int64`: how long each viewer has already held the room since the last user action;
  - one `stop func()` for the channel's pending expiry timer.
- per channel, outliving watches and pruned to who is in the call: `people map[userID]{excused, readyAt}`. Any report from a viewer adds them: that viewer has the watch open. (Revised after review: someone in the call who is looking at a text channel has no player and must not hold the room.) After every user action, `waiting` is empty while paused or for Twitch live.

### Who is counted

A viewer is someone in the channel's voice state who is in `people`, meaning they have reported at least once. The first watch in a fresh call therefore doesn't wait at start, but its stalls still do. A viewer *counts* unless they are excused and they haven't yet been continuously ready for 30 s:

- Excusing a viewer clears `readyAt[u]`.
- A `buffering=true` report from an excused viewer also clears it, because they're not smooth yet.
- An excused viewer counts again only once `readyAt[u]` is set and `now - readyAt[u] >= 30 s`. Their excuse is then cleared.

The check is lazy, so no timer is needed for re-admission.

### Transitions

| event | effect |
|---|---|
| start | new state, `seq = max(now ms, old seq + 1)` so a restarted watch never reuses a seq, excuses kept (a new video does not fix a bad connection), `waiting` = counted viewers |
| play | `paused = false`, `seq++`, `waiting` = counted viewers |
| seek | as today, `seq++`, `waiting` = counted viewers (none while paused: the wait happens on play) |
| pause | `paused = true`, `seq++`, `waiting` cleared |
| report `buffering=true` | ignored if `seq` is stale, kind is live, or the room is paused; an excused viewer has `readyAt` cleared and nothing else happens; otherwise the viewer is added to `waiting` |
| report `buffering=false` | ignored if `seq` is stale; sets `readyAt[u] = now` unless it is already set; removes the viewer from `waiting` |
| expiry (a viewer's total wait since the last user action reaches 10 s) | each overdue viewer is removed and marked excused. The total adds up across stalls, so a viewer slower than the bitrate can't make the room stutter forever. |
| viewer leaves voice | removed from `waiting` (existing VOICE_STATE_UPDATE path); the channel is still cleared when empty |

A report that changes nothing publishes nothing. Every change publishes `WATCH_UPDATE` as today, under `pub`.

The expiry timer goes through an injectable `afterFunc(d, f) (stop func())`, defaulting to `time.AfterFunc`. It is rescheduled for the earliest deadline whenever `waiting` changes. Its callback calls `expire(channelID)`, which checks `closed` and compares deadlines against `s.now()`. `Close` stops pending timers. Tests use a fake clock and call `expire` directly.

### API

`POST /api/channels/{channelID}/watch/buffering`, body `{seq: int64, buffering: bool}`, returns **204**.

- 403 `NOT_IN_VOICE` if the caller isn't in the channel.
- 400 `NOTHING_PLAYING` if nothing is on.
- A stale `seq` is not an error: it returns 204 and has no effect.

The OpenAPI spec and `clients/core/src/schema.d.ts` are regenerated (CI checks that they match).

## Client

### Players (`players/types.ts`)

`WatchPlayer` gains:

- `buffering(): boolean`: meant to be playing but stalled.
  - YouTube: player state 3.
  - Twitch: `!isPaused()` and `getCurrentTime()` advanced < 0.25 s between calls ≥ 1 s apart. The Twitch embed has no buffering event, so this is inferred inside `twitch.ts`.
- `loadedAhead(): number | undefined`: seconds loaded past the current time.
  - YouTube: `getVideoLoadedFraction() * duration - currentTime`.
  - Twitch: `undefined` (not exposed).

`playing()` keeps counting buffering as playing.

### Pure logic (`sync.ts`)

- `held(st)`: `st.paused || st.waiting.length > 0`. `expectedPosition` uses it instead of `paused`, and so does the hook when it calls `reconcile`. While held, every player pauses at the frozen position.
- `isReady({time, duration, buffering, loadedAhead})`: true if not buffering and any of these holds:
  - `loadedAhead >= READY_AHEAD_S` (3 s);
  - `duration > 0 && time >= duration - 1`;
  - `loadedAhead === undefined`.
- `nextReport(tracker, input) → {tracker, send?: boolean}`: a small state machine. Input is `{seq, now, buffering, ready, inWaiting, held}`.
  - Sends `true` once the player has been buffering for ≥ `STALL_MS` (750 ms) while the room is not held.
  - Sends `false` once per `seq` when `ready`, and again after a stall. This is how the server learns the viewer has a player, and how an excused viewer earns its way back.
  - Resends every 2 s only while unanswered: a stall that is still going, or `ready` while this viewer is in `waiting`. A new `seq` resets the tracker.

### Hook (`use-watch-sync.ts`)

A 500 ms sample loop feeds `nextReport` and calls the new `client.watchBuffering(channelId, seq, buffering)`. Errors are ignored; the next sample or `seq` retries. Reconcile runs as today: on every state change and every 2 s. "Click to sync" is unchanged. A blocked player is paused, so it is never "buffering".

### UI (`WatchTile.tsx`)

The mature-gate session also edits this file, so edits stay minimal:

- When `waiting` isn't empty, the toolbar stays visible as it does when paused, and shows one line of text: "Waiting for {names of others}…", or "Loading…" if only I am waiting. The "Paused by" text yields to it.
- The toast effect keys on `seq`, not `updated_at`. Barrier changes move `updated_at` and must not re-toast.

## Error handling

- Lost reports: a stall is reported again on the next sample if still stalled. A lost "ready" leaves the room waiting until the 10 s expiry. Acceptable.
- A viewer who closes the tab without leaving voice keeps holding the room until expiry, and then stays excused.
- Out-of-order `WATCH_UPDATE`s are already dropped by `watchStamp`.

## Testing

- Go (`watch_test.go`, `handlers_test.go`):
  - start/play/seek create a barrier of counted viewers;
  - pause clears it;
  - a stale `seq` is ignored;
  - the clock is frozen while waiting and resumes without a jump when the last viewer is ready;
  - a mid-play stall adds the viewer;
  - expiry at 10 s excuses the viewer;
  - an excused viewer doesn't count before 30 s ready and counts after;
  - leaving voice prunes `waiting`;
  - Twitch live never waits;
  - no-op reports don't publish;
  - the handler returns 204 when in voice and 403 when not.
- Vitest (`sync.test.ts`):
  - `held` / `expectedPosition` while waiting;
  - `reconcile` pauses while held;
  - `isReady` cases;
  - `nextReport` debounce, dedupe and `seq` reset.
