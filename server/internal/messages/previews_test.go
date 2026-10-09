package messages

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestFirstLink(t *testing.T) {
	cases := map[string]string{
		"see https://example.com/a?b=1.":                 "https://example.com/a?b=1",
		"[docs](https://example.com/x) and http://b.com": "https://example.com/x",
		"`https://code.com` then https://real.com":       "https://real.com",
		"||https://spoiler.com|| https://shown.com":      "https://shown.com",
		"```\nhttps://block.com\n```":                    "",
		"no links here":                                  "",
		"(https://example.com/wiki/Foo_(bar))":           "https://example.com/wiki/Foo_(bar)",
		"javascript:alert(1) ftp://x.com":                "",
	}
	for in, want := range cases {
		require.Equal(t, want, firstLink(in), in)
	}
	long := "https://example.com/" + strings.Repeat("a", maxLinkLen)
	require.Equal(t, "", firstLink("see "+long))
	require.Equal(t, long[:maxLinkLen], firstLink(long[:maxLinkLen]))
}
