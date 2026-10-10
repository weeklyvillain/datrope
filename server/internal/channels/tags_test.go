package channels

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeTags(t *testing.T) {
	got, err := normalizeTags([]string{" Bug ", "Feature"}, 20)
	require.NoError(t, err)
	require.Equal(t, []string{"Bug", "Feature"}, got)

	got, err = normalizeTags(nil, 20)
	require.NoError(t, err)
	require.Equal(t, []string{}, got)

	over := make([]string, 21)
	for i := range over {
		over[i] = strings.Repeat("a", i+1)
	}
	for name, in := range map[string][]string{
		"empty":     {"ok", "  "},
		"25 runes":  {strings.Repeat("é", 25)},
		"duplicate": {"Feature", "feature"},
		"too many":  over,
	} {
		_, err := normalizeTags(in, 20)
		require.Error(t, err, name)
	}
	_, err = normalizeTags([]string{strings.Repeat("é", 24)}, 20)
	require.NoError(t, err)
}
