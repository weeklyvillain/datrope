package linkpreview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// youtubeOEmbed is YouTube's oEmbed endpoint; tests point it at a fake.
var youtubeOEmbed = "https://www.youtube.com/oembed"

var youtubeHosts = map[string]bool{
	"youtube.com": true, "m.youtube.com": true, "music.youtube.com": true, "youtu.be": true,
}

func isYouTube(u *url.URL) bool {
	return youtubeHosts[strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")]
}

// fetchYouTube asks YouTube's oEmbed for a video's title and channel. Its
// watch pages have no channel in <head> and can be a consent page instead.
func fetchYouTube(ctx context.Context, rawURL string, allow func(net.IP) bool) (*Preview, error) {
	client := NewClient(allow, fetchTimeout)
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		youtubeOEmbed+"?format=json&url="+url.QueryEscape(rawURL), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Datrope link preview (+https://github.com/datrope/datrope)")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("youtube oembed: status %d", res.StatusCode)
	}
	var body struct {
		Title      string `json:"title"`
		AuthorName string `json:"author_name"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, maxBody)).Decode(&body); err != nil {
		return nil, err
	}
	p := &Preview{URL: rawURL, Site: "YouTube", Title: clean(body.Title, maxTitle), Author: clean(body.AuthorName, maxSite)}
	if p.Title == "" {
		return nil, errors.New("youtube oembed: no title")
	}
	return p, nil
}
