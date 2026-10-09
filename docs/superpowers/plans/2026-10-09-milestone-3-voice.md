# Milestone 3: Voice, Camera and Screen Share — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members can join voice channels (and calls in DMs), talk, turn on their camera and share their screen through a self-hosted LiveKit server; the server issues LiveKit tokens whose grants follow the member's permissions, tracks who is in voice from LiveKit webhooks, broadcasts `VOICE_STATE_UPDATE`, and removes, mutes or re-grants participants when permissions change or a moderator acts.

**Architecture:** A new `voice` package owns voice state (in memory, rebuilt from LiveKit at startup and every 30 s), the join/moderation API, and the LiveKit webhook. It talks to LiveKit's RoomService over Twirp with short-lived admin tokens (`github.com/livekit/protocol` only — the LiveKit Go SDK, which pulls in WebRTC, is a test-only dependency used to connect fake participants). Permission changes anywhere in the app reach voice through the event bus and trigger a reconcile. The web client uses `livekit-client` directly, behind a small zustand-backed engine; the UI is built from shadcn/ui components. Compose gains a `livekit` service; Caddy proxies `/livekit` to it.

**Tech Stack:** Go 1.25 · `github.com/livekit/protocol` (pinned pseudo-version, see Task 1) · `github.com/twitchtv/twirp` · test-only `github.com/livekit/server-sdk-go/v2` v2.16.3 · LiveKit server `livekit/livekit-server:v1.13.7` · `livekit-client` 2.22.3 · React 18 + Tailwind v4 + shadcn/ui (new-york) · Playwright with Chromium fake media devices.

**Spec:** `docs/superpowers/specs/2026-10-08-datrope-architecture-design.md` — §2.2 (Voice and media), §4 (permissions, DM permissions), §5.2 (READY carries voice states, `VOICE_STATE_UPDATE`), §5.3 (Voice flow), §5.4 (Screen share), §9 (`VOICE_UNAVAILABLE`), §10 (voice integration tests, Playwright "join voice"), §12 item 3. Milestones 1–2 (`docs/superpowers/plans/2026-10-08-milestone-1-foundation.md`, `...-milestone-2-files.md`) describe the code this builds on; the web client was since moved to shadcn/ui (`docs/superpowers/plans/2026-10-09-shadcn-design-system.md`).

## Global Constraints

- **Never commit.** (CLAUDE.md §5.) Each task ends with a *Checkpoint*: the controller stages the task with `git add` after review; nobody commits.
- Voice, camera and screen share run through **LiveKit**. **Media never passes through datrope-server.** The server checks permissions, issues LiveKit tokens, and reacts to LiveKit webhooks.
- Join: `POST /api/voice/{channelId}/join`. The server checks **`CONNECT_VOICE`**. Token grants match the user's rights: publishing audio needs **`SPEAK`**; publishing camera or screen needs **`STREAM`**.
- LiveKit webhooks (participant joined/left, track published) update voice state; the server broadcasts **`VOICE_STATE_UPDATE`**. `READY` includes current voice states.
- When a user is kicked or banned, loses a permission, or is moderated (**`MUTE_MEMBERS`**, **`MOVE_MEMBERS`**), the server calls the LiveKit API to remove, mute or update that participant.
- **A user can be in one voice channel at a time. Joining another leaves the first.**
- A screen share is one more video track (plus optional audio) in the channel's room, **simulcast**; **viewers subscribe only when they click "watch"**.
- DMs have fixed permissions: every participant can connect, speak and stream.
- If LiveKit is unreachable, joining voice fails with **`VOICE_UNAVAILABLE`** (HTTP 503). Text chat keeps working.
- Voice integration tests run against a **real LiveKit container**: token grants are enforced, and kicking removes the participant. Playwright covers "join voice" on the real compose stack.
- Web UI: **use shadcn/ui components before building your own.** Check `clients/web/src/components/ui/` first; add missing ones with the shadcn CLI from `clients/web` (`pnpm dlx shadcn@latest add <name>`); style only with the existing tokens (no hex colours outside `src/styles.css`, dark only).
- Project conventions (still binding):
  - Go module `github.com/datrope/datrope/server`; `go.mod` stays `go 1.25.6`; run Go with `GOTOOLCHAIN=local`. New Go dependencies must support Go 1.25 (LiveKit's current releases need Go 1.26 — use exactly the versions in Task 1).
  - Huma v2.39.1 does **not** fill path params from unexported embedded structs: declare path fields directly on input structs.
  - Go nil slices appear in generated TS types as `T[] | null`; the server initialises list fields non-nil, the client guards with `?? []`.
  - Packages never query another package's tables; they call each other through interfaces declared by the consumer.
  - Every Go test that needs a database uses `pgtest`/`apptest` (real Postgres via testcontainers). Tests that need LiveKit use `lktest` (Task 1). Docker must be running. On Windows run Go tests from PowerShell.
  - The web client has no unit-test runner; per-task web verification is `pnpm --filter @datrope/web build` and `pnpm lint`; behaviour is covered by Playwright in Task 8.
- Out of scope: recording/egress, TURN over TLS (TURN/UDP only), noise suppression settings, per-user volume, push-to-talk (desktop milestone), ringing/notifications for DM calls, stage channels, persisting server mute across sessions, role hierarchy for voice moderation (any holder of `MUTE_MEMBERS`/`MOVE_MEMBERS` can act on anyone in the channel).

## Decisions this plan makes (confirm with the user if any matter)

1. **Voice state lives in server memory**, not Postgres. It is rebuilt from LiveKit (`ListRooms` + `ListParticipants`) at startup and every 30 s, so a restart or a missed webhook heals itself within 30 s.
2. LiveKit room name = channel ID; participant identity = user ID; participant name = display name. Join tokens are valid for 10 minutes (LiveKit refreshes the token of a connected participant itself).
3. Joining first asks LiveKit to create the channel's room; if that fails the join returns `503 VOICE_UNAVAILABLE`. With no LiveKit configured (`DATROPE_LIVEKIT_URL` empty) voice is off and every join returns `VOICE_UNAVAILABLE`.
4. Joining a text channel is `400 NOT_VOICE_CHANNEL`. DMs and voice channels can be joined. Text chat inside voice channels is not added.
5. Self mute and self deafen are done by the client (mic track muted, remote audio silenced); the client reports them (`self_mute`, `self_deaf`) with the join request and later via `PATCH /api/voice/state`, and the server only relays them. Camera/screen flags come from LiveKit `track_published`/`track_unpublished`. Turning the camera off unpublishes the track (not just mutes it) so the server sees it.
6. **Server mute** (`MUTE_MEMBERS`) removes the microphone from the participant's allowed sources (LiveKit unpublishes the track). It lasts while the user stays in that channel.
7. **Moderation:** `POST /api/voice/members/{userID}/mute` (`MUTE_MEMBERS`), `DELETE /api/voice/members/{userID}` (`MOVE_MEMBERS`, or yourself = leave), `POST /api/voice/members/{userID}/move` (`MOVE_MEMBERS` in both channels). LiveKit's open-source server cannot move participants, so a move sends `VOICE_MOVE {channel_id}` to the user's clients, which re-join there (the normal join checks still apply).
8. Permission enforcement: any event that can change permissions (`MEMBER_REMOVE`, `MEMBER_UPDATE`, `ROLE_UPDATE`, `ROLE_DELETE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE`, `COMMUNITY_DELETE`) triggers a reconcile of every voice participant: no `CONNECT_VOICE` (or channel gone) → removed; otherwise their allowed sources are set to exactly what `SPEAK`/`STREAM`/server mute allow. Signing a user out everywhere (password reset, account disabled) also removes them from voice. A deleted channel's room is deleted.
9. `VOICE_STATE_UPDATE` goes to everyone who can view the channel; a state without `channel_id` means "left voice". Clients that gain access to a channel later see its voice states on their next `READY`.
10. The web client subscribes to microphones and cameras automatically and to screen shares (video + audio) only when the user clicks **Watch**. Video is published with simulcast.
11. LiveKit runs in Compose with UDP mux on **7882/udp**, ICE/TCP fallback on **7881/tcp** and built-in **TURN/UDP on 3478/udp**; it finds its public IP via STUN (`use_external_ip`). These ports must be open/forwarded. The e2e stack overrides this to advertise 127.0.0.1.
12. The LiveKit API key name is fixed to `datrope`; only the secret is configured (`LIVEKIT_API_SECRET`, at least 32 characters).

## File Structure

```
server/internal/voice/
  livekit.go         Config, Sources, JoinToken, Rooms (RoomService client)
  voice.go           Service, Join, VoiceState, participant table, Sync, webhook
  reconcile.go       permission enforcement + moderation (Task 4)
  handlers.go        Huma operations (join, self state, moderation)
  helpers_test.go, livekit_test.go, voice_test.go, reconcile_test.go
server/internal/lktest/lktest.go   LiveKit container for tests + Connect helper
server/internal/app/   LiveKit config, voice wiring, App.Voice, READY voice_states, event schemas
clients/core/src/      VoiceState types, store.voice, voiceMembers, client voice calls, onEvent
clients/web/src/voice/voice.ts            livekit-client engine (zustand store)
clients/web/src/app/voice/                VoicePanel, VoiceMembers, VoiceStage, VoiceChannelView, TrackVideo
clients/web/src/components/ui/            + tooltip, avatar, dropdown-menu, toggle, badge (shadcn CLI)
deploy/  livekit service, livekit.yaml, livekit.e2e.yaml, docker-compose.e2e.yml, Caddy /livekit, .env, README
.github/workflows/ci.yml, clients/web/e2e/chat.spec.ts, clients/web/playwright.config.ts, clients/web/vite.config.ts
```

---

### Task 1: LiveKit client and test container

**Files:**
- Modify: `server/go.mod`, `server/go.sum`
- Create: `server/internal/voice/livekit.go`
- Create: `server/internal/lktest/lktest.go`
- Test: `server/internal/voice/livekit_test.go`

**Interfaces:**
- Produces (package `voice`): `type Config struct{ URL, PublicURL, APIKey, APISecret string }` with `(Config) Enabled() bool` and `(Config) JoinToken(channelID, userID id.ID, name string, sources []livekit.TrackSource) (string, error)`; `const TokenTTL`; `func Sources(p perms.Perms, serverMute bool) []livekit.TrackSource`; `type Rooms` with `NewRooms(cfg Config) *Rooms` and methods `Ensure(ctx, channelID id.ID) error`, `List(ctx) ([]string, error)`, `Participants(ctx, room string) ([]*livekit.ParticipantInfo, error)`, `Remove(ctx, channelID, userID id.ID) error`, `SetSources(ctx, channelID, userID id.ID, sources []livekit.TrackSource) error`, `Delete(ctx, channelID id.ID) error`. Unexported helpers `roomName(id.ID) string`, `identity(id.ID) string`.
- Produces (package `lktest`): `const APIKey, APISecret`; `func New(t *testing.T) voice.Config` (shared container, `URL` = `http://127.0.0.1:<port>`, `PublicURL` = `ws://127.0.0.1:<port>`); `func Connect(t *testing.T, cfg voice.Config, token string) *lksdk.Room` (disconnects on cleanup).

- [ ] **Step 1: Add the dependencies**

LiveKit's current Go releases require Go 1.26. These are the newest that build with Go 1.25.6 (verified):

```bash
cd server
GOTOOLCHAIN=local go get github.com/livekit/server-sdk-go/v2@v2.16.3 github.com/livekit/protocol@v1.45.5-0.20260423163244-347de5a2ef78 github.com/twitchtv/twirp@v8.1.3+incompatible
```

Expected: `go.mod` still says `go 1.25.6` and lists `github.com/livekit/protocol v1.45.5-0.20260423163244-347de5a2ef78`, `github.com/livekit/server-sdk-go/v2 v2.16.3`, `github.com/twitchtv/twirp v8.1.3+incompatible` (and `github.com/pion/webrtc/v4` indirectly). Some existing indirect dependencies (grpc, x/exp, genproto) move up; that is expected. Do not add a `toolchain` line. (`go mod tidy` runs at the end of the task, once the imports exist.)

- [ ] **Step 2: Write the failing tests** — `server/internal/voice/livekit_test.go`

```go
package voice_test

import (
	"context"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

var (
	mic    = livekit.TrackSource_MICROPHONE
	camera = livekit.TrackSource_CAMERA
	screen = livekit.TrackSource_SCREEN_SHARE
	sound  = livekit.TrackSource_SCREEN_SHARE_AUDIO
)

func TestSources(t *testing.T) {
	for _, tc := range []struct {
		name       string
		p          perms.Perms
		serverMute bool
		want       []livekit.TrackSource
	}{
		{"nothing", perms.ViewChannel | perms.ConnectVoice, false, []livekit.TrackSource{}},
		{"speak", perms.Speak, false, []livekit.TrackSource{mic}},
		{"speak, server muted", perms.Speak, true, []livekit.TrackSource{}},
		{"stream", perms.Stream, false, []livekit.TrackSource{camera, screen, sound}},
		{"defaults", perms.Default, false, []livekit.TrackSource{mic, camera, screen, sound}},
		{"defaults, server muted", perms.Default, true, []livekit.TrackSource{camera, screen, sound}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, voice.Sources(tc.p, tc.serverMute))
		})
	}
}

// grants verifies a token with the config's secret and returns its claims.
func grants(t *testing.T, cfg voice.Config, token string) *lkauth.ClaimGrants {
	t.Helper()
	v, err := lkauth.ParseAPIToken(token)
	require.NoError(t, err)
	_, g, err := v.Verify(cfg.APISecret)
	require.NoError(t, err)
	return g
}

func TestJoinToken(t *testing.T) {
	cfg := voice.Config{APIKey: "key", APISecret: "secret-secret-secret-secret-secret"}
	token, err := cfg.JoinToken(id.ID(7), id.ID(42), "Alice", voice.Sources(perms.Speak, false))
	require.NoError(t, err)
	g := grants(t, cfg, token)
	require.Equal(t, "42", g.Identity)
	require.Equal(t, "Alice", g.Name)
	require.True(t, g.Video.RoomJoin)
	require.Equal(t, "7", g.Video.Room)
	require.True(t, g.Video.GetCanSubscribe())
	require.True(t, g.Video.GetCanPublishSource(mic))
	require.False(t, g.Video.GetCanPublishSource(camera))
	require.False(t, g.Video.GetCanPublishData())
	require.False(t, g.Video.RoomAdmin)

	token, err = cfg.JoinToken(id.ID(7), id.ID(42), "Alice", voice.Sources(0, false))
	require.NoError(t, err)
	g = grants(t, cfg, token)
	require.False(t, g.Video.GetCanPublish(), "no SPEAK or STREAM: nothing may be published")
	require.True(t, g.Video.GetCanSubscribe(), "listening needs no permission beyond CONNECT_VOICE")
}

func TestRoomsAgainstLiveKit(t *testing.T) {
	cfg := lktest.New(t)
	rooms := voice.NewRooms(cfg)
	ctx := context.Background()
	ch, user := id.New(), id.New()

	require.NoError(t, rooms.Ensure(ctx, ch))
	require.NoError(t, rooms.Ensure(ctx, ch), "ensuring an existing room is fine")
	names, err := rooms.List(ctx)
	require.NoError(t, err)
	require.Contains(t, names, ch.String())

	token, err := cfg.JoinToken(ch, user, "Alice", voice.Sources(perms.Speak, false))
	require.NoError(t, err)
	lktest.Connect(t, cfg, token)
	ps, err := rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Len(t, ps, 1)
	require.Equal(t, user.String(), ps[0].Identity)
	require.Equal(t, []livekit.TrackSource{mic}, ps[0].GetPermission().GetCanPublishSources())

	require.NoError(t, rooms.SetSources(ctx, ch, user, voice.Sources(perms.Speak|perms.Stream, false)))
	ps, err = rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Equal(t, []livekit.TrackSource{mic, camera, screen, sound}, ps[0].GetPermission().GetCanPublishSources())

	require.NoError(t, rooms.Remove(ctx, ch, user))
	require.Eventually(t, func() bool {
		ps, err := rooms.Participants(ctx, ch.String())
		return err == nil && len(ps) == 0
	}, 5*time.Second, 100*time.Millisecond)
	require.NoError(t, rooms.Remove(ctx, ch, user), "removing someone who left is fine")
	require.NoError(t, rooms.SetSources(ctx, ch, user, nil), "updating someone who left is fine")

	require.NoError(t, rooms.Delete(ctx, ch))
	require.NoError(t, rooms.Delete(ctx, ch), "deleting a missing room is fine")
	ps, err = rooms.Participants(ctx, ch.String())
	require.NoError(t, err)
	require.Empty(t, ps, "a missing room has no participants")

	down := voice.NewRooms(voice.Config{URL: "http://127.0.0.1:1", APIKey: lktest.APIKey, APISecret: lktest.APISecret})
	require.Error(t, down.Ensure(ctx, ch), "an unreachable LiveKit is an error")
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/`
Expected: FAIL to compile — package `voice` and `lktest` do not exist.

- [ ] **Step 4: Write `server/internal/voice/livekit.go`**

```go
// Package voice puts users into LiveKit rooms (spec sections 2.2 and 5.3).
// Media never passes through this server: it checks permissions, issues
// LiveKit tokens, follows LiveKit webhooks, and asks LiveKit to remove,
// mute or update participants.
package voice

import (
	"context"
	"errors"
	"net/http"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"

	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Config says how to reach LiveKit. Voice is off when URL is empty.
type Config struct {
	URL       string // LiveKit's API as this server reaches it, e.g. http://livekit:7880
	PublicURL string // what clients connect to, e.g. wss://chat.example.com/livekit
	APIKey    string
	APISecret string
}

func (c Config) Enabled() bool { return c.URL != "" }

// TokenTTL bounds how long a join token can be used to connect. LiveKit
// refreshes the token of a connected participant by itself.
const TokenTTL = 10 * time.Minute

// Rooms are named after channel IDs, participants after user IDs.
func roomName(channelID id.ID) string { return channelID.String() }
func identity(userID id.ID) string    { return userID.String() }

// Sources lists the track sources a member may publish: audio needs SPEAK,
// camera and screen need STREAM. A server-muted member publishes no audio.
func Sources(p perms.Perms, serverMute bool) []livekit.TrackSource {
	out := []livekit.TrackSource{}
	if p.Has(perms.Speak) && !serverMute {
		out = append(out, livekit.TrackSource_MICROPHONE)
	}
	if p.Has(perms.Stream) {
		out = append(out, livekit.TrackSource_CAMERA, livekit.TrackSource_SCREEN_SHARE, livekit.TrackSource_SCREEN_SHARE_AUDIO)
	}
	return out
}

// JoinToken lets one user into one channel's room, publishing only sources.
func (c Config) JoinToken(channelID, userID id.ID, name string, sources []livekit.TrackSource) (string, error) {
	g := &lkauth.VideoGrant{RoomJoin: true, Room: roomName(channelID)}
	g.SetCanSubscribe(true)
	g.SetCanPublishData(false)
	g.SetCanUpdateOwnMetadata(false)
	g.SetCanPublish(len(sources) > 0)
	if len(sources) > 0 {
		g.SetCanPublishSources(sources)
	}
	return lkauth.NewAccessToken(c.APIKey, c.APISecret).
		SetIdentity(identity(userID)).SetName(name).SetValidFor(TokenTTL).SetVideoGrant(g).ToJWT()
}

// Rooms calls LiveKit's RoomService. Each call carries a short-lived admin
// token limited to what the call does.
type Rooms struct {
	cfg Config
	rs  livekit.RoomService
}

func NewRooms(cfg Config) *Rooms {
	return &Rooms{cfg: cfg, rs: livekit.NewRoomServiceProtobufClient(cfg.URL, &http.Client{Timeout: 5 * time.Second})}
}

func (r *Rooms) authed(ctx context.Context, g *lkauth.VideoGrant) (context.Context, error) {
	token, err := lkauth.NewAccessToken(r.cfg.APIKey, r.cfg.APISecret).SetVideoGrant(g).SetValidFor(time.Minute).ToJWT()
	if err != nil {
		return nil, err
	}
	return twirp.WithHTTPRequestHeaders(ctx, http.Header{"Authorization": {"Bearer " + token}})
}

// notFound reports LiveKit saying the room or participant does not exist.
func notFound(err error) bool {
	var te twirp.Error
	return errors.As(err, &te) && te.Code() == twirp.NotFound
}

// Ensure creates a channel's room unless it exists. Joining calls it first,
// so an unreachable LiveKit fails the join rather than the client.
func (r *Rooms) Ensure(ctx context.Context, channelID id.ID) error {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	_, err = r.rs.CreateRoom(ctx, &livekit.CreateRoomRequest{Name: roomName(channelID), EmptyTimeout: 300, DepartureTimeout: 20})
	return err
}

// List returns the names of all open rooms.
func (r *Rooms) List(ctx context.Context) ([]string, error) {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomList: true})
	if err != nil {
		return nil, err
	}
	res, err := r.rs.ListRooms(ctx, &livekit.ListRoomsRequest{})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(res.Rooms))
	for _, room := range res.Rooms {
		names = append(names, room.Name)
	}
	return names, nil
}

// Participants lists who is in a room; a missing room has nobody.
func (r *Rooms) Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return nil, err
	}
	res, err := r.rs.ListParticipants(ctx, &livekit.ListParticipantsRequest{Room: room})
	if notFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return res.Participants, nil
}

// Remove disconnects a user from a channel's room. Already gone is fine.
func (r *Rooms) Remove(ctx context.Context, channelID, userID id.ID) error {
	room := roomName(channelID)
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	_, err = r.rs.RemoveParticipant(ctx, &livekit.RoomParticipantIdentity{Room: room, Identity: identity(userID)})
	if notFound(err) {
		return nil
	}
	return err
}

// SetSources changes what a connected user may publish. LiveKit unpublishes
// their tracks whose source is no longer allowed. Already gone is fine.
func (r *Rooms) SetSources(ctx context.Context, channelID, userID id.ID, sources []livekit.TrackSource) error {
	room := roomName(channelID)
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomAdmin: true, Room: room})
	if err != nil {
		return err
	}
	_, err = r.rs.UpdateParticipant(ctx, &livekit.UpdateParticipantRequest{
		Room: room, Identity: identity(userID),
		Permission: &livekit.ParticipantPermission{CanSubscribe: true, CanPublish: len(sources) > 0, CanPublishSources: sources},
	})
	if notFound(err) {
		return nil
	}
	return err
}

// Delete closes a channel's room and disconnects everyone in it.
func (r *Rooms) Delete(ctx context.Context, channelID id.ID) error {
	ctx, err := r.authed(ctx, &lkauth.VideoGrant{RoomCreate: true})
	if err != nil {
		return err
	}
	_, err = r.rs.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: roomName(channelID)})
	if notFound(err) {
		return nil
	}
	return err
}
```

- [ ] **Step 5: Write `server/internal/lktest/lktest.go`**

The container advertises `127.0.0.1` and publishes its media ports on the same fixed host ports (WebRTC candidates carry the port number, so a random mapping would break media). Only one test package (`voice`) may use `lktest`, because the fixed ports cannot be shared by two test binaries running at once. 17881/17882 avoid a LiveKit you may run for development on 7881/7882.

```go
// Package lktest runs a LiveKit server in Docker for tests (spec section 10).
//
// One container starts per test binary. Rooms are named after channel IDs,
// which are unique, so tests never share a room. Only the voice package's
// tests may use it: the media ports are fixed, so two test binaries using
// it at once would collide. Docker must be running.
package lktest

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/datrope/datrope/server/internal/voice"
)

const (
	APIKey    = "datrope-test"
	APISecret = "datrope-test-secret-0123456789abcdef"
	tcpPort   = "17881" // ICE over TCP
	udpPort   = "17882" // all WebRTC UDP traffic (UDP mux)
)

var (
	once     sync.Once
	cfg      voice.Config
	startErr error
)

// New returns a Config for the shared LiveKit server, starting it on first use.
func New(t *testing.T) voice.Config {
	t.Helper()
	once.Do(start)
	if startErr != nil {
		t.Fatalf("start livekit (is Docker running?): %v", startErr)
	}
	return cfg
}

func start() {
	// See pgtest: without this, Ryuk cannot start on Docker Desktop for Windows.
	if runtime.GOOS == "windows" && os.Getenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE") == "" {
		os.Setenv("TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE", "/var/run/docker.sock")
	}
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "livekit/livekit-server:v1.13.7",
			ExposedPorts: []string{"7880/tcp", tcpPort + ":" + tcpPort + "/tcp", udpPort + ":" + udpPort + "/udp"},
			Env: map[string]string{
				"LIVEKIT_KEYS": APIKey + ": " + APISecret,
				"NODE_IP":      "127.0.0.1",
				"UDP_PORT":     udpPort,
				"LIVEKIT_CONFIG": "rtc:\n  tcp_port: " + tcpPort + "\n  use_external_ip: false\n" +
					"room:\n  empty_timeout: 30\n  departure_timeout: 5\nlogging:\n  level: warn\n",
			},
			WaitingFor: wait.ForHTTP("/").WithPort("7880/tcp").WithStartupTimeout(2 * time.Minute),
		},
		Started: true,
	})
	if err != nil {
		startErr = err
		return
	}
	host, err := c.Host(ctx)
	if err != nil {
		startErr = err
		return
	}
	port, err := c.MappedPort(ctx, "7880/tcp")
	if err != nil {
		startErr = err
		return
	}
	addr := fmt.Sprintf("%s:%s", host, port.Port())
	cfg = voice.Config{URL: "http://" + addr, PublicURL: "ws://" + addr, APIKey: APIKey, APISecret: APISecret}
}

// Connect joins a room as a fake participant (no media is sent) and leaves
// it when the test ends.
func Connect(t *testing.T, cfg voice.Config, token string) *lksdk.Room {
	t.Helper()
	room, err := lksdk.ConnectToRoomWithToken(cfg.PublicURL, token, &lksdk.RoomCallback{}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		t.Fatalf("connect to livekit: %v", err)
	}
	t.Cleanup(room.Disconnect)
	return room
}
```

If `testcontainers-go` v0.44 rejects the `host:container/proto` form in `ExposedPorts`, keep `"7880/tcp", tcpPort + "/tcp", udpPort + "/udp"` there and bind the host ports with a `HostConfigModifier` setting `hc.PortBindings` (`nat.PortMap{tcpPort + "/tcp": {{HostPort: tcpPort}}, udpPort + "/udp": {{HostPort: udpPort}}}`); record the deviation.

- [ ] **Step 6: Tidy and run the tests**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server mod tidy; go -C server test ./internal/voice/ -run 'TestSources|TestJoinToken|TestRoomsAgainstLiveKit' -v`
Expected: PASS (the first run pulls `livekit/livekit-server:v1.13.7`). `go.mod` still says `go 1.25.6`. `docker ps` afterwards shows no leftover LiveKit container once Ryuk reaps it (within ~10 s of the test binary exiting).

- [ ] **Step 7: Vet and format**

Run: `gofmt -l server/internal/voice server/internal/lktest` (no output) and `go -C server vet ./...` (clean).

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(voice): LiveKit room client, join tokens, test container`

---
### Task 2: Joining voice

**Files:**
- Create: `server/internal/voice/voice.go`
- Create: `server/internal/voice/handlers.go`
- Modify: `server/internal/app/config.go` (LiveKit settings)
- Modify: `server/internal/app/app.go` (wire voice, `App.Voice`)
- Test: `server/internal/voice/helpers_test.go`, `server/internal/voice/voice_test.go`, `server/internal/app/config_test.go`

**Interfaces:**
- Consumes: Task 1's `Config`, `Sources`, `JoinToken`, `Rooms`; `channels.Service.Access`/`Perms` (existing signatures: `Access(ctx, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)`, `Perms(ctx, userID, channelID id.ID) (perms.Perms, *channels.Channel, error)`); `auth.Current(ctx).User`.
- Produces: `voice.Channels` interface; `voice.JoinRequest{SelfMute, SelfDeaf bool}` (JSON `self_mute`, `self_deaf`); `voice.JoinResponse{URL, Token string}` (JSON `url`, `token`); `voice.NewService(cfg Config, bus *events.Bus, ch Channels) *Service`; `(*Service).Join(ctx, user *auth.User, channelID id.ID, req JoinRequest) (*JoinResponse, error)`; `voice.Register(api huma.API, s *Service)` with operation `join-voice` = `POST /api/voice/{id}/join`; `app.Config.LiveKit voice.Config`; `app.App.Voice *voice.Service`. Test helpers (package `voice_test`): `liveKitEnv`, `offlineConfig`, `club`/`newClub`, `createVoice`, `joinPath`, `join`, `setEveryone`, `deny`.

- [ ] **Step 1: Write the test helpers** — `server/internal/voice/helpers_test.go`

```go
package voice_test

import (
	"net/http"
	"testing"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

// liveKitEnv runs the app against the shared test LiveKit server.
func liveKitEnv(t *testing.T) (*apptest.Env, voice.Config) {
	t.Helper()
	cfg := lktest.New(t)
	return apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg }), cfg
}

// offlineConfig points at a LiveKit that is not running: joining fails,
// but webhooks (which LiveKit sends to us) can still be tested.
var offlineConfig = voice.Config{
	URL: "http://127.0.0.1:1", PublicURL: "ws://127.0.0.1:1", APIKey: lktest.APIKey, APISecret: lktest.APISecret,
}

// club is a community with an owner (also the instance admin), a member,
// #general, and a voice channel.
type club struct {
	owner, member *apptest.Client
	community     communities.CommunityWithRoles
	voiceID       id.ID
	textID        id.ID
}

func newClub(t *testing.T, env *apptest.Env) club {
	t.Helper()
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Club")
	bob.JoinCommunity(alice, c.ID)
	return club{owner: alice, member: bob, community: c, voiceID: createVoice(alice, c.ID, "Lounge"), textID: alice.General(c.ID)}
}

func createVoice(owner *apptest.Client, communityID id.ID, name string) id.ID {
	var ch channels.Channel
	owner.Do(http.MethodPost, "/api/communities/"+communityID.String()+"/channels",
		map[string]any{"name": name, "type": "voice"}, http.StatusCreated, &ch)
	return ch.ID
}

func joinPath(channelID id.ID) string { return "/api/voice/" + channelID.String() + "/join" }

func join(c *apptest.Client, channelID id.ID) voice.JoinResponse {
	var res voice.JoinResponse
	c.Do(http.MethodPost, joinPath(channelID), map[string]any{}, http.StatusOK, &res)
	return res
}

// setEveryone sets the @everyone role's permissions (its ID is the community's).
func setEveryone(owner *apptest.Client, communityID id.ID, p perms.Perms) {
	owner.Do(http.MethodPatch, "/api/communities/"+communityID.String()+"/roles/"+communityID.String(),
		map[string]any{"permissions": p}, http.StatusOK, nil)
}

// deny puts an @everyone override denying p on a channel.
func deny(owner *apptest.Client, channelID, communityID id.ID, p perms.Perms) {
	owner.Do(http.MethodPut, "/api/channels/"+channelID.String()+"/overrides/role/"+communityID.String(),
		map[string]any{"allow": 0, "deny": p}, http.StatusOK, nil)
}
```

- [ ] **Step 2: Write the failing tests** — `server/internal/voice/voice_test.go`

```go
package voice_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

func TestJoinWhenVoiceIsOff(t *testing.T) {
	env := apptest.New(t)
	c := newClub(t, env)
	c.owner.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusServiceUnavailable, "VOICE_UNAVAILABLE")
}

func TestJoinWhenLiveKitIsDown(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = offlineConfig })
	c := newClub(t, env)
	c.owner.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusServiceUnavailable, "VOICE_UNAVAILABLE")
	c.owner.Send(c.textID, "text chat keeps working")
}

func TestJoinChecksPermissions(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	eve := env.Register("eve")

	c.owner.Fail(http.MethodPost, joinPath(c.textID), map[string]any{}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")
	eve.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusNotFound, "NOT_FOUND")
	c.owner.Fail(http.MethodPost, joinPath(id.New()), map[string]any{}, http.StatusNotFound, "NOT_FOUND")

	deny(c.owner, c.voiceID, c.community.ID, perms.ConnectVoice)
	c.member.Fail(http.MethodPost, joinPath(c.voiceID), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	c.owner.Do(http.MethodDelete, "/api/channels/"+c.voiceID.String()+"/overrides/role/"+c.community.ID.String(),
		nil, http.StatusNoContent, nil)

	res := join(c.owner, c.voiceID)
	require.Equal(t, cfg.PublicURL, res.URL)
	g := grants(t, cfg, res.Token)
	require.Equal(t, c.voiceID.String(), g.Video.Room)
	require.Equal(t, c.owner.User.ID.String(), g.Identity)
	require.Equal(t, "alice", g.Name)
	for _, src := range []livekit.TrackSource{mic, camera, screen, sound} {
		require.True(t, g.Video.GetCanPublishSource(src), src.String())
	}

	// Without STREAM the token allows the microphone only, and LiveKit agrees.
	setEveryone(c.owner, c.community.ID, perms.Default&^perms.Stream)
	res = join(c.member, c.voiceID)
	g = grants(t, cfg, res.Token)
	require.True(t, g.Video.GetCanPublishSource(mic))
	require.False(t, g.Video.GetCanPublishSource(camera))
	require.False(t, g.Video.GetCanPublishSource(screen))
	lktest.Connect(t, cfg, res.Token)
	ps, err := voice.NewRooms(cfg).Participants(context.Background(), c.voiceID.String())
	require.NoError(t, err)
	require.Len(t, ps, 1)
	require.Equal(t, []livekit.TrackSource{mic}, ps[0].GetPermission().GetCanPublishSources())
}

func TestJoinDMCall(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	carol := env.Register("carol")
	var dm channels.Channel
	c.owner.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []id.ID{c.member.User.ID}}, http.StatusOK, &dm)

	g := grants(t, cfg, join(c.member, dm.ID).Token)
	require.Equal(t, dm.ID.String(), g.Video.Room)
	require.True(t, g.Video.GetCanPublishSource(mic), "DM participants may speak")
	require.True(t, g.Video.GetCanPublishSource(camera), "DM participants may stream")
	carol.Fail(http.MethodPost, joinPath(dm.ID), map[string]any{}, http.StatusNotFound, "NOT_FOUND")
}
```

And `server/internal/app/config_test.go`:

```go
package app_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
)

func TestConfigLiveKit(t *testing.T) {
	t.Setenv("DATROPE_DATABASE_URL", "postgres://example")
	t.Setenv("DATROPE_PUBLIC_URL", "https://chat.example.com/")
	t.Setenv("DATROPE_LIVEKIT_URL", "")
	t.Setenv("DATROPE_LIVEKIT_PUBLIC_URL", "")
	t.Setenv("DATROPE_LIVEKIT_API_KEY", "")
	t.Setenv("DATROPE_LIVEKIT_API_SECRET", "")
	c, err := app.ConfigFromEnv()
	require.NoError(t, err)
	require.False(t, c.LiveKit.Enabled(), "voice is off without DATROPE_LIVEKIT_URL")

	t.Setenv("DATROPE_LIVEKIT_URL", "http://livekit:7880")
	t.Setenv("DATROPE_LIVEKIT_API_KEY", "datrope")
	t.Setenv("DATROPE_LIVEKIT_API_SECRET", "too-short")
	_, err = app.ConfigFromEnv()
	require.Error(t, err, "LiveKit refuses secrets under 32 characters, so we do too")

	t.Setenv("DATROPE_LIVEKIT_API_SECRET", strings.Repeat("s", 32))
	c, err = app.ConfigFromEnv()
	require.NoError(t, err)
	require.True(t, c.LiveKit.Enabled())
	require.Equal(t, "wss://chat.example.com/livekit", c.LiveKit.PublicURL, "derived from the public URL")

	t.Setenv("DATROPE_PUBLIC_URL", "http://localhost:5173")
	c, err = app.ConfigFromEnv()
	require.NoError(t, err)
	require.Equal(t, "ws://localhost:5173/livekit", c.LiveKit.PublicURL)

	t.Setenv("DATROPE_LIVEKIT_PUBLIC_URL", "wss://voice.example.com")
	c, err = app.ConfigFromEnv()
	require.NoError(t, err)
	require.Equal(t, "wss://voice.example.com", c.LiveKit.PublicURL, "an explicit public URL wins")
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/ ./internal/app/`
Expected: FAIL to compile — `app.Config` has no field `LiveKit`, `voice.JoinResponse` is undefined.

- [ ] **Step 4: Write `server/internal/voice/voice.go`**

```go
package voice

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Channels is what voice needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
	Perms(ctx context.Context, userID, channelID id.ID) (perms.Perms, *channels.Channel, error)
}

type JoinRequest struct {
	SelfMute bool `json:"self_mute,omitempty" doc:"The client starts muted"`
	SelfDeaf bool `json:"self_deaf,omitempty" doc:"The client starts deafened"`
}

type JoinResponse struct {
	URL   string `json:"url" doc:"LiveKit server to connect to"`
	Token string `json:"token" doc:"LiveKit access token for the channel's room"`
}

func unavailable(msg string) *httpx.Error {
	return httpx.E(http.StatusServiceUnavailable, "VOICE_UNAVAILABLE", msg)
}

type Service struct {
	cfg      Config
	rooms    *Rooms // nil when voice is off
	bus      *events.Bus
	channels Channels
}

func NewService(cfg Config, bus *events.Bus, ch Channels) *Service {
	s := &Service{cfg: cfg, bus: bus, channels: ch}
	if cfg.Enabled() {
		s.rooms = NewRooms(cfg)
	}
	return s
}

func displayName(u *auth.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}

// Join checks the user may connect to a channel's voice and returns a token
// for its LiveKit room (spec section 5.3, steps 1–2).
func (s *Service) Join(ctx context.Context, user *auth.User, channelID id.ID, req JoinRequest) (*JoinResponse, error) {
	if !s.cfg.Enabled() {
		return nil, unavailable("voice is not set up on this server")
	}
	c, p, err := s.channels.Access(ctx, user.ID, channelID, perms.ConnectVoice)
	if err != nil {
		return nil, err
	}
	if c.Type == channels.TypeText {
		return nil, httpx.BadRequest("NOT_VOICE_CHANNEL", "this is a text channel")
	}
	if err := s.rooms.Ensure(ctx, channelID); err != nil {
		slog.ErrorContext(ctx, "voice: livekit unreachable", "err", err)
		return nil, unavailable("the voice server is unreachable")
	}
	token, err := s.cfg.JoinToken(channelID, user.ID, displayName(user), Sources(p, false))
	if err != nil {
		return nil, err
	}
	return &JoinResponse{URL: s.cfg.PublicURL, Token: token}, nil
}
```

(`req` is used from Task 3 on.)

- [ ] **Step 5: Write `server/internal/voice/handlers.go`**

```go
package voice

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"voice"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) *auth.User { return auth.Current(ctx).User }

	huma.Register(api, op("join-voice", http.MethodPost, "/api/voice/{id}/join", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body JoinRequest
		}) (*struct{ Body *JoinResponse }, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			res, err := s.Join(ctx, me(ctx), chID, in.Body)
			return &struct{ Body *JoinResponse }{res}, err
		})
}
```

- [ ] **Step 6: Configuration** — in `server/internal/app/config.go`:

Add the import `"github.com/datrope/datrope/server/internal/voice"` and a field at the end of `Config`:

```go
	DataDir    string          // uploads live in DataDir/files
	LiveKit    voice.Config    // voice is off when LiveKit.URL is empty
```

In `ConfigFromEnv`, add to the `c := Config{...}` literal:

```go
		LiveKit: voice.Config{
			URL:       os.Getenv("DATROPE_LIVEKIT_URL"),
			PublicURL: strings.TrimSuffix(os.Getenv("DATROPE_LIVEKIT_PUBLIC_URL"), "/"),
			APIKey:    os.Getenv("DATROPE_LIVEKIT_API_KEY"),
			APISecret: os.Getenv("DATROPE_LIVEKIT_API_SECRET"),
		},
```

and, after the `DATROPE_PUBLIC_URL is required` check, before `return c, nil`:

```go
	if c.LiveKit.Enabled() {
		if c.LiveKit.APIKey == "" || len(c.LiveKit.APISecret) < 32 {
			return c, errors.New("DATROPE_LIVEKIT_URL needs DATROPE_LIVEKIT_API_KEY and a DATROPE_LIVEKIT_API_SECRET of at least 32 characters")
		}
		if c.LiveKit.PublicURL == "" { // https://host -> wss://host/livekit (Caddy proxies it)
			c.LiveKit.PublicURL = "ws" + strings.TrimPrefix(c.PublicURL, "http") + "/livekit"
		}
	}
```

- [ ] **Step 7: Wire it** — in `server/internal/app/app.go`:

Add the import `"github.com/datrope/datrope/server/internal/voice"`, a field on `App` after `Files`:

```go
	Voice   *voice.Service // nil when built without a database
```

and, right after `messages.Register(api, msgSvc)`:

```go
	voiceSvc := voice.NewService(cfg.LiveKit, a.Bus, chanSvc)
	voice.Register(api, voiceSvc)
	if pool != nil { // nil only for `datrope openapi`
		a.Voice = voiceSvc
	}
```

- [ ] **Step 8: Run the tests**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/ ./internal/app/`
Expected: PASS. Then the whole suite: `go -C server test -p 2 ./...` — PASS.

- [ ] **Step 9: Vet and format** — `gofmt -l server` (no output), `go -C server vet ./...` (clean).

- [ ] **Step 10: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(voice): join voice channels and DM calls with permission-scoped LiveKit tokens`

---
### Task 3: Voice state from LiveKit

**Files:**
- Modify (replace): `server/internal/voice/voice.go`
- Modify: `server/internal/voice/handlers.go` (self state)
- Modify: `server/internal/app/app.go` (webhook route, start/close, READY), `server/internal/app/realtime.go` (READY `voice_states`, event schema)
- Test: `server/internal/voice/state_test.go`, `server/internal/app/app_test.go`

**Interfaces:**
- Consumes: Task 2's `Service`, `Join`, `Channels`; Task 1's `Rooms.List`/`Participants`/`Remove`.
- Produces: `voice.VoiceState{UserID id.ID; ChannelID *id.ID; SelfMute, SelfDeaf, ServerMute, Camera, Screen bool}` (JSON `user_id`, `channel_id` omitted when the user left, `self_mute`, `self_deaf`, `server_mute`, `camera`, `screen`); gateway event `VOICE_STATE_UPDATE` with that payload, scoped to the channel's viewers; `voice.SelfStateRequest{SelfMute, SelfDeaf *bool}`; operation `set-voice-state` = `PATCH /api/voice/state` → 204, or `409 NOT_IN_VOICE`; `(*Service).Start()`, `Close()`, `Sync(ctx) error`, `States(channelIDs []id.ID) []VoiceState`, `SetSelf(userID id.ID, req SelfStateRequest) error`, `WebhookHandler() http.Handler` mounted at `POST /api/voice/webhook`; `app.Ready.VoiceStates []voice.VoiceState` (JSON `voice_states`). Internal (used by Task 4): `participant` (`channelID`, `sid`, `serverMute`, `sources`, `self`), `s.mu`, `s.users`, `s.ctx`, `s.wg`, `publishLocked`, `publishLeftLocked`, `adopt`, `run`.

- [ ] **Step 1: Write the failing tests** — `server/internal/voice/state_test.go`

```go
package voice_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/voice"
)

const settle, poll = 5 * time.Second, 100 * time.Millisecond

// sendWebhook signs ev the way LiveKit does and posts it to the server.
func sendWebhook(t *testing.T, env *apptest.Env, cfg voice.Config, ev *livekit.WebhookEvent) int {
	t.Helper()
	body, err := protojson.Marshal(ev)
	require.NoError(t, err)
	sum := sha256.Sum256(body)
	token, err := lkauth.NewAccessToken(cfg.APIKey, cfg.APISecret).SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	require.NoError(t, err)
	req, err := http.NewRequest(http.MethodPost, env.Server.URL+"/api/voice/webhook", bytes.NewReader(body))
	require.NoError(t, err)
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/webhook+json")
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	resp.Body.Close()
	return resp.StatusCode
}

// lkEvent builds a webhook about one participant (sid) of a channel's room.
func lkEvent(kind string, channelID, userID id.ID, sid string, joinedAt int64) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{Event: kind, Room: &livekit.Room{Name: channelID.String()},
		Participant: &livekit.ParticipantInfo{Sid: sid, Identity: userID.String(), JoinedAt: joinedAt}}
}

// nextState waits for the next VOICE_STATE_UPDATE about userID on ws.
func nextState(t *testing.T, ws *apptest.WS, userID id.ID) voice.VoiceState {
	t.Helper()
	for {
		var st voice.VoiceState
		ws.ExpectDispatch("VOICE_STATE_UPDATE", &st)
		if st.UserID == userID {
			return st
		}
	}
}

// participantCount is how many participants LiveKit has in a channel's room (-1 on error).
func participantCount(cfg voice.Config, channelID id.ID) int {
	ps, err := voice.NewRooms(cfg).Participants(context.Background(), channelID.String())
	if err != nil {
		return -1
	}
	return len(ps)
}

func TestWebhookMustBeSigned(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = offlineConfig })
	c := newClub(t, env)
	ws, _ := c.owner.Connect()

	wrong := offlineConfig
	wrong.APISecret = "another-secret-0123456789abcdef0123"
	require.Equal(t, http.StatusUnauthorized,
		sendWebhook(t, env, wrong, lkEvent("participant_joined", c.voiceID, c.member.User.ID, "PA_1", 1)))
	env.Anon().Raw(http.MethodPost, "/api/voice/webhook", strings.NewReader("{}"), "application/json", http.StatusUnauthorized)
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond)
}

func TestWebhooksTrackVoiceState(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = offlineConfig })
	c := newClub(t, env)
	eve := env.Register("eve")
	ownerWS, _ := c.owner.Connect()
	eveWS, _ := eve.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, offlineConfig, ev))
	}

	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100))
	st := nextState(t, ownerWS, bob)
	require.NotNil(t, st.ChannelID)
	require.Equal(t, c.voiceID, *st.ChannelID)
	require.False(t, st.Camera)

	_, ready := c.owner.Connect()
	require.Len(t, ready.VoiceStates, 1, "READY lists who is in voice")
	require.Equal(t, bob, ready.VoiceStates[0].UserID)

	camera := lkEvent("track_published", c.voiceID, bob, "PA_1", 100)
	camera.Track = &livekit.TrackInfo{Sid: "TR_1", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_CAMERA}
	hook(camera)
	require.True(t, nextState(t, ownerWS, bob).Camera)
	camera.Event = "track_unpublished"
	hook(camera)
	require.False(t, nextState(t, ownerWS, bob).Camera)

	c.member.Do(http.MethodPatch, "/api/voice/state", map[string]any{"self_mute": true}, http.StatusNoContent, nil)
	st = nextState(t, ownerWS, bob)
	require.True(t, st.SelfMute)
	require.False(t, st.SelfDeaf)

	hook(lkEvent("participant_left", c.voiceID, bob, "PA_0", 50))
	ownerWS.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond) // about an older connection: ignored

	hook(lkEvent("participant_left", c.voiceID, bob, "PA_1", 100))
	require.Nil(t, nextState(t, ownerWS, bob).ChannelID, "no channel means left")
	c.member.Fail(http.MethodPatch, "/api/voice/state", map[string]any{"self_mute": false}, http.StatusConflict, "NOT_IN_VOICE")

	eveWS.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond) // eve cannot see the channel
}

func TestOneVoiceChannelAtATime(t *testing.T) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = offlineConfig })
	c := newClub(t, env)
	games := createVoice(c.owner, c.community.ID, "Games")
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, offlineConfig, ev))
	}

	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100))
	require.Equal(t, c.voiceID, *nextState(t, ws, bob).ChannelID)
	hook(lkEvent("participant_joined", games, bob, "PA_2", 200))
	require.Nil(t, nextState(t, ws, bob).ChannelID, "the newer connection wins: left Lounge")
	require.Equal(t, games, *nextState(t, ws, bob).ChannelID)

	// A late report about the older connection changes nothing.
	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100))
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond)
}

func TestSyncFollowsLiveKit(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	ctx := context.Background()
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID

	var res voice.JoinResponse
	c.member.Do(http.MethodPost, joinPath(c.voiceID), map[string]any{"self_mute": true}, http.StatusOK, &res)
	room := lktest.Connect(t, cfg, res.Token)
	require.NoError(t, env.App.Voice.Sync(ctx))
	st := nextState(t, ws, bob)
	require.Equal(t, c.voiceID, *st.ChannelID)
	require.True(t, st.SelfMute, "flags sent with the join request")

	track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8})
	require.NoError(t, err)
	_, err = room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "camera", Source: livekit.TrackSource_CAMERA})
	require.NoError(t, err)
	require.NoError(t, env.App.Voice.Sync(ctx))
	require.True(t, nextState(t, ws, bob).Camera)

	// Joining another channel leaves the first at once, in LiveKit too.
	games := createVoice(c.owner, c.community.ID, "Games")
	res = join(c.member, games)
	require.Nil(t, nextState(t, ws, bob).ChannelID)
	require.Eventually(t, func() bool { return participantCount(cfg, c.voiceID) == 0 }, settle, poll)

	second := lktest.Connect(t, cfg, res.Token)
	require.NoError(t, env.App.Voice.Sync(ctx))
	require.Equal(t, games, *nextState(t, ws, bob).ChannelID)

	// Leaving LiveKit is noticed by the next sync even without a webhook.
	second.Disconnect()
	require.Eventually(t, func() bool { return participantCount(cfg, games) == 0 }, settle, poll)
	require.NoError(t, env.App.Voice.Sync(ctx))
	require.Nil(t, nextState(t, ws, bob).ChannelID)
}
```

In `server/internal/app/app_test.go`, add `"VoiceState"` to the schema names in `TestOpenAPIHasEventSchemas`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/ ./internal/app/`
Expected: FAIL to compile — `voice.VoiceState`, `app.Ready.VoiceStates` and `env.App.Voice.Sync` are undefined.

- [ ] **Step 3: Replace `server/internal/voice/voice.go`**

```go
package voice

import (
	"cmp"
	"context"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/webhook"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// syncInterval is how often voice state is rebuilt from LiveKit. That
// repairs whatever a lost webhook or a restart got wrong.
const syncInterval = 30 * time.Second

// Channels is what voice needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
	Perms(ctx context.Context, userID, channelID id.ID) (perms.Perms, *channels.Channel, error)
}

type JoinRequest struct {
	SelfMute bool `json:"self_mute,omitempty" doc:"The client starts muted"`
	SelfDeaf bool `json:"self_deaf,omitempty" doc:"The client starts deafened"`
}

type JoinResponse struct {
	URL   string `json:"url" doc:"LiveKit server to connect to"`
	Token string `json:"token" doc:"LiveKit access token for the channel's room"`
}

type SelfStateRequest struct {
	SelfMute *bool `json:"self_mute,omitempty"`
	SelfDeaf *bool `json:"self_deaf,omitempty"`
}

// VoiceState is one user's presence in voice, as clients see it.
type VoiceState struct {
	UserID     id.ID  `json:"user_id"`
	ChannelID  *id.ID `json:"channel_id,omitempty" doc:"Absent when the user left voice"`
	SelfMute   bool   `json:"self_mute"`
	SelfDeaf   bool   `json:"self_deaf"`
	ServerMute bool   `json:"server_mute" doc:"Muted by a moderator"`
	Camera     bool   `json:"camera"`
	Screen     bool   `json:"screen" doc:"Sharing their screen"`
}

func unavailable(msg string) *httpx.Error {
	return httpx.E(http.StatusServiceUnavailable, "VOICE_UNAVAILABLE", msg)
}

type selfState struct{ mute, deaf bool }

// pendingJoin keeps the flags a client sent with its join request until
// LiveKit reports the user in the room.
type pendingJoin struct {
	self selfState
	at   time.Time
}

// participant is one user in one room. channelID never changes: moving to
// another room makes a new participant.
type participant struct {
	channelID  id.ID
	sid        string // LiveKit participant SID; reports about other SIDs are stale
	joinedAt   int64  // when LiveKit let them in (Unix seconds); the newest connection wins
	addedAt    time.Time
	self       selfState
	serverMute bool
	tracks     map[string]livekit.TrackSource // published tracks by track SID
	sources    []livekit.TrackSource          // what LiveKit currently lets them publish
}

func (p *participant) publishing(src livekit.TrackSource) bool {
	for _, s := range p.tracks {
		if s == src {
			return true
		}
	}
	return false
}

func (p *participant) state(userID id.ID) VoiceState {
	ch := p.channelID
	return VoiceState{UserID: userID, ChannelID: &ch, SelfMute: p.self.mute, SelfDeaf: p.self.deaf, ServerMute: p.serverMute,
		Camera: p.publishing(livekit.TrackSource_CAMERA), Screen: p.publishing(livekit.TrackSource_SCREEN_SHARE)}
}

type Service struct {
	cfg      Config
	rooms    *Rooms // nil when voice is off
	bus      *events.Bus
	channels Channels

	// mu guards users and pending. It is held while publishing voice
	// events so they reach clients in order.
	mu      sync.Mutex
	users   map[id.ID]*participant
	pending map[id.ID]pendingJoin

	ctx    context.Context // cancelled by Close
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(cfg Config, bus *events.Bus, ch Channels) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{
		cfg: cfg, bus: bus, channels: ch,
		users: map[id.ID]*participant{}, pending: map[id.ID]pendingJoin{},
		ctx: ctx, cancel: cancel,
	}
	if cfg.Enabled() {
		s.rooms = NewRooms(cfg)
	}
	return s
}

// Start follows LiveKit in the background until Close.
func (s *Service) Start() {
	if !s.cfg.Enabled() {
		return
	}
	s.wg.Add(1)
	go s.run()
}

func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

func (s *Service) run() {
	defer s.wg.Done()
	tick := time.NewTicker(syncInterval)
	defer tick.Stop()
	for {
		if err := s.Sync(s.ctx); err != nil && s.ctx.Err() == nil {
			slog.Error("voice: sync with livekit", "err", err)
		}
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
		}
	}
}

func displayName(u *auth.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
}

// Join checks the user may connect to a channel's voice and returns a token
// for its LiveKit room (spec section 5.3, steps 1–2).
func (s *Service) Join(ctx context.Context, user *auth.User, channelID id.ID, req JoinRequest) (*JoinResponse, error) {
	if !s.cfg.Enabled() {
		return nil, unavailable("voice is not set up on this server")
	}
	c, p, err := s.channels.Access(ctx, user.ID, channelID, perms.ConnectVoice)
	if err != nil {
		return nil, err
	}
	if c.Type == channels.TypeText {
		return nil, httpx.BadRequest("NOT_VOICE_CHANNEL", "this is a text channel")
	}
	if err := s.rooms.Ensure(ctx, channelID); err != nil {
		slog.ErrorContext(ctx, "voice: livekit unreachable", "err", err)
		return nil, unavailable("the voice server is unreachable")
	}
	serverMute := s.prepareJoin(ctx, user.ID, channelID, selfState{mute: req.SelfMute, deaf: req.SelfDeaf})
	token, err := s.cfg.JoinToken(channelID, user.ID, displayName(user), Sources(p, serverMute))
	if err != nil {
		return nil, err
	}
	return &JoinResponse{URL: s.cfg.PublicURL, Token: token}, nil
}

// prepareJoin keeps the client's flags until LiveKit reports the user, and
// takes them out of any other channel at once: a user is in one voice
// channel at a time. Rejoining the same channel keeps a server mute.
func (s *Service) prepareJoin(ctx context.Context, userID, channelID id.ID, self selfState) (serverMute bool) {
	s.mu.Lock()
	s.pending[userID] = pendingJoin{self: self, at: time.Now()}
	var leave *id.ID
	if p := s.users[userID]; p != nil {
		if p.channelID == channelID {
			serverMute = p.serverMute
		} else {
			delete(s.users, userID)
			s.publishLeftLocked(userID, p.channelID)
			leave = &p.channelID
		}
	}
	s.mu.Unlock()
	if leave != nil {
		if err := s.rooms.Remove(ctx, *leave, userID); err != nil {
			slog.ErrorContext(ctx, "voice: leave previous channel", "err", err)
		}
	}
	return serverMute
}

func (s *Service) publishLocked(userID id.ID, p *participant) {
	s.bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: p.state(userID), Scope: events.Scope{ChannelID: p.channelID}})
}

// publishLeftLocked tells a channel's viewers the user left voice.
func (s *Service) publishLeftLocked(userID, channelID id.ID) {
	s.bus.Publish(events.Event{Type: "VOICE_STATE_UPDATE", Data: VoiceState{UserID: userID}, Scope: events.Scope{ChannelID: channelID}})
}

// seen is a participant as LiveKit reports it.
type seen struct {
	channelID, userID id.ID
	sid               string
	joinedAt          int64
	tracks            map[string]livekit.TrackSource
	sources           []livekit.TrackSource
}

// fromLiveKit reads a participant of a room. Rooms and identities that are
// not Datrope IDs are not ours.
func fromLiveKit(room string, p *livekit.ParticipantInfo) (seen, bool) {
	ch, err1 := id.Parse(room)
	u, err2 := id.Parse(p.GetIdentity())
	if err1 != nil || err2 != nil {
		return seen{}, false
	}
	v := seen{channelID: ch, userID: u, sid: p.GetSid(), joinedAt: p.GetJoinedAt(), tracks: map[string]livekit.TrackSource{}}
	for _, t := range p.GetTracks() {
		v.tracks[t.GetSid()] = t.GetSource()
	}
	if perm := p.GetPermission(); perm.GetCanPublish() {
		v.sources = perm.GetCanPublishSources()
		if len(v.sources) == 0 { // "any source": never what we grant, so the next reconcile fixes it
			v.sources = []livekit.TrackSource{livekit.TrackSource_UNKNOWN}
		}
	}
	return v, true
}

// adopt records participants LiveKit reports, oldest first, and removes
// connections that lose to a newer one elsewhere.
func (s *Service) adopt(ctx context.Context, vs []seen) {
	type removal struct{ channelID, userID id.ID }
	var removals []removal
	s.mu.Lock()
	for _, v := range vs {
		if ch, stale := s.joinedLocked(v); stale {
			removals = append(removals, removal{ch, v.userID})
		}
	}
	s.mu.Unlock()
	for _, r := range removals {
		if err := s.rooms.Remove(ctx, r.channelID, r.userID); err != nil {
			slog.ErrorContext(ctx, "voice: remove older connection", "err", err)
		}
	}
}

// joinedLocked records that LiveKit has v.userID in a room. If LiveKit has
// them in two rooms, the newer connection wins and the other room's
// channel is returned so the caller can remove them from it.
func (s *Service) joinedLocked(v seen) (remove id.ID, stale bool) {
	old := s.users[v.userID]
	if old != nil && old.sid == v.sid { // known connection: refresh it
		cam, scr := old.publishing(livekit.TrackSource_CAMERA), old.publishing(livekit.TrackSource_SCREEN_SHARE)
		old.tracks, old.sources = v.tracks, v.sources
		if cam != old.publishing(livekit.TrackSource_CAMERA) || scr != old.publishing(livekit.TrackSource_SCREEN_SHARE) {
			s.publishLocked(v.userID, old)
		}
		return 0, false
	}
	if old != nil && old.channelID != v.channelID && old.joinedAt > v.joinedAt {
		return v.channelID, true // a late report about the older connection
	}
	p := &participant{channelID: v.channelID, sid: v.sid, joinedAt: v.joinedAt, addedAt: time.Now(), tracks: v.tracks, sources: v.sources}
	if old != nil {
		if old.channelID == v.channelID {
			p.self, p.serverMute = old.self, old.serverMute // reconnected
		} else {
			s.publishLeftLocked(v.userID, old.channelID)
			remove, stale = old.channelID, true
		}
	}
	if pj, ok := s.pending[v.userID]; ok {
		p.self = pj.self
		delete(s.pending, v.userID)
	}
	s.users[v.userID] = p
	s.publishLocked(v.userID, p)
	return remove, stale
}

func (s *Service) leftLocked(userID id.ID, sid string) {
	p := s.users[userID]
	if p == nil || p.sid != sid {
		return // about an older connection
	}
	delete(s.users, userID)
	s.publishLeftLocked(userID, p.channelID)
}

func (s *Service) trackLocked(userID id.ID, sid string, t *livekit.TrackInfo, published bool) {
	p := s.users[userID]
	if p == nil || p.sid != sid || t == nil {
		return
	}
	cam, scr := p.publishing(livekit.TrackSource_CAMERA), p.publishing(livekit.TrackSource_SCREEN_SHARE)
	if published {
		p.tracks[t.GetSid()] = t.GetSource()
	} else {
		delete(p.tracks, t.GetSid())
	}
	if cam != p.publishing(livekit.TrackSource_CAMERA) || scr != p.publishing(livekit.TrackSource_SCREEN_SHARE) {
		s.publishLocked(userID, p)
	}
}

// WebhookHandler receives LiveKit's webhooks (spec section 5.3, step 4).
// They are signed with the API secret; anything else is refused.
func (s *Service) WebhookHandler() http.Handler {
	keys := lkauth.NewSimpleKeyProvider(s.cfg.APIKey, s.cfg.APISecret)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ev, err := webhook.ReceiveWebhookEvent(r, keys)
		if err != nil {
			httpx.WriteHTTPError(w, r, httpx.Unauthorized())
			return
		}
		s.handle(r.Context(), ev)
		w.WriteHeader(http.StatusNoContent)
	})
}

func (s *Service) handle(ctx context.Context, ev *livekit.WebhookEvent) {
	if ev.GetRoom() == nil || ev.GetParticipant() == nil {
		return // room events: participants report themselves
	}
	v, ok := fromLiveKit(ev.GetRoom().GetName(), ev.GetParticipant())
	if !ok {
		return
	}
	switch ev.GetEvent() {
	case webhook.EventParticipantJoined:
		s.adopt(ctx, []seen{v})
	case webhook.EventParticipantLeft, webhook.EventParticipantConnectionAborted:
		s.mu.Lock()
		s.leftLocked(v.userID, v.sid)
		s.mu.Unlock()
	case webhook.EventTrackPublished, webhook.EventTrackUnpublished:
		// Only for known connections: a late track event must not bring
		// back someone who left. Sync picks up anything missed.
		s.mu.Lock()
		s.trackLocked(v.userID, v.sid, ev.GetTrack(), ev.GetEvent() == webhook.EventTrackPublished)
		s.mu.Unlock()
	}
}

// Sync rebuilds voice state from LiveKit. Webhooks are the fast path; this
// repairs missed ones and restarts.
func (s *Service) Sync(ctx context.Context) error {
	if !s.cfg.Enabled() {
		return nil
	}
	started := time.Now()
	names, err := s.rooms.List(ctx)
	if err != nil {
		return err
	}
	var all []seen
	for _, name := range names {
		ps, err := s.rooms.Participants(ctx, name)
		if err != nil {
			return err
		}
		for _, p := range ps {
			if v, ok := fromLiveKit(name, p); ok {
				all = append(all, v)
			}
		}
	}
	slices.SortFunc(all, func(a, b seen) int { return cmp.Compare(a.joinedAt, b.joinedAt) })
	live := make(map[string]bool, len(all))
	for _, v := range all {
		live[v.sid] = true
	}
	s.mu.Lock()
	for userID, p := range s.users {
		// Entries added after we asked LiveKit may not be in its answer yet.
		if !live[p.sid] && p.addedAt.Before(started) {
			delete(s.users, userID)
			s.publishLeftLocked(userID, p.channelID)
		}
	}
	for userID, pj := range s.pending {
		if time.Since(pj.at) > TokenTTL { // their token has expired unused
			delete(s.pending, userID)
		}
	}
	s.mu.Unlock()
	s.adopt(ctx, all)
	return nil
}

// SetSelf records a user's own mute and deafen flags (their client does
// the muting; the server only tells others).
func (s *Service) SetSelf(userID id.ID, req SelfStateRequest) error {
	apply := func(f *selfState) {
		if req.SelfMute != nil {
			f.mute = *req.SelfMute
		}
		if req.SelfDeaf != nil {
			f.deaf = *req.SelfDeaf
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.users[userID]; p != nil {
		apply(&p.self)
		s.publishLocked(userID, p)
		return nil
	}
	if pj, ok := s.pending[userID]; ok { // still connecting
		apply(&pj.self)
		s.pending[userID] = pj
		return nil
	}
	return httpx.E(http.StatusConflict, "NOT_IN_VOICE", "you are not in a voice channel")
}

// States lists who is in voice in the given channels.
func (s *Service) States(channelIDs []id.ID) []VoiceState {
	want := make(map[id.ID]bool, len(channelIDs))
	for _, c := range channelIDs {
		want[c] = true
	}
	out := []VoiceState{}
	s.mu.Lock()
	for userID, p := range s.users {
		if want[p.channelID] {
			out = append(out, p.state(userID))
		}
	}
	s.mu.Unlock()
	slices.SortFunc(out, func(a, b VoiceState) int { return cmp.Compare(a.UserID, b.UserID) })
	return out
}
```

- [ ] **Step 4: Self state operation** — in `server/internal/voice/handlers.go`, inside `Register` after `join-voice`:

```go
	huma.Register(api, op("set-voice-state", http.MethodPatch, "/api/voice/state", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body SelfStateRequest }) (*struct{}, error) {
			return nil, s.SetSelf(me(ctx).ID, in.Body)
		})
```

- [ ] **Step 5: Wire webhooks, background sync and READY**

In `server/internal/app/app.go`, replace the Task 2 block

```go
	if pool != nil { // nil only for `datrope openapi`
		a.Voice = voiceSvc
	}
```

with

```go
	if pool != nil { // nil only for `datrope openapi`
		if cfg.LiveKit.Enabled() {
			// LiveKit signs its webhooks; there is no session to check.
			mux.Handle("POST /api/voice/webhook", voiceSvc.WebhookHandler())
		}
		voiceSvc.Start()
		a.closers = append(a.closers, voiceSvc.Close)
		a.Voice = voiceSvc
	}
```

and pass voice to the READY builder:

```go
			Ready:        readyBuilder{communities: commSvc, channels: chanSvc, messages: msgSvc, voice: voiceSvc},
```

In `server/internal/app/realtime.go`, import `"github.com/datrope/datrope/server/internal/voice"`, add to `Ready` after `ReadStates`:

```go
	VoiceStates []voice.VoiceState       `json:"voice_states" doc:"Who is in voice, in channels and DMs the user can see"`
```

add `voice *voice.Service` to `readyBuilder`, and in `Build`, after the `ReadStates` lookup and before `return r, nil`:

```go
	r.VoiceStates = b.voice.States(channelIDs)
```

Finally add `voice.VoiceState{}` to the list in `registerEventSchemas` (after `files.Attachment{}`).

- [ ] **Step 6: Run the tests**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server mod tidy` (the tests import `protojson` and `pion/webrtc` directly), then `go -C server test ./internal/voice/ ./internal/app/ ./internal/gateway/ -v -run 'Webhook|Voice|Sync|OneVoice|OpenAPI|Ready'` and `go -C server test -p 2 ./...`
Expected: PASS.

- [ ] **Step 7: Vet and format** — `gofmt -l server` (no output), `go -C server vet ./...` (clean).

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(voice): voice state from LiveKit webhooks and sync, VOICE_STATE_UPDATE, READY voice states`

---
### Task 4: Permission enforcement and moderation

**Files:**
- Create: `server/internal/voice/reconcile.go`
- Modify: `server/internal/voice/voice.go` (fields, `NewService`, `run`, `adopt`)
- Modify: `server/internal/voice/handlers.go` (moderation operations)
- Modify: `server/internal/app/realtime.go` (`VoiceMove` schema), `server/internal/app/app_test.go`
- Test: `server/internal/voice/reconcile_test.go`

**Interfaces:**
- Consumes: Task 3's `participant`, `s.mu`, `s.users`, `publishLocked`, `publishLeftLocked`, `adopt`, `run`, `Sync`; `events.SessionsRevoked`/`events.SessionsRevokedData` (existing: `SessionIDs == nil` means every session of the user).
- Produces: `(*Service).Reconcile(ctx) error`; `SetServerMute(ctx, callerID, userID id.ID, muted bool) error`; `Disconnect(ctx, callerID, userID id.ID) error`; `Move(ctx, callerID, userID, to id.ID) error`; request types `ServerMuteRequest{Muted bool}` (JSON `muted`), `MoveRequest{ChannelID id.ID}` (JSON `channel_id`); gateway event `VOICE_MOVE` with `voice.VoiceMove{ChannelID id.ID}` (JSON `channel_id`), sent only to the moved user; operations `server-mute-voice-member` = `POST /api/voice/members/{userID}/mute` (204), `move-voice-member` = `POST /api/voice/members/{userID}/move` (204), `disconnect-voice-member` = `DELETE /api/voice/members/{userID}` (204). Errors: `404 NOT_FOUND` (user not in voice / channel not visible), `403 MISSING_PERMISSION`, `400 NOT_VOICE_CHANNEL`.

- [ ] **Step 1: Write the failing tests** — `server/internal/voice/reconcile_test.go`

```go
package voice_test

import (
	"context"
	"net/http"
	"slices"
	"testing"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

// enter joins over REST, connects to LiveKit and syncs, so the server knows
// the user is in the channel.
func enter(t *testing.T, env *apptest.Env, cfg voice.Config, c *apptest.Client, channelID id.ID) *lksdk.Room {
	t.Helper()
	room := lktest.Connect(t, cfg, join(c, channelID).Token)
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	return room
}

// sourcesOf is what LiveKit lets a user publish in a channel's room (nil if absent).
func sourcesOf(cfg voice.Config, channelID, userID id.ID) []livekit.TrackSource {
	ps, err := voice.NewRooms(cfg).Participants(context.Background(), channelID.String())
	if err != nil {
		return nil
	}
	for _, p := range ps {
		if p.Identity == userID.String() {
			return p.GetPermission().GetCanPublishSources()
		}
	}
	return nil
}

// gone reports whether LiveKit no longer has the user in the channel's room.
func gone(cfg voice.Config, channelID, userID id.ID) func() bool {
	return func() bool {
		ps, err := voice.NewRooms(cfg).Participants(context.Background(), channelID.String())
		if err != nil {
			return false
		}
		return !slices.ContainsFunc(ps, func(p *livekit.ParticipantInfo) bool { return p.Identity == userID.String() })
	}
}

func publishes(cfg voice.Config, channelID, userID id.ID, want ...livekit.TrackSource) func() bool {
	return func() bool { return slices.Equal(sourcesOf(cfg, channelID, userID), want) }
}

func memberPath(userID id.ID) string { return "/api/voice/members/" + userID.String() }

func TestKickRemovesFromVoice(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	require.Equal(t, c.voiceID, *nextState(t, ws, bob).ChannelID)

	c.owner.Do(http.MethodDelete, "/api/communities/"+c.community.ID.String()+"/members/"+bob.String(), nil, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)
	require.Nil(t, nextState(t, ws, bob).ChannelID)
}

func TestBanRemovesFromVoice(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	c.owner.Do(http.MethodPut, "/api/communities/"+c.community.ID.String()+"/bans/"+bob.String(), map[string]any{}, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)
}

func TestPermissionChangesReachLiveKit(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	require.True(t, publishes(cfg, c.voiceID, bob, mic, camera, screen, sound)())

	setEveryone(c.owner, c.community.ID, perms.Default&^perms.Speak)
	require.Eventually(t, publishes(cfg, c.voiceID, bob, camera, screen, sound), settle, poll, "losing SPEAK takes the microphone")

	setEveryone(c.owner, c.community.ID, perms.Default)
	require.Eventually(t, publishes(cfg, c.voiceID, bob, mic, camera, screen, sound), settle, poll, "getting it back restores it")

	deny(c.owner, c.voiceID, c.community.ID, perms.ConnectVoice)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll, "losing CONNECT_VOICE removes them")
}

func TestDeletingChannelClosesRoom(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	enter(t, env, cfg, c.member, c.voiceID)
	c.owner.Do(http.MethodDelete, "/api/channels/"+c.voiceID.String(), nil, http.StatusNoContent, nil)
	require.Eventually(t, func() bool {
		names, err := voice.NewRooms(cfg).List(context.Background())
		return err == nil && !slices.Contains(names, c.voiceID.String())
	}, settle, poll)
}

func TestSignedOutEverywhereLeavesVoice(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	c.owner.Do(http.MethodPut, "/api/admin/users/"+bob.String()+"/disabled", map[string]any{"disabled": true}, http.StatusOK, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)
}

func TestServerMute(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	ws, _ := c.owner.Connect()
	alice, bob := c.owner.User.ID, c.member.User.ID
	mute := func(as *apptest.Client, who id.ID, muted bool, want int) {
		t.Helper()
		as.Do(http.MethodPost, memberPath(who)+"/mute", map[string]any{"muted": muted}, want, nil)
	}

	c.owner.Fail(http.MethodPost, memberPath(bob)+"/mute", map[string]any{"muted": true}, http.StatusNotFound, "NOT_FOUND")
	enter(t, env, cfg, c.member, c.voiceID)
	enter(t, env, cfg, c.owner, c.voiceID)
	c.member.Fail(http.MethodPost, memberPath(alice)+"/mute", map[string]any{"muted": true}, http.StatusForbidden, "MISSING_PERMISSION")

	mute(c.owner, bob, true, http.StatusNoContent)
	for !nextState(t, ws, bob).ServerMute { // skip the updates from joining
	}
	require.Eventually(t, publishes(cfg, c.voiceID, bob, camera, screen, sound), settle, poll)
	g := grants(t, cfg, join(c.member, c.voiceID).Token)
	require.False(t, g.Video.GetCanPublishSource(mic), "rejoining the same channel keeps the server mute")

	mute(c.owner, bob, false, http.StatusNoContent)
	require.Eventually(t, publishes(cfg, c.voiceID, bob, mic, camera, screen, sound), settle, poll)
}

func TestDisconnectAndMove(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	games := createVoice(c.owner, c.community.ID, "Games")
	alice, bob := c.owner.User.ID, c.member.User.ID
	bobWS, _ := c.member.Connect()
	enter(t, env, cfg, c.member, c.voiceID)
	enter(t, env, cfg, c.owner, c.voiceID)

	c.member.Fail(http.MethodDelete, memberPath(alice), nil, http.StatusForbidden, "MISSING_PERMISSION")
	c.member.Fail(http.MethodPost, memberPath(alice)+"/move", map[string]any{"channel_id": games}, http.StatusForbidden, "MISSING_PERMISSION")
	c.owner.Fail(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": c.textID}, http.StatusBadRequest, "NOT_VOICE_CHANNEL")

	c.owner.Do(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": games}, http.StatusNoContent, nil)
	var mv voice.VoiceMove
	bobWS.ExpectDispatch("VOICE_MOVE", &mv)
	require.Equal(t, games, mv.ChannelID, "bob's clients are told to switch")

	deny(c.owner, games, c.community.ID, perms.ConnectVoice)
	c.owner.Fail(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": games}, http.StatusForbidden, "MISSING_PERMISSION")

	c.owner.Do(http.MethodDelete, memberPath(bob), nil, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)

	c.owner.Do(http.MethodDelete, memberPath(alice), nil, http.StatusNoContent, nil) // leaving needs no permission
	require.Eventually(t, gone(cfg, c.voiceID, alice), settle, poll)
	c.owner.Fail(http.MethodDelete, memberPath(alice), nil, http.StatusNotFound, "NOT_FOUND")
}
```

In `server/internal/app/app_test.go`, add `"VoiceMove"` to the schema names in `TestOpenAPIHasEventSchemas`.

- [ ] **Step 2: Run the tests to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/ -run 'Kick|Ban|Permission|Deleting|SignedOut|ServerMute|Disconnect'`
Expected: FAIL to compile — `voice.VoiceMove` is undefined. (After adding only the type, the tests would fail on the 405/404 responses and on participants never leaving LiveKit.)

- [ ] **Step 3: Write `server/internal/voice/reconcile.go`**

```go
package voice

import (
	"context"
	"errors"
	"net/http"
	"slices"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type ServerMuteRequest struct {
	Muted bool `json:"muted"`
}

type MoveRequest struct {
	ChannelID id.ID `json:"channel_id"`
}

// VoiceMove asks a user's clients to re-join voice in another channel.
// Only that user receives it.
type VoiceMove struct {
	ChannelID id.ID `json:"channel_id"`
}

// permissionEvents can change what someone may do in voice.
var permissionEvents = map[string]bool{
	"MEMBER_REMOVE": true, "MEMBER_UPDATE": true, "ROLE_UPDATE": true, "ROLE_DELETE": true,
	"CHANNEL_UPDATE": true, "CHANNEL_DELETE": true, "COMMUNITY_DELETE": true,
}

// onEvent runs inside bus.Publish: it must not block or call LiveKit. It
// only takes outMu, never mu (voice publishes while holding mu).
func (s *Service) onEvent(e events.Event) {
	switch {
	case permissionEvents[e.Type]:
		s.wake()
	case e.Type == events.SessionsRevoked:
		if d, ok := e.Data.(events.SessionsRevokedData); ok && d.SessionIDs == nil { // signed out everywhere
			s.outMu.Lock()
			s.signedOut[d.UserID] = true
			s.outMu.Unlock()
			s.wake()
		}
	}
}

// wake asks the background loop to reconcile soon.
func (s *Service) wake() {
	select {
	case s.poke <- struct{}{}:
	default: // one is already due
	}
}

// Reconcile applies everyone's current permissions to their LiveKit
// connection (spec section 5.3, step 5). Users who may no longer connect
// are removed; everyone else may publish exactly what their permissions
// and any server mute allow.
func (s *Service) Reconcile(ctx context.Context) error {
	s.outMu.Lock()
	out := s.signedOut
	s.signedOut = map[id.ID]bool{}
	s.outMu.Unlock()

	s.mu.Lock()
	users := make([]id.ID, 0, len(s.users))
	for u := range s.users {
		users = append(users, u)
	}
	s.mu.Unlock()

	var errs []error
	for _, u := range users {
		errs = append(errs, s.reconcileUser(ctx, u, out[u]))
	}
	return errors.Join(errs...)
}

// reconcileUser brings one user's connection in line with their
// permissions; force removes them whatever their permissions.
func (s *Service) reconcileUser(ctx context.Context, userID id.ID, force bool) error {
	s.mu.Lock()
	p := s.users[userID]
	if p == nil {
		s.mu.Unlock()
		return nil
	}
	channelID, serverMute, have := p.channelID, p.serverMute, p.sources
	s.mu.Unlock()

	allowed, _, err := s.channels.Perms(ctx, userID, channelID)
	gone := errors.Is(err, channels.ErrNotFound)
	if err != nil && !gone {
		return err
	}
	if force || gone || !allowed.Has(perms.ConnectVoice) {
		err := s.disconnect(ctx, userID, channelID)
		if gone { // the channel was deleted: close its room
			err = errors.Join(err, s.rooms.Delete(ctx, channelID))
		}
		return err
	}
	want := Sources(allowed, serverMute)
	if slices.Equal(want, have) {
		return nil
	}
	if err := s.rooms.SetSources(ctx, channelID, userID, want); err != nil {
		return err
	}
	s.mu.Lock()
	if p := s.users[userID]; p != nil && p.channelID == channelID {
		p.sources = want
	}
	s.mu.Unlock()
	return nil
}

// disconnect takes a user out of a channel's voice: out of the LiveKit
// room and out of voice state.
func (s *Service) disconnect(ctx context.Context, userID, channelID id.ID) error {
	s.mu.Lock()
	if p := s.users[userID]; p != nil && p.channelID == channelID {
		delete(s.users, userID)
		s.publishLeftLocked(userID, channelID)
	}
	s.mu.Unlock()
	return s.rooms.Remove(ctx, channelID, userID)
}

// inVoice returns the channel a user is in, after checking the caller
// holds need there.
func (s *Service) inVoice(ctx context.Context, callerID, userID id.ID, need perms.Perms) (id.ID, error) {
	s.mu.Lock()
	p := s.users[userID]
	s.mu.Unlock()
	if p == nil {
		return 0, httpx.NotFound("voice member")
	}
	if _, _, err := s.channels.Access(ctx, callerID, p.channelID, need); err != nil {
		return 0, err
	}
	return p.channelID, nil
}

// SetServerMute mutes or unmutes a member's microphone for as long as they
// stay in their channel (MUTE_MEMBERS).
func (s *Service) SetServerMute(ctx context.Context, callerID, userID id.ID, muted bool) error {
	channelID, err := s.inVoice(ctx, callerID, userID, perms.MuteMembers)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if p := s.users[userID]; p != nil && p.channelID == channelID && p.serverMute != muted {
		p.serverMute = muted
		s.publishLocked(userID, p)
	}
	s.mu.Unlock()
	return s.reconcileUser(ctx, userID, false)
}

// Disconnect takes a member out of voice (MOVE_MEMBERS); anyone may
// disconnect themselves.
func (s *Service) Disconnect(ctx context.Context, callerID, userID id.ID) error {
	need := perms.MoveMembers
	if callerID == userID {
		need = 0
	}
	channelID, err := s.inVoice(ctx, callerID, userID, need)
	if err != nil {
		return err
	}
	return s.disconnect(ctx, userID, channelID)
}

// Move sends a member to another voice channel (MOVE_MEMBERS in both).
// LiveKit's open-source server cannot move participants, so the member's
// clients are told to re-join there; the usual join checks apply.
func (s *Service) Move(ctx context.Context, callerID, userID, to id.ID) error {
	from, err := s.inVoice(ctx, callerID, userID, perms.MoveMembers)
	if err != nil {
		return err
	}
	c, _, err := s.channels.Access(ctx, callerID, to, perms.MoveMembers)
	if err != nil {
		return err
	}
	if c.Type != channels.TypeVoice {
		return httpx.BadRequest("NOT_VOICE_CHANNEL", "members can only be moved to voice channels")
	}
	if from == to {
		return nil
	}
	theirs, _, err := s.channels.Perms(ctx, userID, to)
	if err != nil {
		return err
	}
	if !theirs.Has(perms.ConnectVoice) {
		return httpx.E(http.StatusForbidden, "MISSING_PERMISSION", "that member cannot connect to that channel")
	}
	s.bus.Publish(events.Event{Type: "VOICE_MOVE", Data: VoiceMove{ChannelID: to}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	return nil
}
```

- [ ] **Step 4: Hook it into the service** — in `server/internal/voice/voice.go`:

Add to `Service`, after `pending`:

```go
	poke      chan struct{} // asks the background loop to reconcile
	outMu     sync.Mutex    // guards signedOut (see onEvent)
	signedOut map[id.ID]bool
```

In `NewService`, initialise them and subscribe (replace the `s := &Service{...}` literal and add the subscription before `return s`):

```go
	s := &Service{
		cfg: cfg, bus: bus, channels: ch,
		users: map[id.ID]*participant{}, pending: map[id.ID]pendingJoin{},
		poke: make(chan struct{}, 1), signedOut: map[id.ID]bool{},
		ctx: ctx, cancel: cancel,
	}
	if cfg.Enabled() {
		s.rooms = NewRooms(cfg)
	}
	bus.Subscribe(s.onEvent)
	return s
```

Replace `run` with:

```go
func (s *Service) run() {
	defer s.wg.Done()
	tick := time.NewTicker(syncInterval)
	defer tick.Stop()
	s.refresh(true)
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
			s.refresh(true)
		case <-s.poke:
			s.refresh(false)
		}
	}
}

// refresh optionally re-reads LiveKit, then enforces permissions.
func (s *Service) refresh(sync bool) {
	if sync {
		if err := s.Sync(s.ctx); err != nil && s.ctx.Err() == nil {
			slog.Error("voice: sync with livekit", "err", err)
		}
	}
	if err := s.Reconcile(s.ctx); err != nil && s.ctx.Err() == nil {
		slog.Error("voice: apply permissions", "err", err)
	}
}
```

At the end of `adopt` (after the removals loop) add `s.wake()`, so someone who connected with a token issued before they lost a permission is checked right away.

- [ ] **Step 5: Moderation operations** — in `server/internal/voice/handlers.go`, inside `Register`:

```go
	huma.Register(api, op("server-mute-voice-member", http.MethodPost, "/api/voice/members/{userID}/mute", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
			Body   ServerMuteRequest
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.SetServerMute(ctx, me(ctx).ID, uid, in.Body.Muted)
		})

	huma.Register(api, op("move-voice-member", http.MethodPost, "/api/voice/members/{userID}/move", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
			Body   MoveRequest
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.Move(ctx, me(ctx).ID, uid, in.Body.ChannelID)
		})

	huma.Register(api, op("disconnect-voice-member", http.MethodDelete, "/api/voice/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.Disconnect(ctx, me(ctx).ID, uid)
		})
```

In `server/internal/app/realtime.go`, add `voice.VoiceMove{}` to `registerEventSchemas` after `voice.VoiceState{}`.

- [ ] **Step 6: Run the tests**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; go -C server test ./internal/voice/ ./internal/app/ -v` then `go -C server test -p 2 ./...`
Expected: PASS.

- [ ] **Step 7: Vet and format** — `gofmt -l server` (no output), `go -C server vet ./...` (clean).

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(voice): enforce permission changes in LiveKit; server mute, disconnect and move`

---
### Task 5: Voice in the TypeScript client

**Files:**
- Modify (regenerate): `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/types.ts`, `clients/core/src/store.ts`, `clients/core/src/client.ts`
- Test: `clients/core/src/store.test.ts`, `clients/core/src/client.test.ts`

**Interfaces:**
- Consumes: the API from Tasks 2–4 (`POST /api/voice/{id}/join` → `{url, token}`, `PATCH /api/voice/state`, `POST /api/voice/members/{userID}/mute`, `POST /api/voice/members/{userID}/move`, `DELETE /api/voice/members/{userID}`), `Ready.voice_states`, events `VOICE_STATE_UPDATE` and `VOICE_MOVE`.
- Produces: types `VoiceState`, `VoiceMove`, `JoinVoiceResponse`; `EventMap` entries `VOICE_STATE_UPDATE`, `VOICE_MOVE`; `State.voice: Record<string, VoiceState>` (by user ID; only users currently in voice); `voiceMembers(s: State, channelId: string): VoiceState[]`; `DatropeClient` methods `onEvent(fn: (type: string, data: unknown) => void): () => void`, `joinVoice(channelId, self: { self_mute: boolean; self_deaf: boolean }): Promise<JoinVoiceResponse>`, `setVoiceSelf(patch: { self_mute?: boolean; self_deaf?: boolean }): Promise<void>`, `serverMute(userId, muted): Promise<void>`, `moveVoice(userId, channelId): Promise<void>`, `disconnectVoice(userId): Promise<void>`.

- [ ] **Step 1: Regenerate the API types**

Run: `GOTOOLCHAIN=local pnpm --filter @datrope/core gen`
Expected: `openapi.json` and `src/schema.d.ts` gain `VoiceState`, `VoiceMove`, `JoinRequest`, `JoinResponse`, `SelfStateRequest`, `ServerMuteRequest`, `MoveRequest`, the five `/api/voice/...` operations, and `Ready.voice_states`. Check in `schema.d.ts` how `Ready.voice_states` and `VoiceState.channel_id` are typed (expected: `voice_states: components["schemas"]["VoiceState"][] | null` and `channel_id?: string`); the code below assumes that.

- [ ] **Step 2: Write the failing tests**

In `clients/core/src/store.test.ts`: add `voice_states: []` to the `ready` fixture, import `voiceMembers` from `./store` and `VoiceState` from `./types`, and add inside `describe("store", ...)`:

```ts
  it("tracks who is in voice", () => {
    const inLounge: VoiceState = {
      user_id: "2", channel_id: "301", self_mute: false, self_deaf: false, server_mute: false, camera: false, screen: false,
    };
    let s = applyReady(initialState, { ...ready, voice_states: [inLounge] });
    expect(voiceMembers(s, "301")).toEqual([inLounge]);
    expect(voiceMembers(s, "300")).toEqual([]);

    s = applyEvent(s, "VOICE_STATE_UPDATE", { ...inLounge, self_mute: true });
    expect(voiceMembers(s, "301")[0].self_mute).toBe(true);

    s = applyEvent(s, "VOICE_STATE_UPDATE", { user_id: "2", self_mute: false, self_deaf: false, server_mute: false, camera: false, screen: false });
    expect(voiceMembers(s, "301")).toEqual([]); // no channel_id: left voice
    expect(s.voice).toEqual({});
  });

  it("forgets voice states of a deleted channel", () => {
    const inGeneral: VoiceState = {
      user_id: "2", channel_id: "300", self_mute: false, self_deaf: false, server_mute: false, camera: true, screen: false,
    };
    let s = applyReady(initialState, { ...ready, voice_states: [inGeneral] });
    s = applyEvent(s, "CHANNEL_DELETE", { id: "300", community_id: "100" });
    expect(s.voice).toEqual({});
  });
```

In `clients/core/src/client.test.ts`: add `voice_states: []` to the `ready` fixture and add:

```ts
it("joins voice, reports its own state and moderates", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const record = async ({ request }: { request: Request }) => {
    const text = await request.text();
    calls.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined });
  };
  server.use(
    http.post(`${BASE}/api/voice/:id/join`, async (info) => {
      await record(info);
      return HttpResponse.json({ url: "wss://lk.test", token: "tok" });
    }),
    http.patch(`${BASE}/api/voice/state`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.post(`${BASE}/api/voice/members/:id/mute`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.post(`${BASE}/api/voice/members/:id/move`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
    http.delete(`${BASE}/api/voice/members/:id`, async (info) => { await record(info); return new HttpResponse(null, { status: 204 }); }),
  );
  const client = readyClient();
  expect(await client.joinVoice("301", { self_mute: true, self_deaf: false })).toEqual({ url: "wss://lk.test", token: "tok" });
  await client.setVoiceSelf({ self_deaf: true });
  await client.serverMute("2", true);
  await client.moveVoice("2", "302");
  await client.disconnectVoice("2");
  expect(calls).toEqual([
    { method: "POST", path: "/api/voice/301/join", body: { self_mute: true, self_deaf: false } },
    { method: "PATCH", path: "/api/voice/state", body: { self_deaf: true } },
    { method: "POST", path: "/api/voice/members/2/mute", body: { muted: true } },
    { method: "POST", path: "/api/voice/members/2/move", body: { channel_id: "302" } },
    { method: "DELETE", path: "/api/voice/members/2", body: undefined },
  ]);
});

it("maps VOICE_UNAVAILABLE to an ApiError", async () => {
  server.use(http.post(`${BASE}/api/voice/:id/join`, () =>
    HttpResponse.json({ code: "VOICE_UNAVAILABLE", message: "the voice server is unreachable" }, { status: 503 })));
  const err = await readyClient().joinVoice("301", { self_mute: false, self_deaf: false }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("VOICE_UNAVAILABLE");
});

it("tells listeners about every applied event", () => {
  const client = readyClient();
  const seen: string[] = [];
  const off = client.onEvent((type) => seen.push(type));
  client.apply("VOICE_MOVE", { channel_id: "302" });
  off();
  client.apply("VOICE_MOVE", { channel_id: "303" });
  expect(seen).toEqual(["VOICE_MOVE"]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @datrope/core test`
Expected: FAIL — `voiceMembers`, `joinVoice` and `onEvent` do not exist.

- [ ] **Step 4: Types** — in `clients/core/src/types.ts`, after `export type Ban = ...`:

```ts
export type VoiceState = Schemas["VoiceState"];
export type VoiceMove = Schemas["VoiceMove"];
export type JoinVoiceResponse = Schemas["JoinResponse"];
```

and add to `EventMap`:

```ts
  VOICE_STATE_UPDATE: VoiceState;
  VOICE_MOVE: VoiceMove;
```

- [ ] **Step 5: Store** — in `clients/core/src/store.ts`:

Import `VoiceState` with the other types. Add to `State` (after `presence`):

```ts
  voice: Record<string, VoiceState>; // by user ID: who is in voice, in channels I can see
```

and `voice: {},` to `initialState`. In `applyReady`, add to the returned object:

```ts
    voice: byKey(r.voice_states ?? [], (v) => v.user_id),
```

In `removeChannel`, drop that channel's voice states — replace

```ts
  let next: State = { ...s, channels, messages, dmIds: s.dmIds.filter((x) => x !== id) };
```

with

```ts
  const voice = Object.fromEntries(Object.entries(s.voice).filter(([, v]) => v.channel_id !== id));
  let next: State = { ...s, channels, messages, voice, dmIds: s.dmIds.filter((x) => x !== id) };
```

In `applyEvent`, add before `default:`:

```ts
    case "VOICE_STATE_UPDATE": {
      const v = data as VoiceState;
      const voice = { ...s.voice };
      if (v.channel_id) voice[v.user_id] = v;
      else delete voice[v.user_id]; // left voice
      return { ...s, voice };
    }
```

and export, after `expireTyping`:

```ts
/** Who is in a channel's voice, in a stable order. Returns a new array: select it with useShallow. */
export function voiceMembers(s: State, channelId: string): VoiceState[] {
  return Object.values(s.voice).filter((v) => v.channel_id === channelId).sort((a, b) => compareIds(a.user_id, b.user_id));
}
```

- [ ] **Step 6: Client** — in `clients/core/src/client.ts`:

Import `JoinVoiceResponse` with the other types. Add a field after `lastTyping`:

```ts
  private listeners = new Set<(type: string, data: unknown) => void>();
```

Replace `apply` with:

```ts
  apply(type: string, data: unknown) {
    this.set((s) => applyEvent(s, type, data));
    for (const fn of this.listeners) fn(type, data);
    void this.follow(type, data);
  }

  /** Calls fn for every event applied (see apply). Returns a function that stops it. */
  onEvent(fn: (type: string, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
```

and add, after `typing`:

```ts
  /** Asks to join a channel's (or DM's) voice; connect to LiveKit with the answer. */
  async joinVoice(channelId: string, self: { self_mute: boolean; self_deaf: boolean }): Promise<JoinVoiceResponse> {
    return unwrap(this.api.POST("/api/voice/{id}/join", { params: { path: { id: channelId } }, body: self }));
  }

  /** Tells others I muted or deafened myself (the muting itself happens locally). */
  async setVoiceSelf(patch: { self_mute?: boolean; self_deaf?: boolean }) {
    await unwrap(this.api.PATCH("/api/voice/state", { body: patch }));
  }

  async serverMute(userId: string, muted: boolean) {
    await unwrap(this.api.POST("/api/voice/members/{userID}/mute", { params: { path: { userID: userId } }, body: { muted } }));
  }

  async moveVoice(userId: string, channelId: string) {
    await unwrap(this.api.POST("/api/voice/members/{userID}/move", {
      params: { path: { userID: userId } }, body: { channel_id: channelId },
    }));
  }

  /** Takes a member (or myself) out of voice. */
  async disconnectVoice(userId: string) {
    await unwrap(this.api.DELETE("/api/voice/members/{userID}", { params: { path: { userID: userId } } }));
  }
```

- [ ] **Step 7: Run the tests and checks**

Run: `pnpm --filter @datrope/core test` (PASS), `pnpm typecheck` (PASS — fix any other `Ready` fixture or web code that now misses `voice_states`/`voice` by adding the field, and record it), `pnpm lint` (clean).

- [ ] **Step 8: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(core): voice state, voice API calls and event listeners`

---
### Task 6: Web voice engine

**Files:**
- Modify: `clients/web/package.json`, `pnpm-lock.yaml` (add `livekit-client`)
- Create: `clients/web/src/voice/voice.ts`
- Modify: `clients/web/src/session.ts` (`permsIn`)
- Modify: `clients/web/vite.config.ts` (proxy `/livekit` in development)

**Interfaces:**
- Consumes: Task 5's `client.joinVoice`, `client.setVoiceSelf`, `client.onEvent`, `VoiceState`; events `VOICE_MOVE`, `VOICE_STATE_UPDATE`; `Perm`, `hasPerm`, `channelPerms`, `DM_PERMS` from `@datrope/core`.
- Produces (used by Task 7): `permsIn(s: State, channelId: string): number` in `session.ts`; in `voice/voice.ts`: `type VideoSource = "camera" | "screen"`, `interface VideoTile { id; userId; source; local; track?: LocalVideoTrack | RemoteVideoTrack }`, `interface VoiceView { channelId?; status: "idle" | "connecting" | "connected" | "reconnecting"; error?; muted; deafened; camera; screen; speaking: string[]; tiles: VideoTile[]; watching: string[]; audioBlocked: boolean }`, `const voice` with `join(channelId)`, `leave()`, `dismiss()`, `setMuted(b)`, `setDeafened(b)`, `toggleCamera()`, `toggleScreen()`, `watch(userId, on)`, `startAudio()`, `store`; hook `useVoice<T>(selector: (v: VoiceView) => T): T`.

There is no unit-test runner for the web app; this task is verified by type-checking, building and linting, and end to end by Task 8's Playwright test.

- [ ] **Step 1: Add the dependency**

Run: `pnpm --filter @datrope/web add livekit-client@2.22.3`
Expected: `clients/web/package.json` lists `"livekit-client": "2.22.3"` (pin it exactly: edit away a `^` if pnpm adds one) and `pnpm-lock.yaml` is updated.

- [ ] **Step 2: `permsIn`** — in `clients/web/src/session.ts`, after `usePerms`:

```ts
/** My permissions in a channel or DM, read from the current state (for code outside React). */
export function permsIn(s: State, channelId: string): number {
  const ch = s.channels[channelId];
  if (!ch) return 0;
  if (ch.type === "dm") return DM_PERMS;
  const cs = ch.community_id ? s.communities[ch.community_id] : undefined;
  if (!cs || !s.me) return 0;
  return channelPerms(cs.community, Object.values(cs.roles), s.me.id, cs.members[s.me.id]?.role_ids ?? [], ch);
}
```

- [ ] **Step 3: Write `clients/web/src/voice/voice.ts`**

```ts
import { ApiError, Perm, hasPerm, type VoiceState } from "@datrope/core";
import {
  DisconnectReason, Room, RoomEvent, Track,
  type LocalVideoTrack, type Participant, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication,
  type RemoteVideoTrack,
} from "livekit-client";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { client, permsIn } from "../session";

export type VideoSource = "camera" | "screen";

/** A camera or a screen share in the call. */
export interface VideoTile {
  id: string; // `${userId}:${source}`
  userId: string;
  source: VideoSource;
  local: boolean;
  track?: LocalVideoTrack | RemoteVideoTrack; // missing until subscribed (screen shares: until "watch")
}

export interface VoiceView {
  channelId?: string;
  status: "idle" | "connecting" | "connected" | "reconnecting";
  error?: string;
  muted: boolean; // my choice, kept between calls
  deafened: boolean; // my choice, kept between calls
  camera: boolean;
  screen: boolean;
  speaking: string[]; // user IDs
  tiles: VideoTile[];
  watching: string[]; // user IDs whose screen share I receive
  audioBlocked: boolean; // the browser wants a click before it plays sound
}

const idle: Omit<VoiceView, "muted" | "deafened"> = {
  channelId: undefined, status: "idle", error: undefined, camera: false, screen: false,
  speaking: [], tiles: [], watching: [], audioBlocked: false,
};

const SCREEN: Track.Source[] = [Track.Source.ScreenShare, Track.Source.ScreenShareAudio];

const goodbye: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.PARTICIPANT_REMOVED]: "You were disconnected from voice.",
  [DisconnectReason.DUPLICATE_IDENTITY]: "You joined voice somewhere else.",
  [DisconnectReason.ROOM_DELETED]: "The voice channel was closed.",
};

/** Connects this browser to one channel's LiveKit room at a time. */
class Voice {
  readonly store = createStore<VoiceView>(() => ({ ...idle, muted: false, deafened: false }));
  private room?: Room;
  private audio = new Set<HTMLMediaElement>(); // remote sound being played
  private mutedBeforeDeafen = false;
  private serverMuted = false;

  constructor() {
    client.onEvent((type, data) => {
      if (type === "VOICE_MOVE" && this.store.getState().status !== "idle") {
        void this.join((data as { channel_id: string }).channel_id); // a moderator moved me
      } else if (type === "VOICE_STATE_UPDATE" && (data as VoiceState).user_id === client.store.getState().me?.id) {
        const muted = (data as VoiceState).server_mute;
        const unmuted = this.serverMuted && !muted;
        this.serverMuted = muted;
        if (unmuted) void this.applyMic(); // the microphone is allowed again
      }
    });
  }

  private set(patch: Partial<VoiceView>) {
    this.store.setState(patch);
  }

  /** Joins a channel's or DM's voice, leaving any other. */
  async join(channelId: string) {
    const prev = this.store.getState();
    if (prev.channelId === channelId && prev.status !== "idle") return;
    this.disconnect();
    const room = new Room({ adaptiveStream: true, dynacast: true, publishDefaults: { simulcast: true } });
    this.room = room;
    this.set({ ...idle, channelId, status: "connecting" });
    try {
      const { url, token } = await client.joinVoice(channelId, { self_mute: prev.muted, self_deaf: prev.deafened });
      if (this.room !== room) return; // left or switched meanwhile
      this.listen(room);
      await room.connect(url, token, { autoSubscribe: false });
      if (this.room !== room) return;
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) this.autoSubscribe(pub, p);
      }
      const mine = client.store.getState().voice[client.store.getState().me?.id ?? ""];
      this.serverMuted = mine?.channel_id === channelId && mine.server_mute;
      this.set({ status: "connected", audioBlocked: !room.canPlaybackAudio });
      await this.applyMic();
      this.refresh();
    } catch (e) {
      if (this.room !== room) return;
      this.disconnect();
      this.set({ error: e instanceof ApiError ? e.message : "Could not connect to voice." });
    }
  }

  /** Leaves voice. Mute and deafen stay as they are for the next call. */
  leave() {
    this.disconnect();
  }

  /** Forgets the last error message. */
  dismiss() {
    this.set({ error: undefined });
  }

  private disconnect() {
    const room = this.room;
    this.room = undefined;
    for (const el of this.audio) el.remove();
    this.audio.clear();
    this.serverMuted = false;
    this.set({ ...idle });
    void room?.disconnect();
  }

  private listen(room: Room) {
    const mine = () => this.room === room;
    const refresh = () => {
      if (mine()) this.refresh();
    };
    room
      .on(RoomEvent.TrackPublished, (pub, p) => {
        if (!mine()) return;
        this.autoSubscribe(pub, p);
        this.refresh();
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (!mine()) return;
        if (track.kind === Track.Kind.Audio) this.play(track);
        this.refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        if (!mine()) return;
        this.stop(track);
        this.refresh();
      })
      .on(RoomEvent.TrackUnpublished, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
        if (mine()) this.set({ speaking: speakers.map((p) => p.identity) });
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (mine()) this.set({ audioBlocked: !room.canPlaybackAudio });
      })
      .on(RoomEvent.Reconnecting, () => {
        if (mine()) this.set({ status: "reconnecting" });
      })
      .on(RoomEvent.Reconnected, () => {
        if (mine()) this.set({ status: "connected" });
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        if (!mine()) return; // we left on purpose
        this.disconnect();
        this.set({ error: (reason !== undefined && goodbye[reason]) || "The voice connection was lost." });
      });
  }

  /** Microphones and cameras play at once; screen shares only after "watch" (spec section 5.4). */
  private autoSubscribe(pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (!SCREEN.includes(pub.source) || this.store.getState().watching.includes(p.identity)) pub.setSubscribed(true);
  }

  private play(track: RemoteTrack) {
    const el = track.attach();
    el.muted = this.store.getState().deafened;
    this.audio.add(el);
    document.body.append(el);
  }

  private stop(track: RemoteTrack) {
    for (const el of track.detach()) {
      this.audio.delete(el);
      el.remove();
    }
  }

  /** Rebuilds the video tiles and my camera/screen flags from the room. */
  private refresh() {
    const room = this.room;
    if (!room) return;
    const lp = room.localParticipant;
    const tiles: VideoTile[] = [];
    for (const p of [lp, ...room.remoteParticipants.values()]) {
      const local = p === lp;
      for (const [source, kind] of [["camera", Track.Source.Camera], ["screen", Track.Source.ScreenShare]] as const) {
        const pub = p.getTrackPublication(kind);
        if (!pub || pub.isMuted || (local && !pub.track)) continue;
        tiles.push({ id: `${p.identity}:${source}`, userId: p.identity, source, local, track: pub.videoTrack });
      }
    }
    this.set({ tiles, camera: !!lp.getTrackPublication(Track.Source.Camera)?.track, screen: lp.isScreenShareEnabled });
  }

  async setMuted(muted: boolean) {
    this.set({ muted, deafened: muted && this.store.getState().deafened }); // unmuting also undeafens
    this.applyAudio();
    await this.applyMic();
    await this.report();
  }

  async setDeafened(deafened: boolean) {
    if (deafened) this.mutedBeforeDeafen = this.store.getState().muted;
    this.set({ deafened, muted: deafened || this.mutedBeforeDeafen }); // deafening also mutes
    this.applyAudio();
    await this.applyMic();
    await this.report();
  }

  private applyAudio() {
    const { deafened } = this.store.getState();
    for (const el of this.audio) el.muted = deafened;
  }

  /** Sends my microphone when I may speak, am not server-muted and have not muted myself. */
  private async applyMic() {
    const room = this.room;
    const { channelId, muted, status } = this.store.getState();
    if (!room || !channelId || status === "idle" || status === "connecting") return;
    const allowed = hasPerm(permsIn(client.store.getState(), channelId), Perm.Speak) && !this.serverMuted;
    try {
      await room.localParticipant.setMicrophoneEnabled(allowed && !muted);
    } catch {
      this.set({ muted: true, error: "Could not use your microphone." });
      await this.report();
    }
  }

  /** Tells the others whether I muted or deafened myself. */
  private async report() {
    const { muted, deafened, status } = this.store.getState();
    if (status === "idle") return; // sent with the next join instead
    await client.setVoiceSelf({ self_mute: muted, self_deaf: deafened }).catch(() => undefined);
  }

  async toggleCamera() {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    const track = lp.getTrackPublication(Track.Source.Camera)?.track;
    try {
      // Unpublish rather than mute, so the server (and so everyone) sees the camera go off.
      if (track) await lp.unpublishTrack(track);
      else await lp.setCameraEnabled(true);
    } catch {
      this.set({ error: "Could not start your camera." });
    }
    this.refresh();
  }

  async toggleScreen() {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    try {
      await lp.setScreenShareEnabled(!lp.isScreenShareEnabled, { audio: true });
    } catch (e) {
      // Closing the browser's screen picker is not an error.
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) this.set({ error: "Could not share your screen." });
    }
    this.refresh();
  }

  /** Starts or stops receiving someone's screen share. */
  watch(userId: string, on: boolean) {
    const p = this.room?.remoteParticipants.get(userId);
    for (const source of SCREEN) p?.getTrackPublication(source)?.setSubscribed(on);
    const others = this.store.getState().watching.filter((x) => x !== userId);
    this.set({ watching: on ? [...others, userId] : others });
    this.refresh();
  }

  /** Plays call audio after the browser blocked autoplay; call it from a click. */
  startAudio() {
    const room = this.room;
    void room?.startAudio().then(() => {
      if (this.room === room) this.set({ audioBlocked: false });
    });
  }
}

export const voice = new Voice();

/** Subscribes a component to part of the voice connection's state. */
export function useVoice<T>(selector: (v: VoiceView) => T): T {
  return useStore(voice.store, selector);
}
```

- [ ] **Step 4: Development proxy** — in `clients/web/vite.config.ts`, under the existing comment add a second line and constant:

```ts
// LiveKit (voice) runs on :7880 in development (override with DATROPE_DEV_LIVEKIT).
const livekit = process.env.DATROPE_DEV_LIVEKIT ?? "localhost:7880";
```

and add to `server.proxy`:

```ts
      // Production has Caddy strip the same prefix (deploy/Caddyfile).
      "/livekit": { target: `http://${livekit}`, ws: true, rewrite: (p) => p.replace(/^\/livekit/, "") },
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter @datrope/web typecheck`, `pnpm --filter @datrope/web build`, `pnpm lint`, `pnpm --filter @datrope/core test`.
Expected: all pass. If a `livekit-client` type differs from what the code assumes (event callback parameters, `getTrackPublication` return types), adapt minimally and record it.

- [ ] **Step 6: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): LiveKit voice engine`

---
### Task 7: Voice UI

**Files:**
- Create (shadcn CLI): `clients/web/src/components/ui/{tooltip,avatar,dropdown-menu,toggle,badge}.tsx`
- Create: `clients/web/src/app/voice/TrackVideo.tsx`, `VoiceMembers.tsx`, `VoicePanel.tsx`, `VoiceStage.tsx`, `VoiceChannelView.tsx`
- Modify: `clients/web/src/app/ChannelSidebar.tsx`, `clients/web/src/app/CommunityView.tsx`, `clients/web/src/app/DMView.tsx`, `clients/web/src/app/ChannelView.tsx`, `clients/web/src/app/dialogs/CreateChannelDialog.tsx`

**Interfaces:**
- Consumes: Task 6's `voice`, `useVoice`, `VideoTile`; Task 5's `voiceMembers`, `client.serverMute`/`moveVoice`/`disconnectVoice`, `State.voice`; existing `useApp`, `usePerms`, `userName`, `dmName`, `errorText`, `Perm`, `hasPerm`.
- Produces (Playwright in Task 8 relies on these names): voice channels are links named after the channel in the sidebar; a voice channel's page is a `main` landmark named after the channel with a **"Join voice"** button; while connected, a `region` named **"Voice"** at the bottom of the sidebar shows the status text **"Voice connected"** and buttons **"Mute"**, **"Deafen"**, **"Camera"**, **"Share screen"**, **"Disconnect"**; the people in a voice channel are a list named **"In voice: <channel name>"** under it in the sidebar; screen shares offer **"Watch"** / **"Stop watching"**; DMs get a **"Start call"** / **"Join call"** button.

Use shadcn/ui components and the existing tokens; no hex colours, no new CSS files. Zustand selectors (`useApp`, `useVoice`) must return stable values — primitives, existing objects, or arrays of them wrapped in `useShallow`; a selector that builds new objects or functions on every call makes React re-render forever.

- [ ] **Step 1: Add the shadcn components**

From `clients/web`: `pnpm dlx shadcn@latest add tooltip avatar dropdown-menu toggle badge`
Expected: five new files under `src/components/ui/` importing from `radix-ui` and `@/lib/utils`, no new CSS, no changes to `styles.css` tokens (if the CLI rewrites `styles.css` or `components.json`, revert those changes). Check the generated `Tooltip` wraps its own `TooltipProvider` (shadcn's current new-york style does); if not, wrap the app in `<TooltipProvider>` in `src/main.tsx`.

- [ ] **Step 2: `clients/web/src/app/voice/TrackVideo.tsx`**

```tsx
import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/** Plays a LiveKit video track. Your own camera is mirrored, like a mirror. */
export function TrackVideo({ track, mirror }: { track: LocalVideoTrack | RemoteVideoTrack; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} className={cn("size-full object-contain", mirror && "-scale-x-100")} autoPlay playsInline muted />;
}
```

- [ ] **Step 3: `clients/web/src/app/voice/VoiceMembers.tsx`**

```tsx
import { Perm, hasPerm, voiceMembers } from "@datrope/core";
import { HeadphoneOff, MicOff, Video } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { client, errorText, useApp, usePerms, userName } from "../../session";
import { useVoice } from "../../voice/voice";

export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** Who is in a voice channel, shown under it in the sidebar, with moderation for those allowed. */
export function VoiceMembers({ channelId, communityId, name }: { channelId: string; communityId: string; name: string }) {
  const members = useApp(useShallow((s) => voiceMembers(s, channelId)));
  const names = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => userName(s, v.user_id))));
  // Selectors must return stable values: IDs here, names from the (stable) channels map below.
  const otherIds = useApp(useShallow((s) => (s.communities[communityId]?.channelIds ?? [])
    .filter((id) => id !== channelId && s.channels[id]?.type === "voice")));
  const channels = useApp((s) => s.channels);
  const meId = useApp((s) => s.me?.id);
  const speaking = useVoice((v) => (v.channelId === channelId ? v.speaking : NOBODY));
  const perms = usePerms(communityId, channelId);
  const [error, setError] = useState<string>();
  if (members.length === 0) return null;
  const canMute = hasPerm(perms, Perm.MuteMembers);
  const canMove = hasPerm(perms, Perm.MoveMembers);
  const act = (p: Promise<unknown>) => p.then(() => setError(undefined), (e: unknown) => setError(errorText(e)));

  return (
    <ul className="mb-1 ml-5 list-none" aria-label={`In voice: ${name}`}>
      {members.map((v, i) => {
        const row = (
          <span className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent">
            <Avatar className={cn("size-6 ring-2 ring-transparent", speaking.includes(v.user_id) && "ring-online")}>
              <AvatarFallback className="text-[0.65rem]">{initials(names[i])}</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-left">{names[i]}</span>
            {v.screen && <Badge variant="destructive" className="px-1 py-0 text-[0.6rem]">LIVE</Badge>}
            {v.camera && <Video className="size-3.5" role="img" aria-label="Camera on" />}
            {(v.self_mute || v.server_mute) && (
              <MicOff className={cn("size-3.5", v.server_mute && "text-destructive")} role="img" aria-label={v.server_mute ? "Muted by a moderator" : "Muted"} />
            )}
            {v.self_deaf && <HeadphoneOff className="size-3.5" role="img" aria-label="Deafened" />}
          </span>
        );
        if (v.user_id === meId || !(canMute || canMove)) return <li key={v.user_id}>{row}</li>;
        return (
          <li key={v.user_id}>
            <DropdownMenu>
              <DropdownMenuTrigger className="w-full rounded-md" aria-label={`Voice options for ${names[i]}`}>{row}</DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {canMute && (
                  <DropdownMenuItem onSelect={() => act(client.serverMute(v.user_id, !v.server_mute))}>
                    {v.server_mute ? "Remove server mute" : "Server mute"}
                  </DropdownMenuItem>
                )}
                {canMove && otherIds.length > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {otherIds.map((id) => (
                        <DropdownMenuItem key={id} onSelect={() => act(client.moveVoice(v.user_id, id))}>{channels[id]?.name}</DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                {canMove && (
                  <DropdownMenuItem variant="destructive" onSelect={() => act(client.disconnectVoice(v.user_id))}>Disconnect</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
      {error && <li className="px-2 text-xs text-destructive" role="alert">{error}</li>}
    </ul>
  );
}

const NOBODY: string[] = [];
```

(If the generated `DropdownMenuItem` has no `variant` prop, use `className="text-destructive"` instead.)

- [ ] **Step 4: `clients/web/src/app/voice/VoicePanel.tsx`**

```tsx
import { Perm, hasPerm } from "@datrope/core";
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from "lucide-react";
import type { ComponentProps } from "react";
import { Link } from "react-router-dom";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dmName, useApp, usePerms } from "../../session";
import { useVoice, voice } from "../../voice/voice";

const STATUS = { connecting: "Connecting…", connected: "Voice connected", reconnecting: "Reconnecting…" } as const;

/** Voice status and controls at the bottom of the sidebar, while in a call (or after it failed). */
export function VoicePanel() {
  const v = useVoice(useShallow((x) => ({
    channelId: x.channelId, status: x.status, error: x.error, muted: x.muted, deafened: x.deafened, camera: x.camera, screen: x.screen,
  })));
  const ch = useApp((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const me = useApp((s) => s.me);
  const serverMuted = useApp((s) => !!(s.me && s.voice[s.me.id]?.server_mute));
  const perms = usePerms(ch?.community_id ?? undefined, v.channelId);
  if (v.status === "idle" && !v.error) return null;

  const canSpeak = hasPerm(perms, Perm.Speak) && !serverMuted;
  const canStream = hasPerm(perms, Perm.Stream);
  const where = !ch ? "" : ch.type === "dm" ? dmName(ch, me?.id) : ch.name;
  const href = !ch ? "/" : ch.type === "dm" ? `/dm/${ch.id}` : `/c/${ch.community_id}/${ch.id}`;
  return (
    <section className="border-t bg-sidebar p-2" aria-label="Voice">
      {v.status === "idle" ? (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <span className="flex-1">{v.error}</span>
          <Button variant="ghost" size="xs" onClick={() => voice.dismiss()}>Dismiss</Button>
        </div>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-semibold", v.status === "connected" ? "text-online" : "text-idle")} role="status">
                {STATUS[v.status]}
              </p>
              <Link to={href} className="block truncate text-xs text-muted-foreground">{where}</Link>
            </div>
            <Control label="Disconnect" tip="Leave voice" pressed={false} onPressedChange={() => voice.leave()}
              className="text-destructive hover:text-destructive"><PhoneOff /></Control>
          </div>
          {v.error && <p className="mb-2 text-xs text-destructive" role="alert">{v.error}</p>}
          <div className="flex gap-1">
            <Control label="Mute" tip={serverMuted ? "Muted by a moderator" : v.muted ? "Unmute" : "Mute"}
              pressed={v.muted || !canSpeak} disabled={!canSpeak} onPressedChange={(on) => void voice.setMuted(on)}>
              {v.muted || !canSpeak ? <MicOff /> : <Mic />}
            </Control>
            <Control label="Deafen" tip={v.deafened ? "Undeafen" : "Deafen"} pressed={v.deafened}
              onPressedChange={(on) => void voice.setDeafened(on)}>
              {v.deafened ? <HeadphoneOff /> : <Headphones />}
            </Control>
            <Control label="Camera" tip={v.camera ? "Turn camera off" : "Turn camera on"} pressed={v.camera} disabled={!canStream}
              onPressedChange={() => void voice.toggleCamera()}>
              {v.camera ? <Video /> : <VideoOff />}
            </Control>
            <Control label="Share screen" tip={v.screen ? "Stop sharing" : "Share your screen"} pressed={v.screen} disabled={!canStream}
              onPressedChange={() => void voice.toggleScreen()}>
              {v.screen ? <ScreenShareOff /> : <ScreenShare />}
            </Control>
          </div>
        </>
      )}
    </section>
  );
}

/** A toggle button with a tooltip. `label` is its accessible name; `tip` says what clicking does. */
function Control({ label, tip, className, ...props }: ComponentProps<typeof Toggle> & { label: string; tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle aria-label={label} variant="outline" size="sm" className={className} {...props} />
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
```

"Disconnect" is a Toggle for a uniform look but always `pressed={false}`; clicking it leaves.

- [ ] **Step 5: `clients/web/src/app/voice/VoiceStage.tsx`**

```tsx
import { Perm, hasPerm, voiceMembers } from "@datrope/core";
import { Eye, EyeOff, Phone } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useApp, usePerms, userName } from "../../session";
import { useVoice, voice, type VideoTile } from "../../voice/voice";
import { TrackVideo } from "./TrackVideo";
import { initials } from "./VoiceMembers";

const NO_TILES: VideoTile[] = [];
const NOBODY: string[] = [];

/** A channel's or DM's call: cameras, screen shares, who is in it, and the join button. */
export function VoiceStage({ channelId, communityId, joinLabel = "Join voice" }: {
  channelId: string;
  communityId?: string;
  joinLabel?: string;
}) {
  const members = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => v.user_id)));
  const names = useApp(useShallow((s) => voiceMembers(s, channelId).map((v) => userName(s, v.user_id))));
  const here = useVoice((v) => v.channelId === channelId && v.status !== "idle");
  const tiles = useVoice((v) => (v.channelId === channelId ? v.tiles : NO_TILES));
  const speaking = useVoice((v) => (v.channelId === channelId ? v.speaking : NOBODY));
  const audioBlocked = useVoice((v) => v.channelId === channelId && v.audioBlocked);
  const tileNames = useApp(useShallow((s) => tiles.map((t) => userName(s, t.userId))));
  const canConnect = hasPerm(usePerms(communityId, channelId), Perm.ConnectVoice);

  return (
    <div className="flex flex-col gap-4 p-4">
      {audioBlocked && <Button onClick={() => voice.startAudio()}>Click to hear the call</Button>}
      {tiles.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {tiles.map((t, i) => <Tile key={t.id} tile={t} name={tileNames[i]} />)}
        </div>
      )}
      {members.length > 0 ? (
        <ul className="flex list-none flex-wrap gap-3" aria-label="In this call">
          {members.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded-full bg-card py-1 pl-1 pr-3">
              <Avatar className={cn("size-7 ring-2 ring-transparent", speaking.includes(id) && "ring-online")}>
                <AvatarFallback className="text-xs">{initials(names[i])}</AvatarFallback>
              </Avatar>
              <span className="text-sm">{names[i]}</span>
            </li>
          ))}
        </ul>
      ) : (
        !here && <p className="text-muted-foreground">Nobody is here yet.</p>
      )}
      {!here && (
        <div>
          <Button disabled={!canConnect} onClick={() => void voice.join(channelId)}><Phone /> {joinLabel}</Button>
          {!canConnect && <p className="mt-2 text-sm text-muted-foreground">You do not have permission to join.</p>}
        </div>
      )}
    </div>
  );
}

function Tile({ tile, name }: { tile: VideoTile; name: string }) {
  const remoteScreen = tile.source === "screen" && !tile.local;
  return (
    <Card className="relative aspect-video gap-0 overflow-hidden bg-muted p-0">
      {tile.track ? (
        <TrackVideo track={tile.track} mirror={tile.local && tile.source === "camera"} />
      ) : remoteScreen ? (
        <div className="grid size-full place-content-center justify-items-center gap-2 text-center">
          <p className="text-sm">{name} is sharing their screen</p>
          <Button variant="outline" size="sm" onClick={() => voice.watch(tile.userId, true)}><Eye /> Watch</Button>
        </div>
      ) : (
        <div className="grid size-full place-items-center">
          <Avatar className="size-16"><AvatarFallback>{initials(name)}</AvatarFallback></Avatar>
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-background/80 px-2 py-0.5 text-xs">
        {name}{tile.source === "screen" ? " — screen" : ""}
      </span>
      {remoteScreen && tile.track && (
        <Button className="absolute right-2 top-2" variant="secondary" size="xs" onClick={() => voice.watch(tile.userId, false)}>
          <EyeOff /> Stop watching
        </Button>
      )}
    </Card>
  );
}
```

- [ ] **Step 6: `clients/web/src/app/voice/VoiceChannelView.tsx`**

```tsx
import { Volume2 } from "lucide-react";
import { useApp } from "../../session";
import { VoiceStage } from "./VoiceStage";

export function VoiceChannelView({ channelId, communityId }: { channelId: string; communityId: string }) {
  const ch = useApp((s) => s.channels[channelId]);
  if (!ch) return <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">This channel is not available.</main>;
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background" aria-label={ch.name}>
      <header className="flex items-center gap-2 border-b bg-card px-4 py-3">
        <Volume2 className="size-4 text-muted-foreground" aria-hidden />
        <h2>{ch.name}</h2>
      </header>
      <VoiceStage channelId={channelId} communityId={communityId} />
    </main>
  );
}
```

- [ ] **Step 7: Sidebar, community view, DMs, channel view, dialog**

`clients/web/src/app/ChannelSidebar.tsx` — import `Volume2` from `lucide-react`, `VoiceMembers` from `./voice/VoiceMembers` and `VoicePanel` from `./voice/VoicePanel`. Replace the channel list item (the whole `<li key={id} className="flex items-center">…</li>`) with:

```tsx
            <li key={id}>
              <div className="flex items-center">
                <Link to={`/c/${communityId}/${id}`}
                  className={cn(CHANNEL, ch.type === "voice" && "flex items-center gap-1.5", id === activeId && "bg-accent text-foreground",
                    ch.type !== "voice" && isUnread(readStates[id]) && "font-semibold text-foreground")}
                  aria-current={id === activeId ? "page" : undefined}>
                  {ch.type === "voice" ? <><Volume2 className="size-4" aria-hidden />{ch.name}</> : `# ${ch.name}`}
                </Link>
                {canManage && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Settings for ${ch.name}`} title="Channel settings"
                    onClick={() => setDialog({ kind: "settings", channelId: id })}>⚙</Button>
                )}
              </div>
              {ch.type === "voice" && <VoiceMembers channelId={id} communityId={communityId} name={ch.name} />}
            </li>
```

and render `<VoicePanel />` as the last element inside `<nav>`, after the dialogs.

`clients/web/src/app/CommunityView.tsx` — import `VoiceChannelView` from `./voice/VoiceChannelView`; add `const type = useApp((s) => (channelId ? s.channels[channelId]?.type : undefined));` next to the other selectors (before any early return), and replace the `ChannelView` element with:

```tsx
      {channelId
        ? type === "voice"
          ? <VoiceChannelView key={channelId} channelId={channelId} communityId={communityId} />
          : <ChannelView key={channelId} channelId={channelId} communityId={communityId} />
        : <main className="grid min-h-full min-w-0 flex-1 place-items-center bg-background p-8 text-center text-muted-foreground">No channels yet.</main>}
```

`clients/web/src/app/DMView.tsx` — import `VoicePanel` from `./voice/VoicePanel` and render `<VoicePanel />` as the last element inside its `<nav>` (after the `NewDMDialog`).

`clients/web/src/app/ChannelView.tsx` — DM calls. Import `voiceMembers` from `@datrope/core`, `VoiceStage` from `./voice/VoiceStage` and `useVoice` from `../voice/voice`. Add next to the other selectors (before the early return):

```tsx
  const inCall = useApp((s) => voiceMembers(s, channelId).length);
  const here = useVoice((v) => v.channelId === channelId && v.status !== "idle");
```

Replace the header with:

```tsx
      <header className="flex items-center justify-between gap-2 border-b bg-card px-4 py-3">
        <h2>{title}</h2>
        {ch.type === "dm" && !here && inCall === 0 && (
          <Button variant="outline" size="sm" onClick={() => void voice.join(channelId)}><Phone /> Start call</Button>
        )}
      </header>
      {ch.type === "dm" && (inCall > 0 || here) && (
        <div className="border-b"><VoiceStage channelId={channelId} joinLabel="Join call" /></div>
      )}
```

(import `Button` from `@/components/ui/button`, `Phone` from `lucide-react`, and `voice` with `useVoice`).

`clients/web/src/app/dialogs/CreateChannelDialog.tsx` — open voice channels too after creating them: replace `if (type === "text") nav(`/c/${communityId}/${ch.id}`);` with `nav(`/c/${communityId}/${ch.id}`);`.

- [ ] **Step 8: Verify**

Run: `pnpm --filter @datrope/web typecheck`, `pnpm --filter @datrope/web build`, `pnpm lint`.
Expected: all pass. Then a manual check if a dev stack with LiveKit is available (the controller sets one up; skip and say so otherwise): create a voice channel, join it in two browser profiles, toggle mute/deafen/camera/screen share, watch a screen share, server-mute and move the other user from the sidebar menu.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(web): voice channels, call controls, video tiles and voice moderation`

---
### Task 8: Deployment and end-to-end voice

**Files:**
- Create: `deploy/livekit.yaml`, `deploy/livekit.e2e.yaml`, `deploy/docker-compose.e2e.yml`
- Modify: `deploy/docker-compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `deploy/.env.e2e`, `deploy/README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `clients/web/playwright.config.ts`, `clients/web/e2e/chat.spec.ts`

**Interfaces:**
- Consumes: server env `DATROPE_LIVEKIT_URL`, `DATROPE_LIVEKIT_API_KEY`, `DATROPE_LIVEKIT_API_SECRET` (Task 2; the public URL defaults to `wss://<domain>/livekit`); webhook `POST /api/voice/webhook` (Task 3); the UI names listed in Task 7.
- Produces: a `livekit` Compose service (API key `datrope`, secret from `LIVEKIT_API_SECRET`), Caddy route `/livekit/*` → `livekit:7880` with the prefix stripped, published ports 7881/tcp, 7882/udp, 3478/udp; an e2e override that makes LiveKit advertise 127.0.0.1.

- [ ] **Step 1: Add the voice step to the end-to-end test (it fails first)**

In `clients/web/playwright.config.ts`, raise `timeout` to `120_000` and give Chromium fake media devices, so joining voice needs no real microphone and no permission prompt:

```ts
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    },
  }],
```

In `clients/web/e2e/chat.spec.ts`, append to the end of the test (after the `admin.reload()` checks):

```ts
  // Voice: the admin opens a voice channel, both join, each sees the other, and leaving is noticed.
  await admin.getByRole("button", { name: "+ Add channel" }).click();
  await admin.getByRole("radio", { name: "Voice" }).click();
  await admin.getByLabel("Name").fill("Lounge");
  await admin.getByRole("button", { name: "Create", exact: true }).click();
  await expect(admin.getByRole("main", { name: "Lounge" })).toBeVisible();
  await admin.getByRole("button", { name: "Join voice" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible();
  const lounge = admin.getByRole("list", { name: "In voice: Lounge" });
  await expect(lounge.getByText("admin")).toBeVisible(); // reported by LiveKit's webhook

  await friend.getByRole("link", { name: "Lounge" }).first().click();
  await friend.getByRole("button", { name: "Join voice" }).click();
  await expect(friend.getByRole("status").filter({ hasText: "Voice connected" })).toBeVisible();
  await expect(lounge.getByText("friend")).toBeVisible();

  await friend.getByRole("button", { name: "Mute" }).click();
  await expect(lounge.getByRole("img", { name: "Muted" })).toBeVisible();

  await friend.getByRole("button", { name: "Disconnect" }).click();
  await expect(lounge.getByText("friend")).toHaveCount(0);
```

Run (from the repo root, with Docker running and no development LiveKit using ports 7881/7882):

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
pnpm --filter @datrope/web e2e
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
```

Expected: FAIL at `Voice connected` — the stack has no LiveKit, so joining shows "voice is not set up on this server". Only touch the `datrope-e2e` project; never stop other containers.

- [ ] **Step 2: LiveKit configuration** — `deploy/livekit.yaml`:

```yaml
# LiveKit: voice, camera and screen share (spec section 2.2).
# The API key/secret come from LIVEKIT_KEYS, which docker-compose.yml builds
# from LIVEKIT_API_SECRET in .env. Media does not go through Caddy: open
# 7881/tcp, 7882/udp and 3478/udp to this machine (see README.md).
port: 7880
rtc:
  tcp_port: 7881        # WebRTC over TCP, when UDP is blocked
  udp_port: 7882        # all WebRTC UDP traffic on one port
  use_external_ip: true # find the public IP with STUN
turn:
  enabled: true         # built-in TURN/UDP for clients behind strict NATs
  udp_port: 3478
room:
  empty_timeout: 300
  departure_timeout: 20
webhook:
  api_key: datrope
  urls:
    - http://server:8080/api/voice/webhook
logging:
  level: info
```

`deploy/livekit.e2e.yaml` (same, but the browser runs on the same machine and reaches LiveKit on 127.0.0.1):

```yaml
# End-to-end test variant of livekit.yaml: advertise 127.0.0.1 instead of
# the public IP (NODE_IP is set in docker-compose.e2e.yml).
port: 7880
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: false
room:
  empty_timeout: 300
  departure_timeout: 20
webhook:
  api_key: datrope
  urls:
    - http://server:8080/api/voice/webhook
logging:
  level: info
```

`deploy/docker-compose.e2e.yml`:

```yaml
# Overrides for the end-to-end test stack (CI and local runs):
#   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml ...
services:
  livekit:
    environment:
      NODE_IP: 127.0.0.1
    volumes:
      - ./livekit.e2e.yaml:/etc/livekit.yaml:ro
```

- [ ] **Step 3: Compose** — in `deploy/docker-compose.yml`, add to the `server` service's `environment`:

```yaml
      DATROPE_LIVEKIT_URL: http://livekit:7880
      DATROPE_LIVEKIT_API_KEY: datrope
      DATROPE_LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET in deploy/.env}
```

and a new service after `server`:

```yaml
  livekit:
    image: livekit/livekit-server:v1.13.7
    restart: unless-stopped
    command: ["--config", "/etc/livekit.yaml"]
    environment:
      LIVEKIT_KEYS: "datrope: ${LIVEKIT_API_SECRET}"
    volumes:
      - ./livekit.yaml:/etc/livekit.yaml:ro
    ports:
      - "7881:7881"
      - "7882:7882/udp"
      - "3478:3478/udp"
```

- [ ] **Step 4: Caddy** — in `deploy/Caddyfile`, before `@backend path /api/* /ws`, add:

```
	# LiveKit signalling (a WebSocket). Media goes straight to LiveKit's ports.
	handle_path /livekit/* {
		reverse_proxy livekit:7880
	}
```

The web app's CSP (`connect-src 'self'`) already allows a same-origin `wss://` connection.

- [ ] **Step 5: Environment files**

`deploy/.env.example`, append:

```
# Secret shared by the server and LiveKit (voice and video). At least 32
# characters, for example the output of: openssl rand -hex 32
LIVEKIT_API_SECRET=change-me-to-a-random-string-of-at-least-32-characters
```

`deploy/.env.e2e`, append:

```
LIVEKIT_API_SECRET=e2eonlylivekitsecret0123456789abcdef
```

- [ ] **Step 6: README** — in `deploy/README.md`, change the setup comment to `# then edit DATROPE_DOMAIN, POSTGRES_PASSWORD and LIVEKIT_API_SECRET` and add a section before `## Backups`:

````markdown
## Voice and video

Voice, camera and screen sharing run through [LiveKit](https://livekit.io), which Compose starts
with everything else. Calls do not pass through Caddy, so open these ports to the machine (and
forward them on your router if it is behind NAT):

| Port | Used for |
|---|---|
| 7882/udp | all call audio and video |
| 7881/tcp | the same, for networks that block UDP |
| 3478/udp | TURN, for people behind strict firewalls |

LiveKit finds the machine's public IP address by itself. If it cannot be reached, joining voice
says so and text chat keeps working.
````

- [ ] **Step 7: CI** — in `.github/workflows/ci.yml`, job `e2e`, use the override file in both Compose commands:

```yaml
      - run: docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
      - run: pnpm --filter @datrope/web e2e
      - if: failure()
        run: docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e logs
```

- [ ] **Step 8: Run the end-to-end test**

```bash
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e config --quiet
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
pnpm --filter @datrope/web e2e
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
```

Expected: `config` prints nothing; `1 passed`. If it fails, `docker compose ... -p datrope-e2e logs livekit server` shows whether the webhook reached the server (`POST /api/voice/webhook` 204 in the server log) and whether ICE connected. Always run the final `down -v`. Only touch the `datrope-e2e` project.

- [ ] **Step 9: Checkpoint** — stop; the controller reviews and stages. Suggested message: `feat(deploy): LiveKit service, /livekit proxy, e2e voice`

---

## Spec coverage (§2.2, §5.3, §5.4, §9, §10)

| Spec requirement | Task |
|---|---|
| LiveKit does media; the server only checks permissions, issues tokens, follows webhooks | 1, 2, 3 |
| `POST /api/voice/{channelId}/join` checks `CONNECT_VOICE` | 2 |
| Token grants: audio needs `SPEAK`, camera/screen need `STREAM` | 1 (`Sources`, `JoinToken`), 2 |
| Client connects to LiveKit directly with the token | 6 (web engine), 8 (Caddy `/livekit`) |
| Webhooks (joined/left, track published) update voice state; `VOICE_STATE_UPDATE` | 3 |
| `READY` includes current voice states | 3 |
| Kick/ban, lost permission, `MUTE_MEMBERS`, `MOVE_MEMBERS` → LiveKit remove/mute/update | 4 |
| One voice channel at a time; joining another leaves the first | 3 (`prepareJoin`, newest connection wins), 6 (client leaves first) |
| Screen share = extra video (+ audio) track, simulcast, subscribe on "watch" | 6 (`autoSubscribe`, `watch`, `simulcast`), 7 (Watch button) |
| DMs: participants can connect, speak, stream | 2 (test), 7 (DM call button) |
| `VOICE_UNAVAILABLE` when LiveKit is unreachable; text keeps working | 2 |
| Voice integration tests against a real LiveKit container: grants enforced, kicking removes | 1, 2, 4 (`lktest`) |
| Playwright "join voice" on the compose stack | 8 |
| Compose service `livekit`, `deploy/livekit.yaml`, built-in TURN | 8 |
