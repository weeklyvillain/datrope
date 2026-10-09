package auth

import (
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func TestValidateLinks(t *testing.T) {
	long := "https://example.com/" + strings.Repeat("a", 181) // 201 characters
	require.Len(t, long, 201)

	bad := map[string][]string{
		"http":       {"http://example.com"},
		"javascript": {"javascript:alert(1)"},
		"userinfo":   {"https://user:pw@x.com"},
		"no host":    {"https://"},
		"too long":   {long},
		"six":        {"https://a.com", "https://b.com", "https://c.com", "https://d.com", "https://e.com", "https://f.com"},
		"no scheme":  {"example.com"},
		"opaque":     {"https:example.com"},
		"second bad": {"https://ok.com", "ftp://x.com"},
	}
	for name, in := range bad {
		t.Run(name, func(t *testing.T) {
			_, err := validateLinks(in)
			var he *httpx.Error
			require.True(t, errors.As(err, &he), "%v", err)
			require.Equal(t, "BAD_LINK", he.Code)
		})
	}

	got, err := validateLinks([]string{" https://github.com/alice ", "", "  ", "https://github.com/alice", "https://example.com/@me"})
	require.NoError(t, err)
	require.Equal(t, []string{"https://github.com/alice", "https://example.com/@me"}, got)

	got, err = validateLinks([]string{"HTTPS://Example.com", "https://bücher.example/x", "https://xn--bcher-kva.example"})
	require.NoError(t, err)
	require.Len(t, got, 3)

	got, err = validateLinks([]string{"https://a.com", "", "https://b.com", "https://a.com", "https://c.com", "https://d.com", "https://e.com"})
	require.NoError(t, err)
	require.Len(t, got, 5)

	got, err = validateLinks(nil)
	require.NoError(t, err)
	require.Empty(t, got)

	exactly := "https://example.com/" + strings.Repeat("a", 180) // 200 characters
	got, err = validateLinks([]string{exactly})
	require.NoError(t, err)
	require.Equal(t, []string{exactly}, got)
}
