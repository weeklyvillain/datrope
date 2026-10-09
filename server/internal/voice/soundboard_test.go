package voice_test

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

func TestSoundboard(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	alice, bob := c.owner, c.member
	carol := env.Register("carol")
	carol.Join(alice.Invite())

	enter(t, env, cfg, alice, c.voiceID)
	enter(t, env, cfg, bob, c.voiceID)
	bobWS, _ := bob.Connect()
	carolWS, _ := carol.Connect()

	snd := uploadSound(t, alice)

	play := func(c *apptest.Client, sound id.ID, want int) {
		t.Helper()
		c.Do(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": sound}, want, nil)
	}

	play(alice, snd.ID, http.StatusNoContent)
	var ev voice.SoundboardPlay
	bobWS.ExpectDispatch("SOUNDBOARD_PLAY", &ev)
	require.Equal(t, voice.SoundboardPlay{ChannelID: c.voiceID, UserID: alice.User.ID, SoundID: snd.ID}, ev)
	carolWS.ExpectNoDispatch("SOUNDBOARD_PLAY", 300*time.Millisecond)

	alice.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusTooManyRequests, "RATE_LIMITED")
	carol.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusNotFound, "NOT_FOUND")
	bob.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": id.ID(1)}, http.StatusNotFound, "NOT_FOUND")

	alice.Do(http.MethodPost, memberPath(bob.User.ID)+"/mute", map[string]any{"muted": true}, http.StatusNoContent, nil)
	bob.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusForbidden, "SERVER_MUTED")
	alice.Do(http.MethodPost, memberPath(bob.User.ID)+"/mute", map[string]any{"muted": false}, http.StatusNoContent, nil)

	setEveryone(alice, c.community.ID, perms.Default&^perms.UseSoundboard)
	bob.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusForbidden, "MISSING_PERMISSION")
}

func uploadSound(t *testing.T, c *apptest.Client) expressions.Sound {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("name", "Airhorn"))
	require.NoError(t, mw.WriteField("emoji", "🎺"))
	fw, err := mw.CreateFormFile("file", "sound.wav")
	require.NoError(t, err)
	_, _ = fw.Write(wav(time.Second))
	require.NoError(t, mw.Close())
	_, raw := c.Raw(http.MethodPost, "/api/server/sounds", &body, mw.FormDataContentType(), http.StatusCreated)
	var snd expressions.Sound
	require.NoError(t, json.Unmarshal(raw, &snd))
	return snd
}

func TestSoundboardNeedsSpeak(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	snd := uploadSound(t, c.owner)
	enter(t, env, cfg, c.member, c.voiceID)
	deny(c.owner, c.voiceID, c.community.ID, perms.Speak)
	c.member.Fail(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestSoundboardInDMCall(t *testing.T) {
	env, cfg := liveKitEnv(t)
	c := newClub(t, env)
	snd := uploadSound(t, c.owner)
	var dm channels.Channel
	c.owner.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []id.ID{c.member.User.ID}}, http.StatusOK, &dm)
	enter(t, env, cfg, c.owner, dm.ID)
	enter(t, env, cfg, c.member, dm.ID)
	ws, _ := c.member.Connect()
	c.owner.Do(http.MethodPost, "/api/voice/soundboard", map[string]any{"sound_id": snd.ID}, http.StatusNoContent, nil)
	var ev voice.SoundboardPlay
	ws.ExpectDispatch("SOUNDBOARD_PLAY", &ev)
	require.Equal(t, voice.SoundboardPlay{ChannelID: dm.ID, UserID: c.owner.User.ID, SoundID: snd.ID}, ev)
}

// wav returns a PCM WAV of the given length (8 kHz, mono, 8-bit).
func wav(d time.Duration) []byte {
	const rate = 8000
	n := int(d.Seconds() * rate)
	var b bytes.Buffer
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+n))
	b.WriteString("WAVEfmt ")
	binary.Write(&b, binary.LittleEndian, uint32(16))
	binary.Write(&b, binary.LittleEndian, uint16(1)) // PCM
	binary.Write(&b, binary.LittleEndian, uint16(1)) // channels
	binary.Write(&b, binary.LittleEndian, uint32(rate))
	binary.Write(&b, binary.LittleEndian, uint32(rate)) // byte rate
	binary.Write(&b, binary.LittleEndian, uint16(1))
	binary.Write(&b, binary.LittleEndian, uint16(8))
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(n))
	b.Write(make([]byte, n))
	return b.Bytes()
}
