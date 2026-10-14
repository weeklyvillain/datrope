package watch

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestParseLink(t *testing.T) {
	yt := func(start float64) Link {
		return Link{Kind: KindYouTube, VideoID: "dQw4w9WgXcQ", URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", Start: start}
	}
	ok := []struct {
		in   string
		want Link
	}{
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"  https://youtube.com/watch?v=dQw4w9WgXcQ&t=90  ", yt(90)},
		{"https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s", yt(90)},
		{"https://music.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"https://youtu.be/dQw4w9WgXcQ?t=1h2m3s", yt(3723)},
		{"https://youtu.be/dQw4w9WgXcQ/", yt(0)},
		{"https://www.youtube.com/shorts/dQw4w9WgXcQ", yt(0)},
		{"https://www.youtube.com/live/dQw4w9WgXcQ?start=12", yt(12)},
		{"https://www.youtube.com/embed/dQw4w9WgXcQ", yt(0)},
		{"http://www.youtube.com/watch?v=dQw4w9WgXcQ", yt(0)},
		{"https://www.twitch.tv/xQc", Link{Kind: KindTwitchLive, VideoID: "xqc", URL: "https://www.twitch.tv/xqc"}},
		{"https://m.twitch.tv/xqc/", Link{Kind: KindTwitchLive, VideoID: "xqc", URL: "https://www.twitch.tv/xqc"}},
		{"https://twitch.tv/videos/2281904417", Link{Kind: KindTwitchVOD, VideoID: "2281904417", URL: "https://www.twitch.tv/videos/2281904417"}},
		{"https://www.twitch.tv/videos/2281904417?t=1h2m3s", Link{Kind: KindTwitchVOD, VideoID: "2281904417", URL: "https://www.twitch.tv/videos/2281904417", Start: 3723}},
	}
	for _, c := range ok {
		got, err := ParseLink(c.in)
		require.NoError(t, err, c.in)
		require.Equal(t, c.want, got, c.in)
	}
	bad := []string{
		"", "not a url", "ftp://youtube.com/watch?v=dQw4w9WgXcQ", "https://example.com/watch?v=dQw4w9WgXcQ",
		"https://www.youtube.com/watch?v=short", "https://www.youtube.com/playlist?list=PL123",
		"https://www.twitch.tv/directory", "https://www.twitch.tv/videos", "https://www.twitch.tv/xqc/clip/Funny-abc",
		"https://clips.twitch.tv/Funny-abc", "https://www.twitch.tv/ab",
	}
	for _, in := range bad {
		_, err := ParseLink(in)
		require.ErrorIs(t, err, ErrUnsupportedLink, in)
	}
}
