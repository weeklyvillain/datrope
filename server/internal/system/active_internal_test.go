package system

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestYtDlpAutoUpdateGated(t *testing.T) {
	s := &Service{yt: &YtDlp{}}
	require.True(t, s.yt.isActive(), "no gate: always active")
	s.SetActive(func() bool { return false })
	require.False(t, s.yt.isActive(), "the standby slot leaves the shared binary alone")
}
