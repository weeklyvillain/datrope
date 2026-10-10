package voice_test

import (
	"context"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
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

	c.owner.Do(http.MethodDelete, "/api/server/members/"+bob.String(), nil, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)
	require.Nil(t, nextState(t, ws, bob).ChannelID)
}

func TestBanRemovesFromVoice(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	c.owner.Do(http.MethodPut, "/api/server/bans/"+bob.String(), map[string]any{}, http.StatusNoContent, nil)
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
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	enter(t, env, cfg, c.member, c.voiceID)
	require.Equal(t, c.voiceID, *nextState(t, ws, bob).ChannelID)
	c.owner.Do(http.MethodDelete, "/api/channels/"+c.voiceID.String(), nil, http.StatusNoContent, nil)
	require.Eventually(t, func() bool {
		names, err := voice.NewRooms(cfg).List(context.Background())
		return err == nil && !slices.Contains(names, c.voiceID.String())
	}, settle, poll)
	// The channel has no viewers once deleted, so the "left" update reaches
	// nobody; clients drop its voice states on CHANNEL_DELETE.
	require.Eventually(t, func() bool { return len(env.App.Voice.States([]id.ID{c.voiceID})) == 0 }, settle, poll)
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
	games := createVoice(c.owner, "Games")
	alice, bob := c.owner.User.ID, c.member.User.ID
	aliceWS, _ := c.owner.Connect()
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
	aliceWS.ExpectNoDispatch("VOICE_MOVE", 300*time.Millisecond)

	// A member who cannot connect to a channel can still be moved there, and stays.
	locked := createVoice(c.owner, "Locked")
	deny(c.owner, locked, c.community.ID, perms.ConnectVoice)
	c.member.Fail(http.MethodPost, joinPath(locked), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	c.owner.Do(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": locked}, http.StatusNoContent, nil)
	bobWS.ExpectDispatch("VOICE_MOVE", &mv)
	enter(t, env, cfg, c.member, locked)
	require.NoError(t, env.App.Voice.Reconcile(context.Background()))
	require.False(t, gone(cfg, locked, bob)(), "a moved member is not removed for lacking CONNECT")
	c.member.Fail(http.MethodPost, joinPath(locked), map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION") // the move is used up
	c.owner.Do(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": c.voiceID}, http.StatusNoContent, nil)
	bobWS.ExpectDispatch("VOICE_MOVE", &mv)
	enter(t, env, cfg, c.member, c.voiceID)

	deny(c.owner, games, c.community.ID, perms.ViewChannel)
	c.owner.Fail(http.MethodPost, memberPath(bob)+"/move", map[string]any{"channel_id": games}, http.StatusForbidden, "MISSING_PERMISSION")

	c.owner.Do(http.MethodDelete, memberPath(bob), nil, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)

	c.owner.Do(http.MethodDelete, memberPath(alice), nil, http.StatusNoContent, nil) // leaving needs no permission
	require.Eventually(t, gone(cfg, c.voiceID, alice), settle, poll)
	c.owner.Fail(http.MethodDelete, memberPath(alice), nil, http.StatusNotFound, "NOT_FOUND")
}

func TestMoveNeedsPermissionInDestination(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	games := createVoice(c.owner, "Games")
	bob := c.member.User.ID
	carol := env.Register("carol")
	enter(t, env, cfg, carol, c.voiceID)

	var mods struct{ ID id.ID }
	c.owner.Do(http.MethodPost, "/api/server/roles",
		map[string]any{"name": "Movers", "permissions": uint64(perms.MoveMembers)}, http.StatusCreated, &mods)
	c.owner.Do(http.MethodPut, "/api/server/members/"+bob.String()+"/roles/"+mods.ID.String(), nil, http.StatusNoContent, nil)
	c.owner.Do(http.MethodPut, "/api/channels/"+games.String()+"/overrides/role/"+mods.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.MoveMembers)}, http.StatusOK, nil)

	c.member.Fail(http.MethodPost, memberPath(carol.User.ID)+"/move", map[string]any{"channel_id": games}, http.StatusForbidden, "MISSING_PERMISSION")

	other := createVoice(c.owner, "Other") // bob may move people there
	c.member.Do(http.MethodPost, memberPath(carol.User.ID)+"/move", map[string]any{"channel_id": other}, http.StatusNoContent, nil)
}

func TestVoiceModerationFollowsHierarchy(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	carol := env.Register("carol")
	var helper, mod struct{ ID id.ID }
	c.owner.Do(http.MethodPost, "/api/server/roles",
		map[string]any{"name": "Helper", "permissions": uint64(perms.MuteMembers | perms.MoveMembers)}, http.StatusCreated, &helper)
	c.owner.Do(http.MethodPost, "/api/server/roles",
		map[string]any{"name": "Moderator", "permissions": uint64(perms.MuteMembers)}, http.StatusCreated, &mod)
	c.owner.Do(http.MethodPut, "/api/server/members/"+c.member.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil) // rank 1
	c.owner.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)       // rank 2
	enter(t, env, cfg, carol, c.voiceID)

	c.member.Fail(http.MethodPost, memberPath(carol.User.ID)+"/mute", map[string]any{"muted": true}, http.StatusForbidden, "MISSING_PERMISSION")
	c.member.Fail(http.MethodDelete, memberPath(carol.User.ID), nil, http.StatusForbidden, "MISSING_PERMISSION")
	carol.Do(http.MethodPost, memberPath(carol.User.ID)+"/mute", map[string]any{"muted": true}, http.StatusNoContent, nil) // not moderating anyone else
}

func TestSignOutBeforeConnectStillRemoves(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	token := join(c.member, c.voiceID).Token // issued before the sign-out, not used yet
	c.owner.Do(http.MethodPut, "/api/admin/users/"+bob.String()+"/disabled", map[string]any{"disabled": true}, http.StatusOK, nil)
	require.Eventually(t, func() bool { return env.App.Voice.Reconcile(context.Background()) == nil }, settle, poll)

	lktest.Connect(t, cfg, token)
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll)
}

func TestSignOutOnlyRemovesTokensIssuedBefore(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	old := join(c.member, c.voiceID).Token // before the sign-out, not used yet
	time.Sleep(20 * time.Millisecond)
	c.owner.Do(http.MethodPut, "/api/admin/users/"+bob.String()+"/password", map[string]any{"password": "new-password-123"}, http.StatusNoContent, nil)
	time.Sleep(20 * time.Millisecond)

	again := env.Anon()
	var res auth.AuthResult
	again.Do(http.MethodPost, "/api/auth/login", map[string]any{
		"login": "bob", "password": "new-password-123", "device_name": "test", "client": "native",
	}, http.StatusOK, &res)
	again.Token, again.User = res.Token, res.User

	lktest.Connect(t, cfg, old)
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll, "a token from before the sign-out is refused")

	enter(t, env, cfg, again, c.voiceID) // a fresh join after it
	require.NoError(t, env.App.Voice.Reconcile(context.Background()))
	time.Sleep(500 * time.Millisecond)
	require.False(t, gone(cfg, c.voiceID, bob)(), "a token issued after the sign-out stays")
	require.Len(t, env.App.Voice.States([]id.ID{c.voiceID}), 1)
}

// Revoking one session takes that device out of voice; others stay.
func TestRevokingSessionLeavesVoice(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	other := env.Anon() // bob's second device
	var res auth.AuthResult
	other.Do(http.MethodPost, "/api/auth/login", map[string]any{
		"login": "bob", "password": "password123", "device_name": "phone", "client": "native",
	}, http.StatusOK, &res)
	other.Token, other.User = res.Token, res.User
	var sessions []auth.Session
	other.Do(http.MethodGet, "/api/sessions", nil, http.StatusOK, &sessions)
	first := sessions[slices.IndexFunc(sessions, func(s auth.Session) bool { return !s.Current })].ID

	enter(t, env, cfg, c.member, c.voiceID)
	other.Do(http.MethodDelete, "/api/sessions/"+first.String(), nil, http.StatusNoContent, nil)
	require.Eventually(t, gone(cfg, c.voiceID, bob), settle, poll, "the revoked session's connection is removed")

	enter(t, env, cfg, other, c.voiceID)
	require.NoError(t, env.App.Voice.Reconcile(context.Background()))
	time.Sleep(500 * time.Millisecond)
	require.False(t, gone(cfg, c.voiceID, bob)(), "the other session's connection stays")
	require.Len(t, env.App.Voice.States([]id.ID{c.voiceID}), 1)
}
