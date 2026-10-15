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

func TestConfigUpdater(t *testing.T) {
	t.Setenv("DATROPE_DATABASE_URL", "postgres://example")
	t.Setenv("DATROPE_PUBLIC_URL", "https://chat.example.com")
	t.Setenv("DATROPE_UPDATER_URL", "")
	t.Setenv("DATROPE_UPDATER_TOKEN", "")
	c, err := app.ConfigFromEnv()
	require.NoError(t, err)
	require.Empty(t, c.UpdaterURL)
	require.Empty(t, c.UpdaterToken)

	t.Setenv("DATROPE_UPDATER_TOKEN", "x")
	c, err = app.ConfigFromEnv()
	require.NoError(t, err)
	require.Equal(t, "http://updater:8090", c.UpdaterURL, "the compose service name is the default")
}

func TestConfigSlot(t *testing.T) {
	t.Setenv("DATROPE_DATABASE_URL", "postgres://example")
	t.Setenv("DATROPE_PUBLIC_URL", "https://chat.example.com")
	t.Setenv("DATROPE_SLOT", "")
	t.Setenv("DATROPE_SLOT_FILE", "")
	c, err := app.ConfigFromEnv()
	require.NoError(t, err)
	require.Empty(t, c.Slot, "no slot: always live")

	t.Setenv("DATROPE_SLOT", "green")
	c, err = app.ConfigFromEnv()
	require.NoError(t, err)
	require.Equal(t, "green", c.Slot)
	require.Equal(t, "/switch/slot", c.SlotFile)
}
