package linkpreview

import (
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsYouTube(t *testing.T) {
	for _, s := range []string{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://M.YouTube.com/shorts/x", "https://music.youtube.com/watch?v=x"} {
		u, _ := url.Parse(s)
		require.True(t, isYouTube(u), s)
	}
	for _, s := range []string{"https://notyoutube.com/watch", "https://youtube.com.evil.example/", "https://example.com/?u=youtube.com"} {
		u, _ := url.Parse(s)
		require.False(t, isYouTube(u), s)
	}
}

func TestFetchYouTube(t *testing.T) {
	var asked string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r.URL.Query().Get("url")
		if asked == "https://youtu.be/missing0000" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"title":"Never  Gonna Give You Up","author_name":"Rick Astley","provider_name":"YouTube"}`))
	}))
	defer srv.Close()
	old := youtubeOEmbed
	youtubeOEmbed = srv.URL
	defer func() { youtubeOEmbed = old }()

	p, err := fetchYouTube(t.Context(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", allowAll)
	require.NoError(t, err)
	require.Equal(t, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", asked)
	require.Equal(t, &Preview{URL: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5", Site: "YouTube", Title: "Never Gonna Give You Up", Author: "Rick Astley"}, p)

	_, err = fetchYouTube(t.Context(), "https://youtu.be/missing0000", allowAll)
	require.Error(t, err)

	_, err = fetchYouTube(t.Context(), "https://youtu.be/dQw4w9WgXcQ", func(net.IP) bool { return false })
	require.ErrorIs(t, err, ErrBlockedAddress)
}
