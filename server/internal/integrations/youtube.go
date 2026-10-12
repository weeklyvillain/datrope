package integrations

import (
	"context"
	"encoding/xml"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	ytChannelID = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)
	ytHandle    = regexp.MustCompile(`^@[A-Za-z0-9._-]{3,30}$`)
	ytCanonical = regexp.MustCompile(`<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_-]{22})"`)
	ytExternal  = regexp.MustCompile(`"externalId":"(UC[A-Za-z0-9_-]{22})"`)
)

type ytFeed struct {
	Title   string `xml:"title"`
	Entries []struct {
		VideoID string `xml:"videoId"`
		Title   string `xml:"title"`
	} `xml:"entry"`
}

// youtubeChannelRef turns what someone typed (a channel URL, an @handle or a
// channel ID) into a channel ID, or a page to look it up on.
func youtubeChannelRef(input string) (channelID, page string, ok bool) {
	in := strings.TrimSpace(input)
	if ytChannelID.MatchString(in) {
		return in, "", true
	}
	if ytHandle.MatchString(in) {
		return "", "/" + in, true
	}
	u, err := url.Parse(in)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", "", false
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	if host != "youtube.com" && host != "m.youtube.com" {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	switch {
	case len(parts) >= 2 && parts[0] == "channel" && ytChannelID.MatchString(parts[1]):
		return parts[1], "", true
	case len(parts) >= 1 && ytHandle.MatchString(parts[0]):
		return "", "/" + parts[0], true
	case len(parts) >= 2 && (parts[0] == "c" || parts[0] == "user"):
		return "", "/" + parts[0] + "/" + url.PathEscape(parts[1]), true
	}
	return "", "", false
}

// resolveYouTube returns the channel ID and name for what someone typed.
func (s *Service) resolveYouTube(ctx context.Context, input string) (channelID, name string, err error) {
	channelID, page, ok := youtubeChannelRef(input)
	if !ok {
		return "", "", errBadAccount("use a YouTube channel link, an @handle or a channel ID")
	}
	if channelID == "" {
		body, err := s.fetch(ctx, s.ep.YouTube+page)
		if err != nil {
			return "", "", errBadAccount("that YouTube channel was not found")
		}
		m := ytCanonical.FindStringSubmatch(body)
		if m == nil {
			m = ytExternal.FindStringSubmatch(body)
		}
		if m == nil {
			return "", "", errBadAccount("that YouTube channel was not found")
		}
		channelID = m[1]
	}
	feed, err := s.youtubeFeed(ctx, channelID)
	if err != nil {
		return "", "", errBadAccount("that YouTube channel was not found")
	}
	return channelID, feed.Title, nil
}

func (s *Service) fetch(ctx context.Context, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept-Language", "en")
	resp, err := s.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", &httpError{status: resp.StatusCode}
	}
	return string(body), nil
}

// youtubeFeed reads a channel's public feed: its newest videos first.
func (s *Service) youtubeFeed(ctx context.Context, channelID string) (*ytFeed, error) {
	body, err := s.fetch(ctx, s.ep.YouTube+"/feeds/videos.xml?channel_id="+url.QueryEscape(channelID))
	if err != nil {
		return nil, err
	}
	var f ytFeed
	if err := xml.Unmarshal([]byte(body), &f); err != nil {
		return nil, err
	}
	f.Title = html.UnescapeString(f.Title)
	return &f, nil
}

// pollYouTube announces each followed channel's newest video once.
func (s *Service) pollYouTube(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, account, display_name, last_item FROM stream_alerts WHERE platform = 'youtube'`)
	if err != nil {
		return err
	}
	type alert struct {
		id, channelID int64
		account, name string
		last          string
	}
	var alerts []alert
	for rows.Next() {
		var a alert
		if err := rows.Scan(&a.id, &a.channelID, &a.account, &a.name, &a.last); err != nil {
			rows.Close()
			return err
		}
		alerts = append(alerts, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	feeds := map[string]*ytFeed{}
	for _, a := range alerts {
		f, ok := feeds[a.account]
		if !ok {
			if f, err = s.youtubeFeed(ctx, a.account); err != nil {
				continue // try again next round
			}
			feeds[a.account] = f
		}
		if len(f.Entries) == 0 || f.Entries[0].VideoID == a.last {
			continue
		}
		v := f.Entries[0]
		if _, err := s.db.Exec(ctx, `UPDATE stream_alerts SET last_item = $2 WHERE id = $1`, a.id, v.VideoID); err != nil {
			return err
		}
		if a.last == "" {
			continue // nothing was known yet: don't announce an old video
		}
		content := "📺 **" + escapeMarkdown(a.name) + "** posted a new video: " + escapeMarkdown(html.UnescapeString(v.Title)) +
			"\nhttps://www.youtube.com/watch?v=" + v.VideoID
		if _, err := s.poster.PostAs(ctx, idOf(a.channelID), "YouTube", content); err != nil {
			return err
		}
	}
	return nil
}
