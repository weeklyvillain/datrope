package push

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
)

func TestBody(t *testing.T) {
	cases := map[string]struct {
		content string
		files   int
		want    string
	}{
		"plain":      {"see you at 8", 0, "see you at 8"},
		"spoiler":    {"the killer is ||the butler||", 0, "the killer is (spoiler)"},
		"link":       {"look [here](https://x.example)", 0, "look here"},
		"bold":       {"**big** and __under__ and ~~gone~~ and `code`", 0, "big and under and gone and code"},
		"italic":     {"so *very* nice", 0, "so very nice"},
		"heading":    {"# Title\n- item\n> quote", 0, "Title item quote"},
		"code block": {"```go\nfmt.Println()\n```", 0, "fmt.Println()"},
		"one file":   {"", 1, "Sent a file"},
		"files":      {"  ", 3, "Sent 3 files"},
		"empty":      {"", 0, ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) { require.Equal(t, c.want, body(c.content, c.files)) })
	}
}

func TestBodyCutsAt120Runes(t *testing.T) {
	got := body(strings.Repeat("é", 200), 0)
	require.Equal(t, 120, len([]rune(got)))
	require.True(t, strings.HasSuffix(got, "…"))
}

func TestTitleAndTarget(t *testing.T) {
	parentID := id.ID(7)
	general := &channels.Channel{ID: 7, Type: "text", Name: "general"}
	thread := &channels.Channel{ID: 9, Type: "thread", Name: "plans", ParentChannelID: &parentID}
	dm := &channels.Channel{ID: 5, Type: "dm"}

	require.Equal(t, "alice in #general", title("alice", false, general, nil))
	require.Equal(t, "hook (webhook) in #general", title("hook", true, general, nil))
	require.Equal(t, "alice (direct message)", title("alice", false, dm, nil))
	require.Equal(t, "alice in Trip crew", title("alice", false, &channels.Channel{ID: 6, Type: "dm", Group: true, Name: "Trip crew"}, nil))
	require.Equal(t, "alice (direct message)", title("alice", false, &channels.Channel{ID: 6, Type: "dm", Group: true}, nil), "unnamed group")
	require.Equal(t, "alice in #general", title("alice", false, thread, general), "threads use the parent's name")
	require.Equal(t, "alice in #plans", title("alice", false, thread, nil), "parent unknown: the thread's own name")

	u, tag := target(general)
	require.Equal(t, "/channels/7", u)
	require.Equal(t, "channel:7", tag)
	u, tag = target(dm)
	require.Equal(t, "/messages/5", u)
	require.Equal(t, "channel:5", tag)
	u, tag = target(thread)
	require.Equal(t, "/channels/7", u, "threads open their parent")
	require.Equal(t, "channel:9", tag)
}
