package linkpreview

import (
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParse(t *testing.T) {
	u, _ := url.Parse("https://docs.example.com/ports")
	cases := []struct {
		name, html string
		want       *Preview
	}{
		{"opengraph", `<html><head><meta property="og:site_name" content="Example Docs"><meta property="og:title" content="Ports &amp; firewall">
			<meta property="og:description" content="Which ports to open."><title>ignored</title></head><body>x</body></html>`,
			&Preview{URL: u.String(), Site: "Example Docs", Title: "Ports & firewall", Description: "Which ports to open."}},
		{"title fallback", `<head><title> Plain  title </title><meta name="description" content="Desc"></head>`,
			&Preview{URL: u.String(), Site: "docs.example.com", Title: "Plain title", Description: "Desc"}},
		{"no title", `<html><body><p>nothing</p></body></html>`, nil},
		{"invalid UTF-8 and NUL", "<title>a\xffb\x00c</title>",
			&Preview{URL: u.String(), Site: "docs.example.com", Title: "a\uFFFDb\uFFFDc"}}, // the tokenizer turns a NUL in text into U+FFFD
		{"long title cut", `<title>` + strings.Repeat("a", 500) + `</title>`,
			&Preview{URL: u.String(), Site: "docs.example.com", Title: strings.Repeat("a", 200)}},
	}
	for _, c := range cases {
		got, ok := Parse(strings.NewReader(c.html), u)
		if c.want == nil {
			require.False(t, ok, c.name)
			continue
		}
		require.True(t, ok, c.name)
		require.Equal(t, c.want, got, c.name)
	}
}

// Postgres rejects invalid UTF-8 and NUL in TEXT; attribute values can carry both.
func TestCleanMakesPostgresSafe(t *testing.T) {
	require.Equal(t, "a\uFFFDbc d", clean("a\xffb\x00c  d", 10))
}

func TestFetchRefusesPrivateAddresses(t *testing.T) {
	_, err := fetch(t.Context(), "http://127.0.0.1:1/")
	require.ErrorIs(t, err, ErrBlockedAddress)
	_, err = fetch(t.Context(), "ftp://example.com/")
	require.Error(t, err)
}
