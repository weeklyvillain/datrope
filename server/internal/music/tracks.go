package music

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// coverPath is where a cover image is served.
func coverPath(sum string) string {
	if sum == "" {
		return ""
	}
	return "/api/music/covers/" + sum
}

func linkTrack(r Resolved) MusicTrack {
	return MusicTrack{Title: r.Title, Artist: r.Artist, URL: r.URL, Duration: r.Duration, Source: "link", Site: r.Site,
		thumb: r.Thumbnail, live: r.Live}
}

func libraryTrackOf(lt LibraryTrack) MusicTrack {
	return MusicTrack{Title: lt.Title, Artist: lt.Artist, Duration: lt.Duration, Source: "upload", Cover: lt.Cover,
		blob: lt.sum, opus: lt.format == "opus", libraryID: lt.ID, coverSum: lt.coverSum}
}

func spotifyTrack(st SpotifyTrack) MusicTrack {
	search := st.Title
	if st.Artist != "" {
		search = st.Artist + " - " + st.Title
	}
	return MusicTrack{Title: st.Title, Artist: st.Artist, Duration: st.Duration, Source: "link", Site: "spotify",
		search: search, thumb: st.Cover}
}

// IsSpotify reports whether a link is Spotify's.
func IsSpotify(link string) bool {
	u, err := url.Parse(link)
	return err == nil && (u.Host == "open.spotify.com" || u.Host == "spotify.link")
}

// lookup turns what someone typed into tracks: a link (with playlist, every
// track of the playlist it is in), a Spotify link, or YouTube search words.
// title is the playlist's, when there is one.
func (s *Service) lookup(ctx context.Context, query string, playlist bool) (tracks []MusicTrack, title string, dropped int, err error) {
	if s.resolver == nil {
		return nil, "", 0, unavailable("links and searches are not set up on this server (it needs yt-dlp); play from the library instead")
	}
	if strings.Contains(query, "://") && !IsLink(query) {
		return nil, "", 0, httpx.BadRequest("BAD_QUERY", "use a web link or search words")
	}
	if IsLink(query) && IsSpotify(query) {
		if s.spotify == nil {
			return nil, "", 0, unavailable("Spotify links are not set up on this server")
		}
		title, list, err := s.spotify.SpotifyTracks(ctx, query)
		if errors.Is(err, ErrSpotifyOff) {
			return nil, "", 0, unavailable("Spotify links are not set up on this server")
		}
		if errors.Is(err, ErrNotFound) {
			return nil, "", 0, httpx.NotFound("track")
		}
		if err != nil {
			return nil, "", 0, httpx.BadRequest("NOT_PLAYABLE", "that Spotify link could not be read")
		}
		for _, st := range list {
			tracks = append(tracks, spotifyTrack(st))
		}
		if len(tracks) == 0 {
			return nil, "", 0, httpx.NotFound("track")
		}
		return tracks, title, 0, nil
	}
	if playlist && IsLink(query) {
		pl, err := s.resolver.ResolvePlaylist(ctx, query)
		if errors.Is(err, ErrNotFound) || (err == nil && len(pl.Tracks) == 0) {
			return nil, "", pl.Dropped, httpx.NotFound("playlist")
		}
		if err != nil {
			return nil, "", 0, httpx.BadRequest("NOT_PLAYABLE", "that playlist could not be read")
		}
		for _, r := range pl.Tracks {
			tracks = append(tracks, linkTrack(r))
		}
		return tracks, pl.Title, pl.Dropped, nil
	}
	r, err := s.resolver.Resolve(ctx, query)
	if errors.Is(err, ErrNotFound) {
		return nil, "", 0, httpx.NotFound("track")
	}
	if err != nil {
		return nil, "", 0, httpx.BadRequest("NOT_PLAYABLE", "that could not be found or played")
	}
	return []MusicTrack{linkTrack(r)}, "", 0, nil
}

// stamp gives queued tracks their IDs and requester.
func stamp(tracks []MusicTrack, by id.ID) []MusicTrack {
	for i := range tracks {
		tracks[i].ID, tracks[i].RequestedBy = id.New(), by
	}
	return tracks
}

// CoverHandler serves GET /api/music/covers/{sum}: a library track's or
// playlist item's cover image.
func (s *Service) CoverHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sum := r.PathValue("sum")
		var ct string
		err := s.db.QueryRow(r.Context(), `SELECT cover_type FROM music_tracks WHERE cover = $1
			UNION ALL SELECT cover_type FROM music_playlist_items WHERE cover = $1 LIMIT 1`, sum).Scan(&ct)
		if err != nil {
			httpx.WriteHTTPError(w, r, httpx.NotFound("cover"))
			return
		}
		s.blobs.ServeBlob(w, r, sum, ct, true) // named by its content: it never changes
	})
}

// thumbHosts are the CDNs whose thumbnails the server downloads for saved
// playlist items (so browsers never load them from the sites themselves).
var thumbHosts = []string{".ytimg.com", ".sndcdn.com", ".bcbits.com", ".vimeocdn.com", ".scdn.co"}

func thumbAllowed(u *url.URL) bool {
	if u.Scheme != "https" {
		return false
	}
	h := "." + strings.ToLower(u.Hostname())
	for _, suffix := range thumbHosts {
		if strings.HasSuffix(h, suffix) {
			return true
		}
	}
	return false
}

var thumbClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || !thumbAllowed(req.URL) {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

const maxThumbBytes = 5 << 20

// fetchThumb downloads a thumbnail from an allowed CDN.
func fetchThumb(ctx context.Context, raw string) ([]byte, error) {
	u, err := url.Parse(raw)
	if err != nil || !thumbAllowed(u) {
		return nil, errors.New("thumbnail host not allowed")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := thumbClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("thumbnail: " + resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxThumbBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxThumbBytes {
		return nil, errors.New("thumbnail too large")
	}
	return data, nil
}
