package slot

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNilGateIsActive(t *testing.T) {
	var g *Gate
	require.True(t, g.Active())
}

func TestReadActive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "slot")
	require.False(t, ReadActive(p, "blue"), "missing file: inactive")
	require.NoError(t, os.WriteFile(p, []byte("blue\n"), 0o644))
	require.True(t, ReadActive(p, "blue"))
	require.False(t, ReadActive(p, "green"))
}

func TestWatchFlips(t *testing.T) {
	p := filepath.Join(t.TempDir(), "slot")
	require.NoError(t, os.WriteFile(p, []byte("green\n"), 0o644))
	g := &Gate{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Watch(ctx, g, p, "blue", 10*time.Millisecond)
	require.Eventually(t, func() bool { return !g.Active() }, time.Second, 5*time.Millisecond)
	require.NoError(t, os.WriteFile(p, []byte("blue\n"), 0o644))
	require.Eventually(t, g.Active, time.Second, 5*time.Millisecond)
}

func TestSetInactive(t *testing.T) {
	g := &Gate{}
	require.True(t, g.Active())
	g.SetInactive()
	require.False(t, g.Active())
}

func TestOnActiveFiresWhenTheSlotGoesLive(t *testing.T) {
	p := filepath.Join(t.TempDir(), "slot")
	require.NoError(t, os.WriteFile(p, []byte("green\n"), 0o644))
	g := &Gate{}
	g.SetInactive()
	fired := make(chan struct{}, 4)
	g.OnActive(func() { fired <- struct{}{} })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Watch(ctx, g, p, "blue", 10*time.Millisecond)
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, fired, "still standby")
	require.NoError(t, os.WriteFile(p, []byte("blue\n"), 0o644))
	select {
	case <-fired:
	case <-time.After(time.Second):
		t.Fatal("OnActive did not fire")
	}
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, fired, "fires once per flip")
}
