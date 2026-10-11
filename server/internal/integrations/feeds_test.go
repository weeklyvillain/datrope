package integrations

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func parseTestdata(t *testing.T, name string) *feed {
	t.Helper()
	r, err := os.Open(filepath.Join("testdata", name))
	require.NoError(t, err)
	defer r.Close()
	f, err := parseFeed(r)
	require.NoError(t, err)
	return f
}

func TestParseFeed(t *testing.T) {
	steam := parseTestdata(t, "steam.xml")
	require.Equal(t, "730 RSS Feed", steam.Title)
	require.Len(t, steam.Entries, 3)
	require.Equal(t, feedEntry{
		ID:    "https://store.steampowered.com/news/app/730/view/3",
		Title: "Counter-Strike 2 Update",
		Link:  "https://store.steampowered.com/news/app/730/view/3",
		Body:  `<p class="bb_paragraph">\[ MISC ]</p><ul class="bb_ul"><li><p class="bb_paragraph">Added a ping icon for dropped defuse kits</p></li></ul>`,
	}, steam.Entries[0])
	require.Equal(t, "Rush Hour", steam.Entries[1].Title)
	require.Equal(t, "https://store.steampowered.com/news/app/730/view/1", steam.Entries[2].ID, "no <guid>: the link identifies it")

	atom := parseTestdata(t, "atom.xml")
	require.Equal(t, "Example Blog", atom.Title)
	require.Equal(t, feedEntry{ID: "tag:example.com,2026:2", Title: "Two &amp; more", Link: "https://example.com/posts/2", Body: "<p>Second post</p>"}, atom.Entries[0])
	require.Equal(t, "https://example.com/posts/1", atom.Entries[1].Link)
	require.Equal(t, "Older <b>summary</b>", atom.Entries[1].Body, "no content: the summary")

	// Not UTF-8, and an HTML entity XML doesn't define.
	latin, err := parseFeed(strings.NewReader("<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><rss><channel><title>Caf\xe9&nbsp;news</title></channel></rss>"))
	require.NoError(t, err)
	require.Equal(t, "Caf\u00e9\u00a0news", latin.Title)

	_, err = parseFeed(strings.NewReader("<html><body>nope</body></html>"))
	require.ErrorIs(t, err, errNotFeed)
	_, err = parseFeed(strings.NewReader("not xml"))
	require.ErrorIs(t, err, errNotFeed)
}

func TestFeedMessage(t *testing.T) {
	steam := parseTestdata(t, "steam.xml")
	require.Equal(t, "📰 **Counter-Strike 2 Update**\n\\[ MISC \\]\n\n- Added a ping icon for dropped defuse kits\nhttps://store.steampowered.com/news/app/730/view/3",
		feedMessage(steam.Entries[0]))

	atom := parseTestdata(t, "atom.xml")
	require.Equal(t, "📰 **Two & more**\nSecond post\nhttps://example.com/posts/2", feedMessage(atom.Entries[0]))

	long := feedMessage(feedEntry{Title: "Big *patch*", Link: "javascript:alert(1)", Body: "<p>" + strings.Repeat("word ", 400) + "</p>"})
	require.True(t, strings.HasPrefix(long, "📰 **Big \\*patch\\***\nword word"), long)
	require.True(t, strings.HasSuffix(long, "word…"), "cut, and the javascript: link dropped")
	require.LessOrEqual(t, utf8.RuneCountInString(long), maxFeedBody+30)

	require.Equal(t, "📰 **New post**\nhttps://example.com/x", feedMessage(feedEntry{Link: "https://example.com/x"}))

	huge := feedMessage(feedEntry{Title: strings.Repeat("t", 300), Link: "https://example.com/" + strings.Repeat("a", 3000)})
	require.Equal(t, "📰 **"+strings.Repeat("t", maxFeedTitle)+"…**", huge, "title cut, long link dropped")
}
