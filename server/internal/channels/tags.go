package channels

import (
	"strings"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/httpx"
)

const (
	maxTagRunes = 24
	maxTags     = 20
)

// normalizeTags trims tags and rejects empty, over-long and duplicate
// (ignoring case) ones, and more than max of them. It never returns nil.
func normalizeTags(in []string, max int) ([]string, error) {
	if len(in) > max {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "too many tags")
	}
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, raw := range in {
		t := strings.TrimSpace(raw)
		if t == "" || utf8.RuneCountInString(t) > maxTagRunes {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "a tag must be 1 to 24 characters")
		}
		k := strings.ToLower(t)
		if seen[k] {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "duplicate tag: "+t)
		}
		seen[k] = true
		out = append(out, t)
	}
	return out, nil
}
