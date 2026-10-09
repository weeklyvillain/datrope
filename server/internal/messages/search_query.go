package messages

import (
	"strings"
	"time"
	"unicode"

	"github.com/datrope/datrope/server/internal/httpx"
)

// Query is a parsed search box: words plus operators (mockup Search.html).
type Query struct {
	Text   string    // the words, operators removed, as typed
	Terms  []string  // lower-cased whitespace-separated words of Text, edge punctuation trimmed, no duplicates: what is highlighted
	From   string    // a username, without "@"
	In     string    // a channel name without "#", or "@username" for DMs with that person
	Has    string    // "link" or "file"
	Before time.Time // a date (midnight UTC); zero when unset
	After  time.Time
}

func isOperator(key string) bool {
	switch key {
	case "from", "in", "has", "before", "after":
		return true
	}
	return false
}

// ParseQuery splits raw into words and operators. A repeated operator keeps
// its last value; an operator with no value yet ("from:") is ignored.
func ParseQuery(raw string) (Query, error) {
	var q Query
	var words []string
	for _, tok := range strings.Fields(raw) {
		key, val, ok := strings.Cut(tok, ":")
		key = strings.ToLower(key)
		if !ok || !isOperator(key) {
			words = append(words, tok)
			continue
		}
		if val == "" {
			continue
		}
		switch key {
		case "from":
			q.From = strings.TrimPrefix(val, "@")
		case "in":
			q.In = strings.TrimPrefix(val, "#")
		case "has":
			v := strings.ToLower(val)
			if v != "link" && v != "file" {
				return Query{}, httpx.BadRequest("INVALID_QUERY", `has: takes "link" or "file"`)
			}
			q.Has = v
		case "before", "after":
			d, err := time.Parse(time.DateOnly, val)
			if err != nil {
				return Query{}, httpx.BadRequest("INVALID_QUERY", "dates look like 2026-05-01")
			}
			if key == "before" {
				q.Before = d
			} else {
				q.After = d
			}
		}
	}
	q.Text = strings.Join(words, " ")
	q.Terms = searchTerms(q.Text)
	if len(q.Terms) == 0 && q.From == "" && q.In == "" && q.Has == "" && q.Before.IsZero() && q.After.IsZero() {
		return Query{}, httpx.BadRequest("EMPTY_QUERY", "type something to search for")
	}
	return q, nil
}

// searchTerms splits text on whitespace, lower-cases the pieces and trims
// punctuation from their ends. Postgres tokenizes the text itself when
// searching (so "example.com" and "board.txt" stay whole); these are for
// highlighting and for telling an empty search from a real one.
func searchTerms(text string) []string {
	seen := map[string]bool{}
	out := []string{}
	edge := func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }
	for _, w := range strings.Fields(strings.ToLower(text)) {
		w = strings.TrimFunc(w, edge)
		if w != "" && !seen[w] {
			seen[w] = true
			out = append(out, w)
		}
	}
	return out
}
