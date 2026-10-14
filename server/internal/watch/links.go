package watch

import (
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// The kinds of thing a channel can watch.
const (
	KindYouTube    = "youtube"
	KindTwitchLive = "twitch_live"
	KindTwitchVOD  = "twitch_vod"
)

// ErrUnsupportedLink: not a YouTube video, Twitch channel or Twitch VOD.
var ErrUnsupportedLink = errors.New("watch: unsupported link")

var (
	ytID       = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	twitchName = regexp.MustCompile(`^[A-Za-z0-9_]{3,25}$`)
	digits     = regexp.MustCompile(`^\d+$`)
	hms        = regexp.MustCompile(`^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$`)
)

// Twitch paths that look like a channel name but are not one (the same list as clients/web/src/lib/players.ts).
var twitchReserved = map[string]bool{
	"directory": true, "videos": true, "settings": true, "subscriptions": true, "inventory": true, "wallet": true,
	"downloads": true, "jobs": true, "p": true, "search": true, "turbo": true,
}

// Link is a parsed watchable link: what it is, its ID on its site, its canonical URL and where to start.
type Link struct {
	Kind    string
	VideoID string  // YouTube video ID, Twitch login (lower case) or VOD ID
	URL     string  // canonical
	Start   float64 // seconds; always 0 for a live stream
}

// ParseLink recognises YouTube videos and Twitch channels and VODs.
func ParseLink(raw string) (Link, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return Link{}, ErrUnsupportedLink
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	parts := strings.FieldsFunc(u.Path, func(r rune) bool { return r == '/' })
	switch host {
	case "youtu.be":
		if len(parts) == 1 {
			return youtube(parts[0], u)
		}
	case "youtube.com", "m.youtube.com", "music.youtube.com":
		if len(parts) == 1 && parts[0] == "watch" {
			return youtube(u.Query().Get("v"), u)
		}
		if len(parts) == 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") {
			return youtube(parts[1], u)
		}
	case "twitch.tv", "m.twitch.tv":
		if len(parts) == 2 && parts[0] == "videos" && digits.MatchString(parts[1]) {
			return Link{Kind: KindTwitchVOD, VideoID: parts[1], URL: "https://www.twitch.tv/videos/" + parts[1], Start: seconds(u.Query().Get("t"))}, nil
		}
		if len(parts) == 1 && twitchName.MatchString(parts[0]) && !twitchReserved[strings.ToLower(parts[0])] {
			login := strings.ToLower(parts[0])
			return Link{Kind: KindTwitchLive, VideoID: login, URL: "https://www.twitch.tv/" + login}, nil
		}
	}
	return Link{}, ErrUnsupportedLink
}

func youtube(videoID string, u *url.URL) (Link, error) {
	if !ytID.MatchString(videoID) {
		return Link{}, ErrUnsupportedLink
	}
	q := u.Query()
	t := q.Get("t")
	if t == "" {
		t = q.Get("start")
	}
	return Link{Kind: KindYouTube, VideoID: videoID, URL: "https://www.youtube.com/watch?v=" + videoID, Start: seconds(t)}, nil
}

// seconds reads "90", "90s" or "1h2m3s"; anything else is 0.
func seconds(t string) float64 {
	if t == "" {
		return 0
	}
	if digits.MatchString(t) {
		n, _ := strconv.Atoi(t)
		return float64(n)
	}
	m := hms.FindStringSubmatch(t)
	if m == nil {
		return 0
	}
	n := func(s string) float64 {
		v, _ := strconv.Atoi(s)
		return float64(v)
	}
	return n(m[1])*3600 + n(m[2])*60 + n(m[3])
}
