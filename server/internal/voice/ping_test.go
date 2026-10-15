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
