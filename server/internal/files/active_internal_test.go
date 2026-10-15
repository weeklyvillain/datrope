package files

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
