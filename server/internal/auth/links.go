package auth

import (
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/httpx"
)

const (
	maxLinks   = 5
	maxLinkLen = 200
)

// validateLinks trims links, drops blanks and duplicates, and rejects anything
// that is not a plain https:// URL with a host and no credentials.
func validateLinks(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		l := strings.TrimSpace(raw)
		if l == "" || seen[l] {
			continue
		}
		if utf8.RuneCountInString(l) > maxLinkLen {
			return nil, httpx.BadRequest("BAD_LINK", "links can be at most 200 characters")
		}
		if strings.IndexFunc(l, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) }) >= 0 {
			return nil, httpx.BadRequest("BAD_LINK", "links cannot contain spaces or control characters")
		}
		u, err := url.Parse(l)
		if err != nil || !strings.EqualFold(u.Scheme, "https") || u.User != nil || u.Hostname() == "" || u.Opaque != "" {
			return nil, httpx.BadRequest("BAD_LINK", "use a full https:// link")
		}
		seen[l] = true
		out = append(out, l)
	}
	if len(out) > maxLinks {
		return nil, httpx.BadRequest("BAD_LINK", "add at most 5 links")
	}
	return out, nil
}
