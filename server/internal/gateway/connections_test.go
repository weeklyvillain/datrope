package gateway_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
)

func TestConnections(t *testing.T) {
	env := apptest.New(t)
	require.Zero(t, env.App.Gateway.Connections())
	ws, _ := env.Register("alice").Connect()
	require.Equal(t, 1, env.App.Gateway.Connections())
	ws.Close()
	require.Eventually(t, func() bool { return env.App.Gateway.Connections() == 0 }, 5*time.Second, 20*time.Millisecond,
		"a closed socket stops counting even while its session waits to be resumed")
}
