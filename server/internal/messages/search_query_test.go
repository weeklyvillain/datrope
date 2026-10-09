package messages

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func TestParseQuery(t *testing.T) {
	day := func(s string) time.Time {
		d, err := time.Parse(time.DateOnly, s)
		require.NoError(t, err)
		return d
	}
	tests := []struct {
		in   string
		want Query
		code string
	}{
		{in: "wingspan", want: Query{Text: "wingspan", Terms: []string{"wingspan"}}},
		{in: "Wingspan  from:alice", want: Query{Text: "Wingspan", Terms: []string{"wingspan"}, From: "alice"}},
		{in: "from:@Alice board games board", want: Query{Text: "board games board", Terms: []string{"board", "games"}, From: "Alice"}},
		{in: "in:#games has:LINK", want: Query{Terms: []string{}, In: "games", Has: "link"}},
		{in: "in:@bob snacks", want: Query{Text: "snacks", Terms: []string{"snacks"}, In: "@bob"}},
		{in: "before:2026-05-01 after:2026-04-01 x", want: Query{Text: "x", Terms: []string{"x"}, Before: day("2026-05-01"), After: day("2026-04-01")}},
		{in: "from:alice from:bob hi", want: Query{Text: "hi", Terms: []string{"hi"}, From: "bob"}},
		{in: "from: pizza", want: Query{Text: "pizza", Terms: []string{"pizza"}}},
		{in: "see https://example.com now", want: Query{Text: "see https://example.com now", Terms: []string{"see", "https://example.com", "now"}}},
		{in: "cost:5 Café", want: Query{Text: "cost:5 Café", Terms: []string{"cost:5", "café"}}},
		{in: "", code: "EMPTY_QUERY"},
		{in: "   from:  ", code: "EMPTY_QUERY"},
		{in: "?!", code: "EMPTY_QUERY"},
		{in: "has:image", code: "INVALID_QUERY"},
		{in: "before:May", code: "INVALID_QUERY"},
		{in: "after:2026-13-01", code: "INVALID_QUERY"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			got, err := ParseQuery(tt.in)
			if tt.code != "" {
				var he *httpx.Error
				require.ErrorAs(t, err, &he)
				require.Equal(t, tt.code, he.Code)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tt.want, got)
		})
	}
}
