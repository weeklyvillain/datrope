# Batch C (voice: AFK, stats, teams) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- An AFK voice channel that people get moved to after N minutes without speech (item 1).
- A connection panel with the last 30 seconds of ping, jitter and packet loss, plus each peer's ping (item 4).
- A team randomizer that drafts teams from the people in the call and shows them to everyone (item 5).

**Architecture:**
- **AFK:** two server settings, `afk_channel_id` and `afk_timeout_seconds`.
  - The client measures its own silence and asks `POST /api/voice/afk` to move it.
  - The voice service grants no publish sources in the AFK channel, both at join and in Reconcile.
- **Stats:** `stats.ts` keeps a 30-sample history at 1 s.
  - Peers share their ping through a rate-limited `POST /api/voice/ping`, which fans out `VOICE_PING` to the call.
  - That replaces the spec's LiveKit participant attributes (see Ruling 1).
- **Teams:** `POST /api/voice/{id}/teams` deals with crypto randomness and fans out `VOICE_TEAMS` to the call, following the soundboard pattern. The result opens in the call's side panel, next to Chat and Music.

**Tech Stack:** Go (huma, pgx, goose, LiveKit protocol), React 18, zustand, Tailwind v4, shadcn (Dialog, Checkbox, Select, Tabs), Vitest in node, and Go tests with apptest and lktest (Docker).

**Spec:** `docs/superpowers/specs/2026-10-14-multi-features-design.md`, sections C1, C2 and C3.

**Mockups:**
- `docs/superpowers/mockups/VoiceStats.html`: concept **C · Signal bars + tabs**.
- `docs/superpowers/mockups/TeamRandomizer.html`: concept **C · Side panel**, with the shared setup dialog.

## Rulings (made while planning)

1. **Peer ping goes through the server, not LiveKit attributes.** The spec says to publish ping as a participant attribute, which needs `CanUpdateOwnMetadata`. But Reconcile trusts the participant attributes `datrope.session` and `datrope.issued` to kick revoked sessions (`reconcile.go:158`). Letting a client rewrite its own attributes would let it dodge that check. So the plan uses `POST /api/voice/ping`, rate limited, which publishes `VOICE_PING` to the people in the call. The cost is one small request per user every 5 s.
2. **No toast for the AFK move.** The app has no toast system. The voice panel shows a status line instead: "Moved to AFK after 15 min of silence".
3. **The AFK settings go in a new "Voice" section of server settings** (group Server, `ManageServer`). They are saved with the existing `PATCH /api/server`.

## Global Constraints

- Never commit (AGENTS.md §5). Stage only.
- Never hardcode colors. New colors become tokens in `clients/web/src/styles.css` (`:root` plus `@theme inline`) first.
- The app is dark-only.
- Keep accessible names stable.
- Vitest runs in node, with no DOM. Put the logic in pure functions.
- Go tests need Docker. Use `GOTOOLCHAIN=local`. `rtk` is not on subagents' PATH.
- The next migration is `00044`; `00043` exists. Batch C's upload plan takes `00045`.
- AFK timeouts are exactly 300, 900, 1800 and 3600 seconds. The default is 900.
- Stats: 30 samples, every 1000 ms. Thresholds are the existing `LIMITS` in `stats.ts`: rtt [100, 250], loss [1, 5] and jitter [20, 50] are the good and ok upper bounds.
- Peer ping: a client sends `POST /api/voice/ping` every 5 s while connected. The server accepts at most 1 per 2 s per user, and the estimate shown is "≈ (their ping + mine) ms to you".
- Teams: 2–8 teams. `per_team` is optional (1–50). The pool has 2–100 users, all of them currently in that call. Leftovers go to the bench.

## Review Focus

1. **Someone muted by a moderator, or someone who lacks Speak, goes AFK and comes back.** Their sources must not be re-granted wrongly. AFK grants none, and the channel they return to grants what their permissions allow. Covered by a test in Task 1.
2. **Deafened users.** They count as idle even when their mic picks up sound, because a deafened user doesn't refresh `lastActive`. Covered by a test in Task 2.
3. **No AFK channel set, the timeout changed mid-call, or the AFK channel deleted** (`ON DELETE SET NULL`). The client must not loop calling `/afk`: it tries at most once per channel join. Covered by a test in Task 2.
4. **A team draw that names users who left the call between the dialog and Draw.** The server rejects it with a clear error, and the dialog shows it. Covered by a test in Task 6.
5. **A ping flood or forged peer ping.** It is rate limited, the server sets `user_id`, and `rtt_ms` is clamped to 0–10000. Covered by a test in Task 4.

---

### Task 1: AFK settings and the AFK move (server)

**Files:**
- Create: `server/internal/db/migrations/00044_afk.sql`
- Modify: `server/internal/communities/communities.go` (the `Server` struct, and the `Server()` SELECT and scan)
- Modify: `server/internal/communities/handlers.go` (`UpdateServerRequest` and the PATCH handler)
- Create: `server/internal/voice/afk.go`
- Modify: `server/internal/voice/voice.go` (`Join` uses `sourcesFor`, and a new field `afk AFKLookup` with `SetAFK`)
- Modify: `server/internal/voice/reconcile.go:167` (`want := ...` uses `sourcesFor`)
- Modify: `server/internal/voice/handlers.go` (register the afk route)
- Modify: `server/internal/app/app.go:181` (`voiceSvc.SetAFK(commSvc)`)
- Test: `server/internal/voice/afk_test.go`
- Test: `server/internal/communities/afk_settings_test.go`

**Interfaces:**
- Produces, JSON on `Server`: `afk_channel_id` (string ID, omitted when unset) and `afk_timeout_seconds` (int, one of 300, 900, 1800, 3600).
- Produces, PATCH `/api/server` body: `afk_channel_id` (string; an empty string clears it) and `afk_timeout_seconds`.
- Produces, Go:
  - `type AFKLookup interface { AFKChannel(ctx context.Context, communityID id.ID) (*id.ID, error) }`, implemented by `communities.Service`;
  - `func (s *Service) SetAFK(a AFKLookup)`;
  - `func (s *Service) GoAFK(ctx context.Context, userID id.ID) error`;
  - the route `POST /api/voice/afk`, which returns 204.
- Produces, events: `VOICE_MOVE` to the user, which already exists.

- [ ] **Step 1: Write the failing tests**

`server/internal/communities/afk_settings_test.go`:

```go
package communities_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
)

func TestAFKSettings(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var voice channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "AFK", "type": "voice"}, http.StatusCreated, &voice)

	var sv communities.Server
	alice.Do(http.MethodGet, "/api/server", nil, http.StatusOK, &sv)
	require.Nil(t, sv.AFKChannelID)
	require.Equal(t, 900, sv.AFKTimeoutSeconds)

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": voice.ID.String(), "afk_timeout_seconds": 300}, http.StatusOK, &sv)
	require.Equal(t, voice.ID, *sv.AFKChannelID)
	require.Equal(t, 300, sv.AFKTimeoutSeconds)

	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": alice.General().String()}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
	alice.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_timeout_seconds": 60}, http.StatusBadRequest, "VALIDATION_FAILED")

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": ""}, http.StatusOK, &sv)
	require.Nil(t, sv.AFKChannelID)

	bob := env.Register("bob")
	bob.Join(alice.Invite())
	bob.Fail(http.MethodPatch, "/api/server", map[string]any{"afk_timeout_seconds": 300}, http.StatusForbidden, "MISSING_PERMISSION")
}
```

If `GET /api/server` is not the route that returns the server object, find the real one (`grep -n "get-server" server/internal/communities/handlers.go`) and use it. The same goes for the `Join` and `Invite` helper names in apptest.

`server/internal/voice/afk_test.go`:

```go
package voice_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

func TestGoAFK(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	afk := createVoice(alice, "AFK")

	enter(t, env, cfg, bob, c.voiceID)
	bob.Fail(http.MethodPost, "/api/voice/afk", nil, http.StatusConflict, "AFK_NOT_SET")

	alice.Do(http.MethodPatch, "/api/server", map[string]any{"afk_channel_id": afk.String()}, http.StatusOK, nil)
	bobWS, _ := bob.Connect()
	bob.Do(http.MethodPost, "/api/voice/afk", nil, http.StatusNoContent, nil)
	var mv voice.VoiceMove
	bobWS.ExpectDispatch("VOICE_MOVE", &mv)
	require.Equal(t, afk, mv.ChannelID)

	// In the AFK channel nobody can publish anything, not even the owner.
	enter(t, env, cfg, bob, afk)
	require.Empty(t, sourcesOf(t, cfg, afk, bob.User.ID))
	enter(t, env, cfg, alice, afk)
	require.Empty(t, sourcesOf(t, cfg, afk, alice.User.ID))

	// Already there: nothing to do.
	bob.Do(http.MethodPost, "/api/voice/afk", nil, http.StatusNoContent, nil)
	bobWS.ExpectNoDispatch("VOICE_MOVE", 300*time.Millisecond)

	// Back in a normal channel the usual permissions apply again, and Reconcile keeps AFK empty.
	enter(t, env, cfg, bob, c.voiceID)
	require.NotEmpty(t, sourcesOf(t, cfg, c.voiceID, bob.User.ID))
	setEveryone(alice, c.community.ID, perms.Default) // a permission change triggers Reconcile
	require.NoError(t, env.App.Voice.Sync(t.Context()))
	require.Empty(t, sourcesOf(t, cfg, afk, alice.User.ID))
}

func TestGoAFKNotInVoice(t *testing.T) {
	env, _ := liveKitEnv(t)
	c := newClub(t, env)
	c.member.Fail(http.MethodPost, "/api/voice/afk", nil, http.StatusNotFound, "NOT_FOUND")
}
```

Check the real signature of `sourcesOf` (reconcile_test.go:32) and adapt the calls.

- [ ] **Step 2: Run them and watch them fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/communities ./internal/voice -run 'AFK'`
Expected: FAIL to compile, because there are no AFK fields or routes yet.

- [ ] **Step 3: Implement the migration and community settings**

`00044_afk.sql`:

```sql
-- +goose Up
-- A voice channel that idle people get moved to, and after how long without speaking.
ALTER TABLE communities
  ADD COLUMN afk_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  ADD COLUMN afk_timeout_seconds INT NOT NULL DEFAULT 900 CHECK (afk_timeout_seconds IN (300, 900, 1800, 3600));

-- +goose Down
ALTER TABLE communities DROP COLUMN afk_timeout_seconds, DROP COLUMN afk_channel_id;
```

Check the type of `channels.id` in an existing migration. If it is not BIGINT, match it.

In `communities.go`, add these to the `Server` struct:

```go
	AFKChannelID      *id.ID `json:"afk_channel_id,omitempty" doc:"Voice channel idle members are moved to"`
	AFKTimeoutSeconds int    `json:"afk_timeout_seconds" enum:"300,900,1800,3600" doc:"Seconds without speaking before the move"`
```

Then extend the SELECT in `Server()` with `afk_channel_id, afk_timeout_seconds`, and scan into a `*int64`, converted with `id.FromNullable`, and `&sv.AFKTimeoutSeconds`. Add the method:

```go
// AFKChannel is the community's AFK voice channel, if one is set (the voice service asks).
func (s *Service) AFKChannel(ctx context.Context, communityID id.ID) (*id.ID, error) {
	var ch *int64
	if err := s.db.QueryRow(ctx, `SELECT afk_channel_id FROM communities WHERE id = $1`, communityID).Scan(&ch); err != nil {
		return nil, err
	}
	return id.FromNullable(ch), nil
}
```

In `handlers.go`:
- Add these to `UpdateServerRequest`:

```go
	AFKChannelID      *string `json:"afk_channel_id,omitempty" doc:"A voice channel of this server; empty clears it"`
	AFKTimeoutSeconds *int    `json:"afk_timeout_seconds,omitempty" enum:"300,900,1800,3600"`
```

- In the PATCH handler, before the UPDATE, parse `AFKChannelID`:
  - `""` means clear: write `afk_channel_id = NULL`;
  - otherwise use `httpx.ParseID`, then check `SELECT type FROM channels WHERE id = $1 AND community_id = $2`. If there is no row, return `httpx.NotFound("channel")`. If the type is not `voice`, return `httpx.BadRequest("NOT_VOICE_CHANNEL", "the AFK channel must be a voice channel")`.
- Extend the UPDATE:
  - `afk_timeout_seconds = COALESCE($5, afk_timeout_seconds)`;
  - set `afk_channel_id` only when the field was sent, for example with `CASE WHEN $6 THEN $7 ELSE afk_channel_id END`, where `$6` is "field present" and `$7` is the nullable ID.
- Add `audit.Diff` entries for `afk_channel` and `afk_timeout`.
- `PublishServerUpdate` already runs, so clients get the new values.

- [ ] **Step 4: Implement the voice side**

`server/internal/voice/afk.go`:

```go
package voice

import (
	"context"
	"net/http"
	"time"

	"github.com/livekit/protocol/livekit"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// AFKLookup finds a community's AFK voice channel (communities.Service).
type AFKLookup interface {
	AFKChannel(ctx context.Context, communityID id.ID) (*id.ID, error)
}

func (s *Service) SetAFK(a AFKLookup) { s.afk = a }

// isAFK reports whether c is its server's AFK channel.
func (s *Service) isAFK(ctx context.Context, c *channels.Channel) (bool, error) {
	if s.afk == nil || c.CommunityID == nil || c.Type != channels.TypeVoice {
		return false, nil
	}
	afk, err := s.afk.AFKChannel(ctx, *c.CommunityID)
	return err == nil && afk != nil && *afk == c.ID, err
}

// sourcesFor is what someone may publish in c: nothing in the AFK channel, else what their permissions allow.
func (s *Service) sourcesFor(ctx context.Context, c *channels.Channel, p perms.Perms, serverMute bool) ([]livekit.TrackSource, error) {
	afk, err := s.isAFK(ctx, c)
	if err != nil {
		return nil, err
	}
	if afk {
		return []livekit.TrackSource{}, nil
	}
	return Sources(p, serverMute), nil
}

// GoAFK moves the caller from their voice channel to the server's AFK channel (their client saw them idle).
// It gives the same one-join pass a moderator's move does, so CONNECT is not needed there.
func (s *Service) GoAFK(ctx context.Context, userID id.ID) error {
	s.mu.Lock()
	p := s.users[userID]
	var from id.ID
	if p != nil {
		from = p.channelID
	}
	s.mu.Unlock()
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	c, _, err := s.channels.Access(ctx, userID, from, 0)
	if err != nil {
		return err
	}
	if c.CommunityID == nil || s.afk == nil {
		return httpx.E(http.StatusConflict, "AFK_NOT_SET", "this server has no AFK channel")
	}
	to, err := s.afk.AFKChannel(ctx, *c.CommunityID)
	if err != nil {
		return err
	}
	if to == nil {
		return httpx.E(http.StatusConflict, "AFK_NOT_SET", "this server has no AFK channel")
	}
	if *to == from {
		return nil
	}
	theirs, _, err := s.channels.Perms(ctx, userID, *to)
	if err != nil {
		return err
	}
	if !theirs.Has(perms.ViewChannel) {
		return httpx.E(http.StatusForbidden, "MISSING_PERMISSION", "you cannot see the AFK channel")
	}
	s.mu.Lock()
	s.moves[userID] = movePass{channelID: *to, until: time.Now().Add(movePassTTL)}
	s.mu.Unlock()
	s.bus.Publish(events.Event{Type: "VOICE_MOVE", Data: VoiceMove{ChannelID: *to}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	return nil
}
```

`voice.go`:
- Add the field `afk AFKLookup // nil until SetAFK` to `Service`.
- In `Join`, replace `Sources(p, serverMute)` with:

```go
	sources, err := s.sourcesFor(ctx, c, p, serverMute)
	if err != nil {
		return nil, err
	}
```

  and pass `sources` to `JoinToken`.

`reconcile.go:167`: `want := Sources(allowed, serverMute)` becomes a `sourcesFor` call. Reconcile has the channel ID; fetch the channel object the way the surrounding code already does (look for where `allowed` comes from, likely `s.channels.Perms`, which returns `(perms, *channels.Channel, err)`). On error, return it as the loop does for other errors.

`handlers.go` (voice), inside `Register`:

```go
	huma.Register(api, op("go-afk", http.MethodPost, "/api/voice/afk", http.StatusNoContent),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			return nil, s.GoAFK(ctx, me(ctx).ID)
		})
```

`app.go`: after `voiceSvc.SetSounds(exprSvc)`, add `voiceSvc.SetAFK(commSvc)`.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `GOTOOLCHAIN=local go -C server test ./internal/communities ./internal/voice`
Expected: PASS, including all the existing voice tests.

- [ ] **Step 6: Regenerate the client types, fix the fixtures, and stage**

From clients/core, run `pnpm run gen`. Then add `afk_timeout_seconds: 900` to the `Server` fixtures in `clients/core/src/store.test.ts:12` and `clients/core/src/client.test.ts:171`. Run `corepack pnpm -r typecheck`, which must pass.

```bash
git add server/internal/db/migrations/00044_afk.sql server/internal/communities server/internal/voice server/internal/app/app.go clients/core/openapi.json clients/core/src/schema.d.ts clients/core/src/store.test.ts clients/core/src/client.test.ts
```

---

### Task 2: AFK on the client (idle detection, settings, mic state)

**Files:**
- Create: `clients/web/src/voice/afk.ts`
- Test: `clients/web/src/voice/afk.test.ts`
- Modify: `clients/web/src/voice/voice.ts` (track `lastActive`, a 30 s check, and the `notice` field)
- Modify: `clients/core/src/client.ts` (`goAFK()`, next to `moveVoice`)
- Create: `clients/web/src/app/server-settings/VoiceAFK.tsx`
- Modify: `clients/web/src/app/server-settings/ServerSettings.tsx` (a section `{ id: "voice", label: "Voice", group: "Server", icon: Moon, visible: can(Perm.ManageServer), element: <VoiceAFK /> }` after "look")
- Modify: `clients/web/src/app/voice/VoicePanel.tsx` (show `notice`; `MuteControl` is disabled in the AFK channel)

**Interfaces:**
- Consumes: `Server.afk_channel_id?: string`, `Server.afk_timeout_seconds: number` and `POST /api/voice/afk` (Task 1).
- Produces:
  - `shouldGoAFK(s: { now: number; lastActive: number; timeoutS: number; channelId?: string; afkChannelId?: string; status: string; tried: boolean }): boolean`;
  - `isAFKChannel(serverAfkId: string | undefined, channelId: string | undefined): boolean`;
  - `VoiceView.notice?: string`;
  - `client.goAFK(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`clients/web/src/voice/afk.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isAFKChannel, shouldGoAFK } from "./afk";

const base = { now: 1_000_000, lastActive: 1_000_000 - 901_000, timeoutS: 900, channelId: "5", afkChannelId: "9", status: "connected", tried: false };

describe("shouldGoAFK", () => {
  it("fires after the timeout of silence", () => expect(shouldGoAFK(base)).toBe(true));
  it("waits until the timeout", () => expect(shouldGoAFK({ ...base, lastActive: base.now - 899_000 })).toBe(false));
  it("never without an AFK channel, outside a call, or while already there", () => {
    expect(shouldGoAFK({ ...base, afkChannelId: undefined })).toBe(false);
    expect(shouldGoAFK({ ...base, status: "reconnecting" })).toBe(false);
    expect(shouldGoAFK({ ...base, channelId: "9" })).toBe(false);
  });
  it("tries once per channel join", () => expect(shouldGoAFK({ ...base, tried: true })).toBe(false));
});

describe("isAFKChannel", () => {
  it("matches the server's AFK channel", () => {
    expect(isAFKChannel("9", "9")).toBe(true);
    expect(isAFKChannel("9", "5")).toBe(false);
    expect(isAFKChannel(undefined, "5")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/voice/afk.test.ts` (from clients/web)
Expected: FAIL, because the module is missing.

- [ ] **Step 3: Implement `afk.ts`**

```ts
/** Whether my client should ask to be moved to AFK: in a call, idle for the server's timeout, not there yet. */
export function shouldGoAFK(s: {
  now: number; lastActive: number; timeoutS: number; channelId?: string; afkChannelId?: string; status: string; tried: boolean;
}): boolean {
  if (s.tried || s.status !== "connected" || !s.afkChannelId || !s.channelId || s.channelId === s.afkChannelId) return false;
  return s.now - s.lastActive >= s.timeoutS * 1000;
}

export const isAFKChannel = (serverAfkId: string | undefined, channelId: string | undefined) =>
  !!serverAfkId && serverAfkId === channelId;
```

- [ ] **Step 4: Wire it into `voice.ts`**

- Add these fields: `private lastActive = 0; private afkTried = false; private afkTimer?: ReturnType<typeof setInterval>;`.
- On a successful connect, in `join` after `status: "connected"`, add:

```ts
      this.lastActive = Date.now();
      this.afkTried = false;
      clearInterval(this.afkTimer);
      this.afkTimer = setInterval(() => this.checkAFK(), 30_000);
```

- In the `ActiveSpeakersChanged` handler, add `if (!this.store.getState().deafened && speakers.some((p) => p === room.localParticipant)) this.lastActive = Date.now();`. A deafened user stays idle.
- In `disconnect()`, add `clearInterval(this.afkTimer);`.
- Add the method:

```ts
  /** Asks to be moved to the server's AFK channel after its timeout of silence (deafened counts as silent). */
  private checkAFK() {
    const v = this.store.getState();
    const ch = v.channelId ? client.store.getState().channels[v.channelId] : undefined;
    const sv = client.store.getState().server?.server;
    if (!ch || ch.type !== "voice" || !sv) return;
    if (!shouldGoAFK({ now: Date.now(), lastActive: this.lastActive, timeoutS: sv.afk_timeout_seconds, channelId: v.channelId,
      afkChannelId: sv.afk_channel_id ?? undefined, status: v.status, tried: this.afkTried })) return;
    this.afkTried = true;
    const minutes = Math.round(sv.afk_timeout_seconds / 60);
    this.pendingNotice = `Moved to AFK after ${minutes} min of silence`;
    void client.goAFK().catch(() => { this.pendingNotice = undefined; });
  }
```

- Add `notice?: string` to `VoiceView`, and `notice: undefined` to `idle`. Add the field `private pendingNotice?: string;`.
- The move arrives as `VOICE_MOVE`, which re-joins, and that resets the view to `idle`. So apply the notice after connecting: in `join`, right after `status: "connected"`, add `if (this.pendingNotice) { this.set({ notice: this.pendingNotice }); this.pendingNotice = undefined; }`.

In `client.ts`:

```ts
  /** Moves me to the server's AFK voice channel (my client saw me idle). */
  async goAFK() {
    await unwrap(this.api.POST("/api/voice/afk"));
  }
```

- [ ] **Step 5: Add the settings section**

`clients/web/src/app/server-settings/VoiceAFK.tsx`:

```tsx
import { unwrap } from "@datrope/core";
import { useState } from "react";
import { ErrorText } from "@/components/error-text";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useSubmit } from "@/hooks/use-submit";
import { client, useApp } from "@/session";

const TIMEOUTS = [[300, "5 minutes"], [900, "15 minutes"], [1800, "30 minutes"], [3600, "1 hour"]] as const;

/** The AFK channel: where people who haven't spoken for a while get moved (MANAGE_SERVER). */
export function VoiceAFK() {
  const sv = useApp((s) => s.server?.server);
  const voiceChannels = useApp((s) => (s.server?.channelIds ?? []).map((id) => s.channels[id]).filter((c) => c?.type === "voice"));
  const [channel, setChannel] = useState(sv?.afk_channel_id ?? "");
  const [timeout, setTimeout_] = useState(sv?.afk_timeout_seconds ?? 900);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useSubmit();
  return (
    <section className="grid gap-3" aria-labelledby="afk-h">
      <h3 id="afk-h" className="text-sm font-semibold">AFK channel</h3>
      <p className="max-w-[68ch] text-muted-foreground">People in a voice call who haven't spoken for this long are moved here. Nobody can talk or share in the AFK channel.</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void run(async () => {
          await unwrap(client.api.PATCH("/api/server", { body: { afk_channel_id: channel, afk_timeout_seconds: timeout } }));
          setSaved(true);
        });
      }}>
        <div className="grid gap-1.5">
          <Label htmlFor="afk-channel">Channel</Label>
          <NativeSelect id="afk-channel" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">None</option>
            {voiceChannels.map((c) => <option key={c!.id} value={c!.id}>{c!.name}</option>)}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="afk-timeout">Move after</Label>
          <NativeSelect id="afk-timeout" value={timeout} onChange={(e) => setTimeout_(Number(e.target.value))}>
            {TIMEOUTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy}>Save</Button>
        {saved && <span role="status" className="self-center text-muted-foreground">Saved</span>}
      </form>
      <ErrorText error={error} />
    </section>
  );
}
```

Check `NativeSelect`'s props in `components/ui/native-select.tsx` and adapt (it may wrap options differently). The `useApp` selector returns a new array on every call, so wrap it with `useShallow` from `zustand/react/shallow`, as other components do.

- [ ] **Step 6: Show the notice, and disable the mic in AFK**

In `VoicePanel.tsx`:
- Read `notice` in the `VoicePanel` selector, and render `{v.notice && <p className="text-xs text-muted-foreground" role="status">{v.notice}</p>}` under the channel link.
- In `MuteControl`, compute `const afk = useApp((s) => isAFKChannel(s.server?.server.afk_channel_id ?? undefined, v.channelId));`, and change the `canSpeak` expression to `... && !afk`.
- Where the disabled tooltip text is chosen, add the AFK reason, "Nobody can talk in the AFK channel", in the same style as the existing server-mute reason.

- [ ] **Step 7: Typecheck, test and stage**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run src/voice` (from clients/web)
Expected: PASS.

```bash
git add clients/web/src/voice/afk.ts clients/web/src/voice/afk.test.ts clients/web/src/voice/voice.ts clients/core/src/client.ts clients/web/src/app/server-settings/VoiceAFK.tsx clients/web/src/app/server-settings/ServerSettings.tsx clients/web/src/app/voice/VoicePanel.tsx
```

---

### Task 3: A 30-second stats history

**Files:**
- Modify: `clients/web/src/voice/stats.ts` (export `LIMITS`, add `metricRating`, and `watchQuality` keeps 30 samples at 1 s)
- Modify: `clients/web/src/voice/stats.test.ts`
- Modify: `clients/web/src/voice/voice.ts` (`VoiceView.history: Sample[]`)

**Interfaces:**
- Produces:
  - `export const HISTORY = 30`;
  - `export const LIMITS` (now exported);
  - `export function metricRating(key: keyof Sample, v: number): "good" | "ok" | "poor"`;
  - `watchQuality(room, (q: Quality, history: Sample[]) => void, everyMs = 1000)`;
  - `VoiceView.history: Sample[]`, newest last, at most 30 entries.

- [ ] **Step 1: Write the failing tests**

Add to `stats.test.ts`:

```ts
import { HISTORY, metricRating, pushHistory } from "./stats";

describe("metricRating", () => {
  it("uses the LIMITS thresholds", () => {
    expect(metricRating("rttMs", 99)).toBe("good");
    expect(metricRating("rttMs", 100)).toBe("ok");
    expect(metricRating("rttMs", 250)).toBe("poor");
    expect(metricRating("lossPct", 0.5)).toBe("good");
    expect(metricRating("jitterMs", 49)).toBe("ok");
  });
});

describe("pushHistory", () => {
  it("keeps the last 30 samples, newest last", () => {
    let h: { rttMs?: number }[] = [];
    for (let i = 0; i < 35; i++) h = pushHistory(h, { rttMs: i });
    expect(h).toHaveLength(HISTORY);
    expect(h[0]!.rttMs).toBe(5);
    expect(h.at(-1)!.rttMs).toBe(34);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/voice/stats.test.ts`
Expected: FAIL, because these are not exported yet.

- [ ] **Step 3: Implement**

In `stats.ts`:
- Change `const LIMITS` to `export const LIMITS`.
- Add:

```ts
export const HISTORY = 30; // samples kept for the connection panel (one per second)

/** One metric against LIMITS. */
export function metricRating(key: keyof Sample, v: number): "good" | "ok" | "poor" {
  const [good, ok] = LIMITS[key];
  return v < good ? "good" : v < ok ? "ok" : "poor";
}

/** `history` plus `s`, cut to the last HISTORY samples (a new array: it goes into the store). */
export const pushHistory = <T,>(history: T[], s: T): T[] => [...history, s].slice(-HISTORY);
```

- Make `rate()` use `metricRating` internally if that keeps it simpler. Its behaviour must not change.
- In `watchQuality`:
  - the signature becomes `(room, onQuality: (q: Quality, history: Sample[]) => void, everyMs = 1000)`;
  - keep `let all: Sample[] = []`; on each poll, `all = pushHistory(all, sample)`;
  - rate from `all.slice(-3)`;
  - call `onQuality(rate(all.slice(-3)), all)`.

In `voice.ts`:
- Add `history: Sample[]` to `VoiceView`, and `history: []` to `idle`. Import the `Sample` type.
- The `watchQuality` callback becomes `(quality, history) => { if (this.room === room) this.set({ quality, history }); }`.

- [ ] **Step 4: Run them and watch them pass, then stage**

Run: `pnpm exec vitest run src/voice && pnpm exec tsc -p tsconfig.json`
Expected: PASS.

```bash
git add clients/web/src/voice/stats.ts clients/web/src/voice/stats.test.ts clients/web/src/voice/voice.ts
```

---

### Task 4: Peers share their ping (server)

**Files:**
- Create: `server/internal/voice/ping.go`
- Modify: `server/internal/voice/voice.go` (the `pingLimit` field in `NewService`)
- Modify: `server/internal/voice/handlers.go` (register the route)
- Test: `server/internal/voice/ping_test.go`

**Interfaces:**
- Produces:
  - `POST /api/voice/ping`, with body `{"rtt_ms": int}`, returning 204;
  - the event `VOICE_PING` with `VoicePing{ChannelID id.ID "channel_id"; UserID id.ID "user_id"; RttMs int "rtt_ms"}`, sent to everyone else in the caller's call.

- [ ] **Step 1: Write the failing test**

`server/internal/voice/ping_test.go`:

```go
package voice_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/voice"
)

func TestPing(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	carol := env.Register("carol")
	carol.Join(alice.Invite())

	enter(t, env, cfg, alice, c.voiceID)
	enter(t, env, cfg, bob, c.voiceID)
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()

	alice.Do(http.MethodPost, "/api/voice/ping", map[string]any{"rtt_ms": 42}, http.StatusNoContent, nil)
	var ev voice.VoicePing
	bobWS.ExpectDispatch("VOICE_PING", &ev)
	require.Equal(t, voice.VoicePing{ChannelID: c.voiceID, UserID: alice.User.ID, RttMs: 42}, ev)
	carolWS.ExpectNoDispatch("VOICE_PING", 300*time.Millisecond)

	alice.Fail(http.MethodPost, "/api/voice/ping", map[string]any{"rtt_ms": 43}, http.StatusTooManyRequests, "RATE_LIMITED")
	carol.Fail(http.MethodPost, "/api/voice/ping", map[string]any{"rtt_ms": 10}, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/voice/ping", map[string]any{"rtt_ms": -1}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPost, "/api/voice/ping", map[string]any{"rtt_ms": 10001}, http.StatusBadRequest, "VALIDATION_FAILED")
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/voice -run TestPing`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

`ping.go`:

```go
package voice

import (
	"context"
	"net/http"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// VoicePing is someone's round trip to the voice server, for the others in their call.
type VoicePing struct {
	ChannelID id.ID `json:"channel_id"`
	UserID    id.ID `json:"user_id"`
	RttMs     int   `json:"rtt_ms"`
}

type PingRequest struct {
	RttMs int `json:"rtt_ms" minimum:"0" maximum:"10000"`
}

// Ping tells the others in the caller's call how long the caller's round trip to the voice server is.
// Clients send it every few seconds; it is not stored.
func (s *Service) Ping(ctx context.Context, userID id.ID, rttMs int) error {
	if !s.pingLimit.Allow(userID.String()) {
		return httpx.RateLimited()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.users[userID]
	if p == nil {
		return httpx.E(http.StatusNotFound, "NOT_FOUND", "you are not in a voice call")
	}
	var others []id.ID
	for uid, q := range s.users {
		if q.channelID == p.channelID && uid != userID {
			others = append(others, uid)
		}
	}
	if len(others) > 0 {
		s.bus.Publish(events.Event{Type: "VOICE_PING", Data: VoicePing{ChannelID: p.channelID, UserID: userID, RttMs: rttMs},
			Scope: events.Scope{UserIDs: others}})
	}
	return nil
}
```

The rate limit runs before the lookup, so a user outside a call also gets their limiter touched. That is fine. The order matters for the test: carol is never in a call, so she gets 404 on her first call.

- In `voice.go`, add the field `pingLimit *ratelimit.Limiter // one ping per 2 s per user`. In `NewService`, next to `soundLimit`, add `pingLimit: ratelimit.New(30, 1)`.
- In `handlers.go`, add:

```go
	huma.Register(api, op("voice-ping", http.MethodPost, "/api/voice/ping", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body PingRequest }) (*struct{}, error) {
			return nil, s.Ping(ctx, me(ctx).ID, in.Body.RttMs)
		})
```

- [ ] **Step 4: Run it and watch it pass, regenerate the types, and stage**

Run: `GOTOOLCHAIN=local go -C server test ./internal/voice`, then from clients/core run `pnpm run gen`.
Expected: PASS.

```bash
git add server/internal/voice clients/core/openapi.json clients/core/src/schema.d.ts
```

---

### Task 5: The connection panel (signal bars and tabs) and peer pings in the UI

**Files:**
- Create: `clients/web/src/voice/pings.ts` (a store of peer pings, the sender loop, and helpers)
- Test: `clients/web/src/voice/pings.test.ts`
- Modify: `clients/core/src/types.ts` (event map `VOICE_PING: Schemas["VoicePing"]`)
- Modify: `clients/core/src/client.ts` (`sendPing(rttMs)`)
- Modify: `clients/web/src/voice/voice.ts` (start and stop the ping sender with the room)
- Create: `clients/web/src/app/voice/SignalBars.tsx`
- Modify: `clients/web/src/app/voice/ConnectionQuality.tsx` (the panel, concept C)
- Modify: `clients/web/src/app/voice/VoiceMembers.tsx` (the ping in member rows while I'm in that call)

**Interfaces:**
- Consumes:
  - from Task 3: `VoiceView.history`, `metricRating`, `HISTORY`;
  - from Task 4: `VOICE_PING` and `POST /api/voice/ping`.
- Produces:
  - `pingStore` (zustand vanilla, `{ byUser: Record<string, { rttMs: number; at: number }> }`) and `usePeerPing(userId): number | undefined`, which returns undefined when the ping is older than 15 s;
  - `estimateToYou(peer?: number, mine?: number): number | undefined`;
  - `startPingSender(getRtt: () => number | undefined, send: (ms: number) => Promise<void>, everyMs = 5000): () => void`;
  - `SignalBars({ values, metric })`.

- [ ] **Step 1: Write the failing tests**

`clients/web/src/voice/pings.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPing, estimateToYou, freshPing, startPingSender } from "./pings";

describe("pings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("estimates the round trip to a peer as both pings", () => {
    expect(estimateToYou(40, 45)).toBe(85);
    expect(estimateToYou(undefined, 45)).toBeUndefined();
  });
  it("forgets pings older than 15 s", () => {
    const byUser = applyPing({}, { user_id: "1", rtt_ms: 42 }, 1000);
    expect(freshPing(byUser, "1", 1000 + 14_000)).toBe(42);
    expect(freshPing(byUser, "1", 1000 + 16_000)).toBeUndefined();
  });
  it("sends my rounded ping every 5 s while known, and stops", () => {
    const send = vi.fn(async () => {});
    let rtt: number | undefined;
    const stop = startPingSender(() => rtt, send);
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled(); // not measured yet
    rtt = 41.6;
    vi.advanceTimersByTime(5000);
    expect(send).toHaveBeenCalledWith(42);
    stop();
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/voice/pings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `pings.ts`**

```ts
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

type ByUser = Record<string, { rttMs: number; at: number }>;
const FRESH_MS = 15_000;

/** The others' pings in my call (VOICE_PING), by user ID. */
export const pingStore = createStore<{ byUser: ByUser }>(() => ({ byUser: {} }));

export const applyPing = (byUser: ByUser, e: { user_id: string; rtt_ms: number }, now: number): ByUser =>
  ({ ...byUser, [e.user_id]: { rttMs: e.rtt_ms, at: now } });

export const freshPing = (byUser: ByUser, userId: string, now: number) => {
  const p = byUser[userId];
  return p && now - p.at <= FRESH_MS ? p.rttMs : undefined;
};

/** Their round trip to me through the voice server, roughly: theirs plus mine (the server's forwarding not counted). */
export const estimateToYou = (peer?: number, mine?: number) => (peer === undefined || mine === undefined ? undefined : Math.round(peer + mine));

export function usePeerPing(userId: string): number | undefined {
  return useStore(pingStore, (s) => freshPing(s.byUser, userId, Date.now()));
}

/** Shares my ping with the call every `everyMs` once it is measured. Returns a function that stops. */
export function startPingSender(getRtt: () => number | undefined, send: (ms: number) => Promise<void>, everyMs = 5000): () => void {
  const timer = setInterval(() => {
    const rtt = getRtt();
    if (rtt !== undefined) void send(Math.round(rtt)).catch(() => undefined);
  }, everyMs);
  return () => clearInterval(timer);
}
```

The `freshPing` check runs at render time, so a stale ping disappears at the next re-render. The panel re-renders every second through `history`, which is enough.

Wiring:
- In `voice.ts`, after `watchQuality` starts, add `this.stopPing = startPingSender(() => this.store.getState().quality.rttMs, (ms) => client.sendPing(ms));`, and in `disconnect`, `this.stopPing?.()`.
- Also subscribe once in the `Voice` constructor: `client.onEvent((type, data) => { if (type === "VOICE_PING") pingStore.setState((s) => ({ byUser: applyPing(s.byUser, data as { user_id: string; rtt_ms: number }, Date.now()) })); });`, and clear `pingStore` on disconnect.
- In `client.ts`, add `async sendPing(rttMs: number) { await unwrap(this.api.POST("/api/voice/ping", { body: { rtt_ms: rttMs } })); }`.
- In `types.ts`, add `VOICE_PING: Schemas["VoicePing"];` to the event map.

- [ ] **Step 4: The `SignalBars` component and the panel (concept C)**

`clients/web/src/app/voice/SignalBars.tsx`:

```tsx
import { cn } from "@/lib/utils";
import { HISTORY, metricRating, type Sample } from "../../voice/stats";

const TONE = { good: "bg-online", ok: "bg-idle", poor: "bg-destructive" } as const;
const SCALE: Record<keyof Sample, number> = { rttMs: 300, lossPct: 10, jitterMs: 60 };

/** One bar per second for the last 30 s, coloured by the metric's thresholds. Decorative: the figure beside it is the value. */
export function SignalBars({ values, metric, className }: { values: (number | undefined)[]; metric: keyof Sample; className?: string }) {
  const padded = [...Array(Math.max(0, HISTORY - values.length)).fill(undefined), ...values.slice(-HISTORY)];
  return (
    <div aria-hidden className={cn("flex h-7 items-end gap-px", className)}>
      {padded.map((v, i) => (
        <i key={i} className={cn("min-w-0 flex-1 rounded-[1px]", v === undefined ? "h-1 bg-muted" : TONE[metricRating(metric, v)])}
          style={v === undefined ? undefined : { height: `${Math.max(12, Math.min(1, v / SCALE[metric]) * 100)}%` }} />
      ))}
    </div>
  );
}
```

`ConnectionQuality.tsx`:
- Keep the trigger button and its `aria-label` exactly as they are.
- Replace both the tooltip and the popover content with one `Popover`, used on desktop as well. The panel needs interaction (tabs), so a tooltip is not enough.
- Its content, inside `PopoverContent className="w-80 p-3"`:
  - **Tabs** (shadcn `Tabs`; add it with `pnpm dlx shadcn@latest add tabs` if it is missing): "You" and "Others · n".
  - **"You" tab:**
    - The verdict in large type, using `LOOK[q.rating].word` capitalised and coloured, followed by `"{ms} ms to server"`.
    - Three rows: "Ping", "Jitter" and "Packet loss". Each shows its current value, then `<SignalBars values={history.map((s) => s.rttMs)} metric="rttMs" />` (and the same for the other two metrics).
    - A muted footnote: "Last 30 seconds · connection to the voice server".
  - **"Others" tab:** one row per other person in my call, taken from `useApp((s) => Object.values(s.voice).filter((v) => v.channel_id === channelId && v.user_id !== me))`.
    - Each row has an avatar (`UserAvatar size="sm"`) and the name.
    - Right-aligned, it shows `"{peer} ms · ≈{estimateToYou(peer, mine)} to you"`, or "measuring…" when the ping is undefined.
  - When "Others" is empty, show "Nobody else is here yet".

In `VoiceMembers.tsx`, only while I'm connected to this channel, add a muted `text-xs tabular-nums` span `"{ms} ms"` after the name in each row except mine. Read it from `usePeerPing(v.user_id)`, and give the span `title` "≈{estimate} ms to you". Extract a tiny `PeerPing` component so the hook runs per row.

- [ ] **Step 5: Typecheck, test and stage**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run` (from clients/web), and `corepack pnpm -r typecheck`.
Expected: PASS.

```bash
git add clients/web/src/voice/pings.ts clients/web/src/voice/pings.test.ts clients/web/src/voice/voice.ts clients/core/src/types.ts clients/core/src/client.ts clients/web/src/app/voice/SignalBars.tsx clients/web/src/app/voice/ConnectionQuality.tsx clients/web/src/app/voice/VoiceMembers.tsx clients/web/src/components/ui
```

---

### Task 6: The team draw (server)

**Files:**
- Create: `server/internal/voice/teams.go`
- Test: `server/internal/voice/teams_test.go`
- Modify: `server/internal/voice/handlers.go`

**Interfaces:**
- Produces:
  - `POST /api/voice/{id}/teams`, with body `{"teams": int 2-8, "per_team"?: int 1-50, "user_ids": [ids] 2-100}`, returning 204;
  - the event `VOICE_TEAMS`, carrying `TeamsDraw{ChannelID, By id.ID; Teams [][]id.ID; Bench []id.ID; PerTeam int; At time.Time}` (exact struct in Step 3).
  - `func Deal(ids []id.ID, teams, perTeam int, shuffle func([]id.ID)) (out [][]id.ID, bench []id.ID)`, exported for the test.

- [ ] **Step 1: Write the failing tests**

`server/internal/voice/teams_test.go`:

```go
package voice_test

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/voice"
)

func ids(n int) []id.ID {
	out := make([]id.ID, n)
	for i := range out {
		out[i] = id.ID(i + 1)
	}
	return out
}

func TestDeal(t *testing.T) {
	noShuffle := func([]id.ID) {}
	teams, bench := voice.Deal(ids(7), 2, 0, noShuffle)
	require.Equal(t, [][]id.ID{{1, 3, 5, 7}, {2, 4, 6}}, teams, "even split, round robin")
	require.Empty(t, bench)

	teams, bench = voice.Deal(ids(7), 2, 3, noShuffle)
	require.Equal(t, [][]id.ID{{1, 3, 5}, {2, 4, 6}}, teams)
	require.Equal(t, []id.ID{7}, bench)

	teams, _ = voice.Deal(ids(10), 3, 0, voice.CryptoShuffle)
	all := slices.Concat(teams...)
	slices.Sort(all)
	require.Equal(t, ids(10), all, "everyone exactly once")
}

func TestDrawTeams(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	carol := env.Register("carol")
	carol.Join(alice.Invite())
	enter(t, env, cfg, alice, c.voiceID)
	enter(t, env, cfg, bob, c.voiceID)
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()
	path := "/api/voice/" + c.voiceID.String() + "/teams"

	alice.Do(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusNoContent, nil)
	var ev voice.TeamsDraw
	bobWS.ExpectDispatch("VOICE_TEAMS", &ev)
	require.Equal(t, c.voiceID, ev.ChannelID)
	require.Equal(t, alice.User.ID, ev.By)
	require.Len(t, ev.Teams, 2)
	require.ElementsMatch(t, []id.ID{alice.User.ID, bob.User.ID}, slices.Concat(ev.Teams...))
	carolWS.ExpectNoDispatch("VOICE_TEAMS", 300*time.Millisecond)

	alice.Fail(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, carol.User.ID}}, http.StatusBadRequest, "NOT_IN_CALL")
	carol.Fail(http.MethodPost, path, map[string]any{"teams": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusForbidden, "NOT_IN_CALL")
	alice.Fail(http.MethodPost, path, map[string]any{"teams": 2, "per_team": 2, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusBadRequest, "TOO_FEW_PLAYERS")
	alice.Fail(http.MethodPost, path, map[string]any{"teams": 9, "user_ids": []id.ID{alice.User.ID, bob.User.ID}}, http.StatusBadRequest, "VALIDATION_FAILED")
}
```

- [ ] **Step 2: Run them and watch them fail**

Run: `GOTOOLCHAIN=local go -C server test ./internal/voice -run 'Deal|DrawTeams'`
Expected: FAIL to compile.

- [ ] **Step 3: Implement**

`teams.go`:

```go
package voice

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"net/http"
	"slices"
	"time"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type TeamsRequest struct {
	Teams   int     `json:"teams" minimum:"2" maximum:"8"`
	PerTeam int     `json:"per_team,omitempty" minimum:"0" maximum:"50" doc:"Players per team; 0 or absent splits everyone evenly"`
	UserIDs []id.ID `json:"user_ids" minItems:"2" maxItems:"100" doc:"Who is in the draw; all must be in the call"`
}

// TeamsDraw is a random split of a call into teams, sent to everyone in the call. It is not stored.
type TeamsDraw struct {
	ChannelID id.ID     `json:"channel_id"`
	By        id.ID     `json:"by"`
	Teams     [][]id.ID `json:"teams"`
	Bench     []id.ID   `json:"bench"`
	PerTeam   int       `json:"per_team" doc:"0: an even split"`
	At        time.Time `json:"at"`
}

// CryptoShuffle shuffles in place with crypto/rand (Fisher–Yates).
func CryptoShuffle(xs []id.ID) {
	var b [8]byte
	for i := len(xs) - 1; i > 0; i-- {
		_, _ = rand.Read(b[:])
		j := int(binary.LittleEndian.Uint64(b[:]) % uint64(i+1))
		xs[i], xs[j] = xs[j], xs[i]
	}
}

// Deal shuffles ids and deals them round robin into `teams` teams of at most perTeam (0: no limit); the rest sit out.
func Deal(ids []id.ID, teams, perTeam int, shuffle func([]id.ID)) ([][]id.ID, []id.ID) {
	pool := slices.Clone(ids)
	shuffle(pool)
	n := len(pool)
	if perTeam > 0 && teams*perTeam < n {
		n = teams * perTeam
	}
	out := make([][]id.ID, teams)
	for i := range out {
		out[i] = []id.ID{}
	}
	for i, u := range pool[:n] {
		out[i%teams] = append(out[i%teams], u)
	}
	return out, append([]id.ID{}, pool[n:]...)
}

// DrawTeams splits the chosen people in the caller's call into teams and tells everyone in the call.
func (s *Service) DrawTeams(ctx context.Context, callerID, channelID id.ID, req TeamsRequest) error {
	pool := slices.Compact(slices.Sorted(slices.Values(req.UserIDs)))
	if req.PerTeam > 0 && req.Teams*req.PerTeam > len(pool) {
		return httpx.BadRequest("TOO_FEW_PLAYERS", "not enough people for that many full teams")
	}
	if len(pool) < req.Teams {
		return httpx.BadRequest("TOO_FEW_PLAYERS", "fewer people than teams")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.users[callerID]; p == nil || p.channelID != channelID {
		return httpx.E(http.StatusForbidden, "NOT_IN_CALL", "you are not in this call")
	}
	var listeners []id.ID
	for uid, q := range s.users {
		if q.channelID == channelID {
			listeners = append(listeners, uid)
		}
	}
	for _, u := range pool {
		if !slices.Contains(listeners, u) {
			return httpx.BadRequest("NOT_IN_CALL", "someone in the draw is not in the call any more")
		}
	}
	teams, bench := Deal(pool, req.Teams, req.PerTeam, CryptoShuffle)
	s.bus.Publish(events.Event{Type: "VOICE_TEAMS", Data: TeamsDraw{ChannelID: channelID, By: callerID, Teams: teams, Bench: bench,
		PerTeam: req.PerTeam, At: time.Now()}, Scope: events.Scope{UserIDs: listeners}})
	return nil
}
```

`handlers.go`:

```go
	huma.Register(api, op("draw-teams", http.MethodPost, "/api/voice/{id}/teams", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body TeamsRequest
		}) (*struct{}, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			return nil, s.DrawTeams(ctx, me(ctx).ID, chID, in.Body)
		})
```

There is no extra rate limit. Draws are cheap, and only people in the call can make one.

- [ ] **Step 4: Run them and watch them pass, regenerate the types, and stage**

Run: `GOTOOLCHAIN=local go -C server test ./internal/voice`, then from clients/core run `pnpm run gen`.
Expected: PASS.

```bash
git add server/internal/voice clients/core/openapi.json clients/core/src/schema.d.ts
```

---

### Task 7: Team randomizer UI (dialog, side panel, tile dots)

**Files:**
- Modify: `clients/web/src/styles.css`: add `--team-1` to `--team-8` in `:root` and `--color-team-1..8: var(--team-1..8)` in `@theme inline`. Values: `#5dade2 #f5b041 #af7ac5 #58d68d #ec7063 #48c9b0 #f4d03f #a6acaf`.
- Create: `clients/web/src/voice/teams.ts` (the store and pure helpers)
- Test: `clients/web/src/voice/teams.test.ts`
- Modify: `clients/core/src/types.ts` (`VOICE_TEAMS: Schemas["TeamsDraw"]`) and `clients/core/src/client.ts` (`drawTeams(channelId, body)`)
- Create: `clients/web/src/app/voice/TeamsDialog.tsx`
- Create: `clients/web/src/app/voice/TeamsPanel.tsx`
- Modify: `clients/web/src/app/voice/CallControls.tsx` (a "Teams" button on desktop and an ActionSheet item on phone)
- Modify: `clients/web/src/app/voice/VoiceChannelView.tsx` (side `"teams"`; open it when a draw arrives)
- Modify: `clients/web/src/app/voice/Tile.tsx` (a team dot in the name plate)

**Interfaces:**
- Consumes: `VOICE_TEAMS`, `TeamsDraw` and `POST /api/voice/{id}/teams` (Task 6).
- Produces:
  - `teamsStore` (zustand vanilla, `{ draw?: TeamsDraw }`) and `useTeams(channelId): TeamsDraw | undefined`;
  - `teamOf(draw, userId): number` (−1 if none);
  - `teamColor(i): string`, which returns `var(--team-${(i % 8) + 1})`;
  - `TeamsDialog({ channelId, open, onOpenChange })`;
  - `TeamsPanel({ channelId, onReroll, onClose })`.

- [ ] **Step 1: Write the failing tests**

`clients/web/src/voice/teams.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { teamColor, teamOf, validDraw } from "./teams";

const draw = { channel_id: "5", by: "1", teams: [["1", "3"], ["2"]], bench: ["4"], per_team: 0, at: "" };

describe("teams", () => {
  it("finds a person's team", () => {
    expect(teamOf(draw, "3")).toBe(0);
    expect(teamOf(draw, "2")).toBe(1);
    expect(teamOf(draw, "4")).toBe(-1); // bench
  });
  it("colours teams with tokens, cycling after 8", () => {
    expect(teamColor(0)).toBe("var(--team-1)");
    expect(teamColor(8)).toBe("var(--team-1)");
  });
  it("checks a setup before sending", () => {
    expect(validDraw({ teams: 2, perTeam: 0, picked: 3 })).toBeNull();
    expect(validDraw({ teams: 3, perTeam: 0, picked: 2 })).toBe("Pick at least as many people as teams.");
    expect(validDraw({ teams: 2, perTeam: 3, picked: 5 })).toBe("Not enough people for 2 full teams of 3.");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm exec vitest run src/voice/teams.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `teams.ts`**

```ts
import type { Schemas } from "@datrope/core";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type TeamsDraw = Schemas["TeamsDraw"];

/** The last team draw in my call (VOICE_TEAMS). */
export const teamsStore = createStore<{ draw?: TeamsDraw }>(() => ({}));

export const useTeams = (channelId: string) => useStore(teamsStore, (s) => (s.draw?.channel_id === channelId ? s.draw : undefined));

export const teamOf = (draw: Pick<TeamsDraw, "teams"> | undefined, userId: string) =>
  draw ? draw.teams.findIndex((t) => t.includes(userId)) : -1;

export const teamColor = (i: number) => `var(--team-${(i % 8) + 1})`;

/** Why a setup can't be drawn, or null. */
export function validDraw({ teams, perTeam, picked }: { teams: number; perTeam: number; picked: number }): string | null {
  if (picked < teams) return "Pick at least as many people as teams.";
  if (perTeam > 0 && teams * perTeam > picked) return `Not enough people for ${teams} full teams of ${perTeam}.`;
  return null;
}
```

If `Schemas` is not exported from `@datrope/core`, use the same import other web files use for schema types. Search with `grep -rn "Schemas\[" clients/web/src | head -3`.

Subscribe once, in the `Voice` constructor or a small `TeamsListener` mounted next to `SoundboardListener`: `client.onEvent((t, d) => { if (t === "VOICE_TEAMS") teamsStore.setState({ draw: d as TeamsDraw }); })`. Clear it when I leave the call.

In `client.ts`:

```ts
  /** Draws random teams from people in the call and shows them to everyone in it. */
  async drawTeams(channelId: string, body: { teams: number; per_team?: number; user_ids: string[] }) {
    await unwrap(this.api.POST("/api/voice/{id}/teams", { params: { path: { id: channelId } }, body }));
  }
```

In `types.ts`, add `VOICE_TEAMS: Schemas["TeamsDraw"];` to the event map.

- [ ] **Step 4: The dialog (the shared design from the mockup)**

`TeamsDialog.tsx` is a shadcn `Dialog` titled "Draw teams". Its fields:
- **Number of teams:** a −/+ stepper, 2–8, default 2. The buttons have `aria-label` "Fewer teams" and "More teams"; the value is in an `output`.
- **Players per team:** a −/+ stepper, where 0 shows "Even split", up to 50. The buttons have `aria-label` "Fewer players per team" and "More players per team". A muted note says "Leftovers sit on the bench."
- **Who's in:** a `Checkbox` per person currently in the call (`useApp((s) => Object.values(s.voice).filter((v) => v.channel_id === channelId))`, with names from `userName`). All are checked by default, with "All" and "None" link buttons. A count reads "n of m in the call".
- **Buttons:** "Cancel", and "Draw" as the submit button, disabled while `validDraw(...)` returns a message. Show that message as muted text.
- **Submit:** `useSubmit().run(() => client.drawTeams(channelId, { teams, per_team: perTeam || undefined, user_ids }))`. Show errors with `ErrorText`, such as the server's "someone in the draw is not in the call any more". Close on success.

The dialog keeps its last settings in `useState` lifted to `TeamsPanel`'s parent (see Step 5). Re-roll can then send the same settings again without reopening.

- [ ] **Step 5: The side panel, the button and the tile dot (concept C)**

`TeamsPanel.tsx`:
- Rendered inside the existing `SidePanel`, `title="Teams"`, with a `Users` icon.
- Text: "drawn by {name} · {relative time}".
- A card per team (`rounded-lg border bg-card p-2.5`). The heading is "Team n", in the team colour, with an 8 px dot before it (`style={{ background: teamColor(i), color: teamColor(i) }}`; no thick border). Under it, rows of avatar plus name, with "(you)" for me.
- Then "Bench: a, b".
- A primary "Re-roll" button that calls `onReroll`.

In `VoiceChannelView.tsx`:
- Extend the `side` union with `"teams"`.
- Keep `const [teamSettings, setTeamSettings] = useState<{ teams: number; perTeam: number; userIds: string[] } | null>(null)`.
- Panel branch: `side === "teams" ? <SidePanel title="Teams" icon={<Users />} subtitle={ch.name} onClose={() => setSide(null)}><TeamsPanel channelId={channelId} onReroll={...} /></SidePanel>`.
  - `onReroll` sends `teamSettings` again with `client.drawTeams`.
  - When `teamSettings` is null (someone else drew), Re-roll uses that draw's `per_team`, its team count, and everyone currently in the call.
- Add `useEffect(() => teamsStore.subscribe((s, p) => { if (s.draw && s.draw !== p.draw && s.draw.channel_id === channelId && !mobile) setSide("teams"); }), [channelId, mobile]);` so a new draw opens the panel for everyone.
- On mobile, pass the panel through `CallScreen`'s existing `panel` prop, with `side="teams"`, the same way music works.

In `CallControls.tsx`:
- Desktop: after `<SoundboardButton …/>`, add a `Tooltip`-wrapped `Button` with `variant="ghost"`, `className={round}` and `aria-label="Draw teams"`, containing `<Users />`. It opens `TeamsDialog`. `CallControls` needs the `channelId` from `useVoice((v) => v.channelId)`.
- Phone: add an `ActionSheetItem` with `icon={<Users />}` and the label "Draw teams" to the "More call controls" sheet.
- The dialog's `onDrawn` callback stores the settings through a small `voice/teams.ts` `lastSettings` field in `teamsStore`. Add `settings?: {...}` to the store shape, so `VoiceChannelView` can read it for Re-roll and `CallControls` doesn't need prop drilling.

In `Tile.tsx`, in the name plate, before the name, add:

```tsx
{teamIdx >= 0 && <span aria-label={`Team ${teamIdx + 1}`} role="img" className="size-2 flex-none rounded-full" style={{ background: teamColor(teamIdx) }} />}
```

where `const draw = useTeams(state?.channel_id ?? ""); const teamIdx = screen ? -1 : teamOf(draw, userId);`.

- [ ] **Step 6: Typecheck, test and stage**

Run: `pnpm exec tsc -p tsconfig.json && pnpm exec vitest run && pnpm exec eslint src` (from clients/web), and `corepack pnpm -r typecheck`.
Expected: PASS, with no new lint errors.

```bash
git add clients/web/src/styles.css clients/web/src/voice/teams.ts clients/web/src/voice/teams.test.ts clients/core/src/types.ts clients/core/src/client.ts clients/web/src/app/voice/TeamsDialog.tsx clients/web/src/app/voice/TeamsPanel.tsx clients/web/src/app/voice/CallControls.tsx clients/web/src/app/voice/VoiceChannelView.tsx clients/web/src/app/voice/Tile.tsx
```

---

## Final verification (after all tasks)

- `corepack pnpm -r typecheck`
- `corepack pnpm --filter @datrope/web test`
- `GOTOOLCHAIN=local go -C server test ./...`
- `corepack pnpm lint`
- Browser checks, once someone can sign in to the dev server:
  - set an AFK channel at 5 min, stay silent, and get moved, with the mic disabled there;
  - open the connection panel and see the bars fill over 30 s, then the Others tab with a second browser in the call;
  - draw teams from one browser and see the panel open in both, with the tile dots.

Report each result as it came out. Do not commit.
