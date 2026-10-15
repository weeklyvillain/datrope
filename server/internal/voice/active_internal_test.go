package voice

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsActive(t *testing.T) {
	s := &Service{}
	require.True(t, s.isActive(), "no gate: always active")
	s.SetActive(func() bool { return false })
	require.False(t, s.isActive())
}

// A zero Service has no LiveKit client: reaching Sync would panic.
func TestRefreshSkippedWhileInactive(t *testing.T) {
	s := &Service{}
	s.SetActive(func() bool { return false })
	require.NotPanics(t, func() { s.refresh(true) })
}

func TestResyncAsksForAFullSync(t *testing.T) {
	s := &Service{resync: make(chan struct{}, 1)}
	s.Resync()
	s.Resync() // one is already due: does not block
	require.Len(t, s.resync, 1)
	require.NotPanics(t, (&Service{}).Resync, "a zero Service (voice off)")
}
