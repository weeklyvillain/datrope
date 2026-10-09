package messages

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"hi @Alice and @bob", []string{"alice", "bob"}},
		{"@alice @ALICE @alice", []string{"alice"}},
		{"mail me at bob@example.com", nil},
		{"`@alice` in code", nil},
		{"```\n@alice\n```\n@bob", []string{"bob"}},
		{"(@carol.x) @d", []string{"carol.x"}}, // @d is too short
		{"thanks @bob.", []string{"bob"}},
		{"@a_b-c.d!", []string{"a_b-c.d"}},
		{"@" + strings.Repeat("x", 33), nil},
	}
	for _, c := range cases {
		require.Equal(t, c.want, parseMentions(c.in), c.in)
	}
	var many strings.Builder
	for i := 0; i < 30; i++ {
		fmt.Fprintf(&many, "@user%02d ", i)
	}
	require.Len(t, parseMentions(many.String()), 20)
}
