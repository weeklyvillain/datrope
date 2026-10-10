package integrations

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/music"
)

// appToken is a Spotify app token (client credentials: no user account),
// for reading the catalog.
type appToken struct {
	mu      sync.Mutex
	value   string
	expires time.Time
}

func (s *Service) spotifyAppToken(ctx context.Context) (string, error) {
	s.app.mu.Lock()
	defer s.app.mu.Unlock()
	if s.app.value != "" && time.Until(s.app.expires) > time.Minute {
		return s.app.value, nil
	}
	t, err := s.token(ctx, "spotify", url.Values{"grant_type": {"client_credentials"}})
	if err != nil {
		return "", err
	}
	s.app.value, s.app.expires = t.AccessToken, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second)
	return t.AccessToken, nil
}

// spotifyRef reads a Spotify link: open.spotify.com/[intl-xx/]{track|album|playlist}/{id}.
func spotifyRef(link string) (kind, ref string, ok bool) {
	u, err := url.Parse(link)
	if err != nil || u.Host != "open.spotify.com" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) > 0 && strings.HasPrefix(parts[0], "intl-") {
		parts = parts[1:]
	}
	if len(parts) < 2 || parts[1] == "" {
		return "", "", false
	}
	switch parts[0] {
	case "track", "album", "playlist":
		return parts[0], parts[1], true
	}
	return "", "", false
}

type spotifyImage struct {
	URL string `json:"url"`
}

type spotifyCatalogTrack struct {
	Name       string `json:"name"`
	DurationMS int    `json:"duration_ms"`
	Artists    []struct {
		Name string `json:"name"`
	} `json:"artists"`
	Album struct {
		Images []spotifyImage `json:"images"`
	} `json:"album"`
}

// cover picks a mid-sized image (Spotify lists the largest first).
func cover(images []spotifyImage) string {
	switch len(images) {
	case 0:
		return ""
	case 1:
		return images[0].URL
	}
	return images[1].URL
}

func (t spotifyCatalogTrack) music(albumCover string) music.SpotifyTrack {
	names := make([]string, 0, len(t.Artists))
	for _, a := range t.Artists {
		names = append(names, a.Name)
	}
	c := cover(t.Album.Images)
	if c == "" {
		c = albumCover
	}
	return music.SpotifyTrack{Title: t.Name, Artist: strings.Join(names, ", "), Duration: t.DurationMS / 1000, Cover: c}
}

// maxSpotifyTracks is the most tracks read from an album or playlist.
const maxSpotifyTracks = 500

// SpotifyTracks reads a Spotify track, album or playlist link with the
// instance's Spotify app credentials, for the music bot.
func (s *Service) SpotifyTracks(ctx context.Context, link string) (string, []music.SpotifyTrack, error) {
	if u, err := url.Parse(link); err == nil && u.Host == "spotify.link" {
		link = s.followShortLink(ctx, link)
	}
	kind, ref, ok := spotifyRef(link)
	if !ok {
		return "", nil, music.ErrNotFound
	}
	token, err := s.spotifyAppToken(ctx)
	if errors.Is(err, ErrNotConfigured) {
		return "", nil, music.ErrSpotifyOff
	}
	if err != nil {
		return "", nil, err
	}
	hdr := http.Header{"Authorization": {"Bearer " + token}}
	get := func(u string, out any) error {
		_, err := s.getJSON(ctx, u, hdr, out)
		var he *httpError
		if errors.As(err, &he) && (he.status == http.StatusNotFound || he.status == http.StatusBadRequest) {
			return music.ErrNotFound
		}
		return err
	}
	base := s.ep.SpotifyAPI + "/v1/"
	ref = url.PathEscape(ref)
	switch kind {
	case "track":
		var t spotifyCatalogTrack
		if err := get(base+"tracks/"+ref, &t); err != nil {
			return "", nil, err
		}
		return t.Name, []music.SpotifyTrack{t.music("")}, nil
	case "album":
		type page struct {
			Items []spotifyCatalogTrack `json:"items"`
			Next  string                `json:"next"`
		}
		var a struct {
			Name   string         `json:"name"`
			Images []spotifyImage `json:"images"`
			Tracks page           `json:"tracks"`
		}
		if err := get(base+"albums/"+ref, &a); err != nil {
			return "", nil, err
		}
		albumCover := cover(a.Images)
		var out []music.SpotifyTrack
		pg := a.Tracks
		for {
			for _, t := range pg.Items {
				out = append(out, t.music(albumCover))
			}
			next := pg.Next
			if next == "" || len(out) >= maxSpotifyTracks || !strings.HasPrefix(next, s.ep.SpotifyAPI+"/") {
				break
			}
			pg = page{}
			if err := get(next, &pg); err != nil {
				break
			}
		}
		return a.Name, out[:min(len(out), maxSpotifyTracks)], nil
	default: // playlist
		type page struct {
			Items []struct {
				Track *spotifyCatalogTrack `json:"track"` // null for removed tracks
			} `json:"items"`
			Next string `json:"next"`
		}
		var p struct {
			Name   string `json:"name"`
			Tracks page   `json:"tracks"`
		}
		if err := get(base+"playlists/"+ref+"?fields=name,tracks(next,items(track(name,duration_ms,artists(name),album(images))))", &p); err != nil {
			return "", nil, err
		}
		var out []music.SpotifyTrack
		pg := p.Tracks
		for {
			for _, it := range pg.Items {
				if it.Track != nil && it.Track.Name != "" {
					out = append(out, it.Track.music(""))
				}
			}
			next := pg.Next
			if next == "" || len(out) >= maxSpotifyTracks || !strings.HasPrefix(next, s.ep.SpotifyAPI+"/") {
				break
			}
			pg = page{}
			if err := get(next, &pg); err != nil {
				break
			}
		}
		return p.Name, out[:min(len(out), maxSpotifyTracks)], nil
	}
}

// followShortLink turns a spotify.link short link into the open.spotify.com
// link it redirects to ("" when it doesn't).
func (s *Service) followShortLink(ctx context.Context, link string) string {
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	resp.Body.Close()
	return resp.Header.Get("Location")
}
