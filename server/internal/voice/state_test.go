package voice_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"testing"
	"time"

	lkauth "github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/encoding/protojson"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/voice"
)

const settle, poll = 5 * time.Second, 100 * time.Millisecond

// postWebhook signs ev the way LiveKit does and posts it to the server. It
// asserts nothing, so it is safe to call from other goroutines.
func postWebhook(env *apptest.Env, cfg voice.Config, ev *livekit.WebhookEvent) (int, error) {
	body, err := protojson.Marshal(ev)
	if err != nil {
		return 0, err
	}
	sum := sha256.Sum256(body)
	token, err := lkauth.NewAccessToken(cfg.APIKey, cfg.APISecret).SetValidFor(time.Minute).
		SetSha256(base64.StdEncoding.EncodeToString(sum[:])).ToJWT()
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequest(http.MethodPost, env.Server.URL+"/api/voice/webhook", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", token)
	req.Header.Set("Content-Type", "application/webhook+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func sendWebhook(t *testing.T, env *apptest.Env, cfg voice.Config, ev *livekit.WebhookEvent) int {
	t.Helper()
	status, err := postWebhook(env, cfg, ev)
	require.NoError(t, err)
	return status
}

// lkEvent builds a webhook about one participant (sid) of a channel's room.
func lkEvent(kind string, channelID, userID id.ID, sid string, joinedAt int64) *livekit.WebhookEvent {
	return &livekit.WebhookEvent{Event: kind, Room: &livekit.Room{Name: channelID.String()},
		Participant: &livekit.ParticipantInfo{Sid: sid, Identity: userID.String(), JoinedAtMs: joinedAt}}
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
	cfg := offline(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg })
	c := newClub(t, env)
	ws, _ := c.owner.Connect()

	wrong := cfg
	wrong.APISecret = "another-secret-0123456789abcdef0123"
	require.Equal(t, http.StatusUnauthorized,
		sendWebhook(t, env, wrong, lkEvent("participant_joined", c.voiceID, c.member.User.ID, "PA_1", 1)))
	env.Anon().Raw(http.MethodPost, "/api/voice/webhook", strings.NewReader("{}"), "application/json", http.StatusUnauthorized)
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond)
}

func TestWebhooksTrackVoiceState(t *testing.T) {
	cfg := offline(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg })
	c := newClub(t, env)
	eve := env.Outsider("eve")
	ownerWS, _ := c.owner.Connect()
	eveWS, _ := eve.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, cfg, ev))
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
	cfg := offline(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg })
	c := newClub(t, env)
	games := createVoice(c.owner, "Games")
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, cfg, ev))
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

	if runtime.GOOS == "windows" {
		t.Log("skipping the camera step: pion cannot reach the LiveKit container's 127.0.0.1 candidates on Windows; Linux CI runs it")
	} else {
		track, err := lksdk.NewLocalSampleTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8})
		require.NoError(t, err)
		_, err = room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "camera", Source: livekit.TrackSource_CAMERA})
		require.NoError(t, err)
		stop, done := make(chan struct{}), make(chan struct{})
		t.Cleanup(func() { close(stop); <-done }) // runs before the room disconnects
		go func() {                               // LiveKit reports a track once media flows
			defer close(done)
			tick := time.NewTicker(33 * time.Millisecond)
			defer tick.Stop()
			for {
				select {
				case <-stop:
					return
				case <-tick.C:
					_ = track.WriteSample(media.Sample{Data: []byte{0, 0, 0, 0}, Duration: 33 * time.Millisecond}, nil)
				}
			}
		}()
		require.Eventually(t, func() bool {
			if err := env.App.Voice.Sync(ctx); err != nil {
				return false
			}
			st := env.App.Voice.States([]id.ID{c.voiceID})
			return len(st) == 1 && st[0].Camera
		}, 20*time.Second, 250*time.Millisecond)
		require.True(t, nextState(t, ws, bob).Camera)
	}

	// Joining another channel leaves the first at once, in LiveKit too.
	games := createVoice(c.owner, "Games")
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

func participant(userID id.ID, sid string, joinedAtMs int64) *livekit.ParticipantInfo {
	return &livekit.ParticipantInfo{Sid: sid, Identity: userID.String(), JoinedAtMs: joinedAtMs}
}

// A sync snapshot taken before a participant_left must not bring them back.
func TestSyncIgnoresSnapshotOlderThanLeave(t *testing.T) {
	stub := newStubLiveKit(t, true)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = stub.cfg })
	stub.awaitStartupSync(t)
	c := newClub(t, env)
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID

	require.Equal(t, http.StatusNoContent, sendWebhook(t, env, stub.cfg, lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100)))
	require.NotNil(t, nextState(t, ws, bob).ChannelID)

	stub.setRoom(c.voiceID, participant(bob, "PA_1", 100))
	stub.mu.Lock()
	hooked := make(chan error, 1)
	stub.onParticipants = func() { // bob leaves while the sync is still reading LiveKit
		status, err := postWebhook(env, stub.cfg, lkEvent("participant_left", c.voiceID, bob, "PA_1", 100))
		if err == nil && status != http.StatusNoContent {
			err = fmt.Errorf("webhook status %d", status)
		}
		hooked <- err
	}
	stub.mu.Unlock()
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	stub.mu.Lock()
	stub.onParticipants = nil
	stub.mu.Unlock()
	require.NoError(t, <-hooked)

	require.Nil(t, nextState(t, ws, bob).ChannelID)
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond)
	require.Empty(t, env.App.Voice.States([]id.ID{c.voiceID}))
}

// Switching channels while a sync is running must not bring back the old
// channel or use up the flags sent with the new join.
func TestSyncIgnoresSnapshotOlderThanSwitch(t *testing.T) {
	stub := newStubLiveKit(t, true)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = stub.cfg })
	stub.awaitStartupSync(t)
	c := newClub(t, env)
	games := createVoice(c.owner, "Games")
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID

	require.Equal(t, http.StatusNoContent, sendWebhook(t, env, stub.cfg, lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100)))
	require.Equal(t, c.voiceID, *nextState(t, ws, bob).ChannelID)

	stub.setRoom(c.voiceID, participant(bob, "PA_1", 100))
	stub.mu.Lock()
	hooked := make(chan error, 1)
	stub.onParticipants = func() {
		_, err := env.App.Voice.Join(context.Background(), c.member.User, 0, games, voice.JoinRequest{SelfMute: true})
		hooked <- err
	}
	stub.mu.Unlock()
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	stub.mu.Lock()
	stub.onParticipants = nil
	stub.mu.Unlock()
	require.NoError(t, <-hooked)

	require.Nil(t, nextState(t, ws, bob).ChannelID, "left Lounge")
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond) // no ghost in Lounge
	require.Equal(t, http.StatusNoContent, sendWebhook(t, env, stub.cfg, lkEvent("participant_joined", games, bob, "PA_2", 200)))
	st := nextState(t, ws, bob)
	require.Equal(t, games, *st.ChannelID)
	require.True(t, st.SelfMute, "the join flags survived the sync")
}

// After a reconnect, a late report about the old connection changes nothing.
func TestReconnectIgnoresOlderConnection(t *testing.T) {
	cfg := offline(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg })
	c := newClub(t, env)
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, cfg, ev))
	}

	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100))
	nextState(t, ws, bob)
	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_2", 200))
	nextState(t, ws, bob)

	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100)) // late, older
	ws.ExpectNoDispatch("VOICE_STATE_UPDATE", 300*time.Millisecond)

	camera := lkEvent("track_published", c.voiceID, bob, "PA_2", 200)
	camera.Track = &livekit.TrackInfo{Sid: "TR_1", Type: livekit.TrackType_VIDEO, Source: livekit.TrackSource_CAMERA}
	hook(camera)
	require.True(t, nextState(t, ws, bob).Camera, "the newer connection is still the one followed")
}

// Self mute and deafen are kept in LiveKit, so a restarted server knows them.
func TestSelfFlagsSurviveRestart(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	bob := c.member.User.ID
	var res voice.JoinResponse
	c.member.Do(http.MethodPost, joinPath(c.voiceID), map[string]any{"self_mute": true}, http.StatusOK, &res)
	lktest.Connect(t, cfg, res.Token)
	require.NoError(t, env.App.Voice.Sync(context.Background()))
	c.member.Do(http.MethodPatch, "/api/voice/state", map[string]any{"self_deaf": true}, http.StatusNoContent, nil)
	require.Equal(t, []livekit.TrackSource{mic, camera, screen, sound}, sourcesOf(cfg, c.voiceID, bob), "permissions unchanged")

	restarted := voice.NewService(cfg, &events.Bus{}, nil, nil) // knows nothing but what LiveKit says
	t.Cleanup(restarted.Close)
	require.Eventually(t, func() bool {
		if restarted.Sync(context.Background()) != nil {
			return false
		}
		st := restarted.States([]id.ID{c.voiceID})
		return len(st) == 1 && st[0].UserID == bob && st[0].SelfMute && st[0].SelfDeaf
	}, settle, poll)
}

// Rejoining the same channel keeps a server mute even when LiveKit reports
// the old connection leaving before the new one arrives.
func TestRejoinKeepsServerMute(t *testing.T) {
	stub := newStubLiveKit(t, true)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = stub.cfg })
	stub.awaitStartupSync(t)
	c := newClub(t, env)
	ws, _ := c.owner.Connect()
	bob := c.member.User.ID
	hook := func(ev *livekit.WebhookEvent) {
		t.Helper()
		require.Equal(t, http.StatusNoContent, sendWebhook(t, env, stub.cfg, ev))
	}

	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_1", 100))
	nextState(t, ws, bob)
	c.owner.Do(http.MethodPost, memberPath(bob)+"/mute", map[string]any{"muted": true}, http.StatusNoContent, nil)
	require.True(t, nextState(t, ws, bob).ServerMute)

	join(c.member, c.voiceID)
	hook(lkEvent("participant_left", c.voiceID, bob, "PA_1", 100))
	require.Nil(t, nextState(t, ws, bob).ChannelID)
	hook(lkEvent("participant_joined", c.voiceID, bob, "PA_2", 200))
	st := nextState(t, ws, bob)
	require.Equal(t, c.voiceID, *st.ChannelID)
	require.True(t, st.ServerMute, "the server mute carried over")
}
