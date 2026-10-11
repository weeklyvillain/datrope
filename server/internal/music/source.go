package music

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

// Resolved is what a link or a search found.
type Resolved struct {
	Title     string
	URL       string // the page, kept to find a fresh stream when the track plays
	Duration  int    // seconds
	Artist    string
	Thumbnail string // an image URL on the site's CDN; "" when unknown
	Site      string // the yt-dlp extractor, lower case: "youtube", "soundcloud", ...
	Live      bool
}

// LinkPlaylist is what a playlist link lists.
type LinkPlaylist struct {
	Title   string
	Tracks  []Resolved
	Dropped int // entries that were private, deleted or otherwise unplayable
}

// Resolver finds tracks: yt-dlp, or a fake in tests.
type Resolver interface {
	// Resolve looks up a link, or searches YouTube for any other text.
	Resolve(ctx context.Context, input string) (Resolved, error)
	// ResolvePlaylist lists a playlist link's tracks (at most maxPlaylist).
	ResolvePlaylist(ctx context.Context, link string) (LinkPlaylist, error)
	// Stream returns something ffmpeg can read for a page: a media URL.
	Stream(ctx context.Context, pageURL string) (string, error)
}

// ErrNotFound: nothing matched the link or search.
var ErrNotFound = errors.New("music: nothing found")

// DefaultSources are the yt-dlp extractors links may use (regexes, matched in
// full against lower-case extractor names). The generic extractor, which
// fetches any URL, is never allowed: it would let members make the server
// request internal addresses.
var DefaultSources = []string{`youtube(:.*)?`, `soundcloud(:.*)?`, `bandcamp(:.*)?`, `vimeo(:.*)?`}

// sources drops "generic" and anything that could match it.
func sources(list []string) []string {
	var out []string
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" || strings.HasPrefix(s, "-") || matchesGeneric(s) {
			continue
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return DefaultSources
	}
	return out
}

// matchesGeneric reports whether a pattern is one of yt-dlp's aliases, is not
// a valid regex, or would let the generic extractor through.
func matchesGeneric(pattern string) bool {
	switch strings.ToLower(pattern) {
	case "all", "default", "end":
		return true
	}
	re, err := regexp.Compile("(?i)^(?:" + pattern + ")$")
	return err != nil || re.MatchString("generic")
}

type ytDlp struct {
	path    *YtDlpPath
	sources []string
}

// args are the options every call gets: no config files, and only the allowed extractors.
func (y ytDlp) args(extra ...string) []string {
	return append([]string{"--no-warnings", "--ignore-config", "--use-extractors", strings.Join(sources(y.sources), ",")}, extra...)
}

func (y ytDlp) run(ctx context.Context, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, y.path.Get(), y.args(args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if strings.Contains(msg, "Unsupported URL") || strings.Contains(msg, "No suitable extractor") {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("yt-dlp: %w: %s", err, msg)
	}
	return out, nil
}

// IsLink reports whether input is a web link rather than search words.
func IsLink(input string) bool {
	return strings.HasPrefix(input, "https://") || strings.HasPrefix(input, "http://")
}

// target is what yt-dlp gets: a link as is, anything else as a YouTube search
// (done here, not with --default-search, which goes through the generic extractor).
func target(input string) string {
	if IsLink(input) {
		return input
	}
	return "ytsearch1:" + input
}

type ytInfo struct {
	Type         string  `json:"_type"`
	Title        string  `json:"title"`
	WebpageURL   string  `json:"webpage_url"`
	URL          string  `json:"url"`
	Duration     float64 `json:"duration"`
	Artist       string  `json:"artist"`
	Uploader     string  `json:"uploader"`
	Channel      string  `json:"channel"`
	Thumbnail    string  `json:"thumbnail"`
	ExtractorKey string  `json:"extractor_key"`
	IEKey        string  `json:"ie_key"`
	IsLive       bool    `json:"is_live"`
	LiveStatus   string  `json:"live_status"`
	Thumbnails   []struct {
		URL string `json:"url"`
	} `json:"thumbnails"`
	Entries []ytInfo `json:"entries"`
}

func (i ytInfo) resolved() Resolved {
	page := i.WebpageURL
	if page == "" {
		page = i.URL
	}
	artist := i.Artist
	if artist == "" {
		artist = i.Uploader
	}
	if artist == "" {
		artist = i.Channel
	}
	thumb := i.Thumbnail
	if thumb == "" && len(i.Thumbnails) > 0 {
		thumb = i.Thumbnails[len(i.Thumbnails)-1].URL // yt-dlp lists them smallest first
	}
	site := i.ExtractorKey
	if site == "" {
		site = i.IEKey
	}
	site, _, _ = strings.Cut(strings.ToLower(site), ":")
	site = strings.TrimSuffix(site, "tab")
	return Resolved{Title: i.Title, URL: page, Duration: int(i.Duration), Artist: artist, Thumbnail: thumb, Site: site,
		Live: i.IsLive || i.LiveStatus == "is_live"}
}

func (y ytDlp) Resolve(ctx context.Context, input string) (Resolved, error) {
	out, err := y.run(ctx, "--no-playlist", "--dump-single-json", "--", target(input))
	if err != nil {
		return Resolved{}, err
	}
	var info ytInfo
	if err := json.Unmarshal(out, &info); err != nil {
		return Resolved{}, err
	}
	if info.Type == "playlist" { // a search: its one result
		if len(info.Entries) == 0 {
			return Resolved{}, ErrNotFound
		}
		info = info.Entries[0]
	}
	r := info.resolved()
	if r.URL == "" {
		return Resolved{}, ErrNotFound
	}
	return r, nil
}

// maxPlaylist is the most tracks read from a playlist link.
const maxPlaylist = 500

func (y ytDlp) ResolvePlaylist(ctx context.Context, link string) (LinkPlaylist, error) {
	if !IsLink(link) {
		return LinkPlaylist{}, ErrNotFound
	}
	// --flat-playlist lists entries without opening each one: seconds, not minutes.
	out, err := y.run(ctx, "--yes-playlist", "--flat-playlist", "--dump-single-json", "--playlist-end", fmt.Sprint(maxPlaylist), "--", link)
	if err != nil {
		return LinkPlaylist{}, err
	}
	var info ytInfo
	if err := json.Unmarshal(out, &info); err != nil {
		return LinkPlaylist{}, err
	}
	return playlistOf(info), nil
}

// playlistOf turns yt-dlp's playlist JSON into tracks, dropping unplayable entries.
func playlistOf(info ytInfo) LinkPlaylist {
	if info.Type != "playlist" {
		r := info.resolved()
		if r.URL == "" {
			return LinkPlaylist{}
		}
		return LinkPlaylist{Title: r.Title, Tracks: []Resolved{r}}
	}
	pl := LinkPlaylist{Title: info.Title}
	for _, e := range info.Entries {
		r := e.resolved()
		if r.URL == "" || r.Title == "" || r.Title == "[Private video]" || r.Title == "[Deleted video]" {
			pl.Dropped++
			continue
		}
		if r.Site == "" {
			r.Site = info.resolved().Site
		}
		if r.Thumbnail == "" {
			r.Thumbnail = youTubeThumb(r.URL)
		}
		pl.Tracks = append(pl.Tracks, r)
		if len(pl.Tracks) == maxPlaylist {
			break
		}
	}
	return pl
}

// youTubeThumb is a YouTube video's standard thumbnail (flat playlist entries don't always list one).
func youTubeThumb(page string) string {
	u, err := url.Parse(page)
	if err != nil || !strings.HasSuffix(u.Hostname(), "youtube.com") {
		return ""
	}
	if v := u.Query().Get("v"); v != "" {
		return "https://i.ytimg.com/vi/" + url.PathEscape(v) + "/mqdefault.jpg"
	}
	return ""
}

func (y ytDlp) Stream(ctx context.Context, pageURL string) (string, error) {
	out, err := y.run(ctx, "--no-playlist", "-f", "bestaudio/best", "--get-url", "--", pageURL)
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if line == "" {
		return "", ErrNotFound
	}
	return line, nil
}

// opusArgs encode to 48 kHz stereo Opus in Ogg pages of 20 ms: what the bot sends.
var opusArgs = []string{"-vn", "-ac", "2", "-ar", "48000", "-c:a", "libopus", "-b:a", "128k", "-frame_duration", "20",
	"-application", "audio", "-f", "ogg", "-page_duration", "20000"}

// ffmpegCmd decodes input (a URL, or stdin when input is "") into Ogg Opus on stdout.
func ffmpegCmd(ctx context.Context, path, input string, stdin io.Reader) *exec.Cmd {
	args := []string{"-hide_banner", "-loglevel", "error"}
	if input == "" {
		args = append(args, "-i", "pipe:0")
	} else {
		args = append(args, "-nostdin", "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", input)
	}
	args = append(append(args, opusArgs...), "pipe:1")
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = stdin
	return cmd
}
