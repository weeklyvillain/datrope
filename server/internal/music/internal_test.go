package music

import (
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
)

func TestSourcesNeverAllowGeneric(t *testing.T) {
	require.Equal(t, DefaultSources, sources(nil))
	require.Equal(t, DefaultSources, sources([]string{"generic", "all", "default", ".*", "gen.*", "-youtube", "(", ""}))
	require.Equal(t, []string{"youtube", "soundcloud:.*"}, sources([]string{" youtube ", "generic", "soundcloud:.*"}))
	args := ytDlp{sources: []string{"generic"}}.args("--", "x")
	i := slices.Index(args, "--use-extractors")
	require.GreaterOrEqual(t, i, 0)
	require.NotContains(t, args[i+1], "generic")
}

func TestTarget(t *testing.T) {
	require.Equal(t, "https://youtu.be/x", target("https://youtu.be/x"))
	require.Equal(t, "ytsearch1:never gonna", target("never gonna"))
	require.Equal(t, "ytsearch1:file:///etc/passwd", target("file:///etc/passwd"), "not a link: only ever a search")
}

func TestPlaylistOf(t *testing.T) {
	info := ytInfo{Type: "playlist", Title: "Mix", ExtractorKey: "YoutubeTab", Entries: []ytInfo{
		{Title: "One", URL: "https://www.youtube.com/watch?v=aaa", Duration: 61, IEKey: "Youtube", Channel: "Band"},
		{Title: "[Private video]", URL: "https://www.youtube.com/watch?v=bbb"},
		{Title: "", URL: ""},
		{Title: "Two", WebpageURL: "https://soundcloud.com/a/b", ExtractorKey: "Soundcloud", Thumbnails: []struct {
			URL string `json:"url"`
		}{{"https://i1.sndcdn.com/small.jpg"}, {"https://i1.sndcdn.com/big.jpg"}}},
	}}
	pl := playlistOf(info)
	require.Equal(t, "Mix", pl.Title)
	require.Equal(t, 2, pl.Dropped)
	require.Len(t, pl.Tracks, 2)
	require.Equal(t, Resolved{Title: "One", URL: "https://www.youtube.com/watch?v=aaa", Duration: 61, Artist: "Band",
		Thumbnail: "https://i.ytimg.com/vi/aaa/mqdefault.jpg", Site: "youtube"}, pl.Tracks[0])
	require.Equal(t, "soundcloud", pl.Tracks[1].Site)
	require.Equal(t, "https://i1.sndcdn.com/big.jpg", pl.Tracks[1].Thumbnail)

	single := playlistOf(ytInfo{Title: "Solo", WebpageURL: "https://vimeo.com/1", ExtractorKey: "Vimeo", IsLive: true})
	require.Len(t, single.Tracks, 1)
	require.True(t, single.Tracks[0].Live)
	require.Equal(t, "vimeo", single.Tracks[0].Site)
}

func TestParseTags(t *testing.T) {
	title, artist := parseTags([]byte(";FFMETADATA1\nTITLE=Song\\=Name\nalbum_artist=Various\nartist=Band\n[CHAPTER]\ntitle=Chapter\n"))
	require.Equal(t, "Song=Name", title)
	require.Equal(t, "Band", artist)
	_, artist = parseTags([]byte("album_artist=Various\n"))
	require.Equal(t, "Various", artist)
}

func TestThumbAllowed(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://i.ytimg.com/vi/x/mqdefault.jpg": true,
		"https://i1.sndcdn.com/a.jpg":            true,
		"https://i.scdn.co/image/ab":             true,
		"http://i.ytimg.com/vi/x/a.jpg":          false,
		"https://evilytimg.com/a.jpg":            false,
		"https://127.0.0.1/a.jpg":                false,
		"https://i.ytimg.com.evil.com/a.jpg":     false,
	} {
		u, err := url.Parse(raw)
		require.NoError(t, err)
		require.Equal(t, ok, thumbAllowed(u), raw)
	}
}

func TestNextFollowsRepeat(t *testing.T) {
	track := func(title string) MusicTrack { return MusicTrack{ID: id.New(), Title: title} }
	a, b, c := track("a"), track("b"), track("c")
	p := newPlayer(nil, id.New())
	p.queue = []MusicTrack{a, b}

	require.Equal(t, "a", p.next().Title)
	p.ended = &ended{track: a, natural: true}
	require.Equal(t, "b", p.next().Title, "off: the queue moves on")

	p.repeat = RepeatOne
	p.queue = []MusicTrack{c}
	p.ended = &ended{track: b, natural: true}
	require.Equal(t, "b", p.next().Title, "one: the track replays")
	p.ended = &ended{track: b, natural: false}
	require.Equal(t, "c", p.next().Title, "one: a skip moves on")

	p.repeat = RepeatAll
	p.ended = &ended{track: c, natural: true}
	require.Equal(t, "c", p.next().Title, "all: alone in the queue, it comes back")
	p.queue = []MusicTrack{a}
	p.ended = &ended{track: c, natural: true}
	require.Equal(t, "a", p.next().Title)
	require.Equal(t, []string{"c"}, titles(p.queue), "all: the finished track went to the end")
	p.ended = &ended{track: a, natural: false}
	p.queue = nil
	require.Nil(t, p.next(), "all: a failed or skipped track does not come back")
}

func TestNextTrackLoadsUntilPlaying(t *testing.T) {
	p := newPlayer(nil, id.New())
	p.queue = []MusicTrack{{ID: id.New(), Title: "a"}}

	require.NotNil(t, p.next())
	st := p.snapshotLocked()
	require.True(t, st.Loading, "a picked track loads until its audio starts")
	require.Zero(t, st.Position)
	p.setPaused(true)
	require.False(t, p.paused, "a loading track can't be paused")

	require.Nil(t, p.next())
	require.False(t, p.snapshotLocked().Loading, "nothing playing: nothing loading")
}

func TestShuffleKeepsEveryTrack(t *testing.T) {
	var tracks []MusicTrack
	for i := range 10 {
		tracks = append(tracks, MusicTrack{ID: id.New(), Title: string(rune('a' + i))})
	}
	before := titles(tracks)
	shuffleTracks(tracks)
	after := titles(tracks)
	slices.Sort(after)
	require.Equal(t, before, after)
}

func titles(ts []MusicTrack) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, t.Title)
	}
	return out
}

func TestCache(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "left.ogg.123.part"), []byte("x"), 0o600))
	c, err := newCache(dir, 10)
	require.NoError(t, err)
	_, err = os.Stat(filepath.Join(dir, "left.ogg.123.part"))
	require.True(t, os.IsNotExist(err), "unfinished files are removed at start")

	write := func(page string, data string, commit bool) {
		e := c.create(page)
		require.NotNil(t, e)
		_, _ = e.Write([]byte(data))
		if commit {
			e.commit()
		} else {
			e.abort()
		}
	}
	write("skipped", "123", false)
	require.False(t, c.has("skipped"))
	write("one", "123456", true)
	require.True(t, c.has("one"))
	old := time.Now().Add(-time.Hour)
	require.NoError(t, os.Chtimes(c.path("one"), old, old))
	write("two", "123456", true) // 12 bytes > 10: the least recently played goes
	require.False(t, c.has("one"))
	require.True(t, c.has("two"))
	f, ok := c.open("two")
	require.True(t, ok)
	f.Close()

	require.True(t, cacheable(&MusicTrack{URL: "u", Duration: 200}))
	require.False(t, cacheable(&MusicTrack{URL: "u", Duration: 0}), "unknown length")
	require.False(t, cacheable(&MusicTrack{URL: "u", Duration: maxCachedDuration + 1}), "too long")
	require.False(t, cacheable(&MusicTrack{URL: "u", Duration: 200, live: true}))
	require.False(t, cacheable(&MusicTrack{blob: "b", Duration: 200}), "uploads are stored already")
}
