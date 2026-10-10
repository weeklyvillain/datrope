package gifs

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"

	"github.com/datrope/datrope/server/internal/id"
)

// DefaultKlipyURL is Klipy's API. Tests point the service at a fake instead.
const DefaultKlipyURL = "https://api.klipy.com"

// errUpstream wraps every Klipy failure. Its messages never contain request
// URLs, because those carry the API key.
var errUpstream = errors.New("klipy request failed")

// maxListBody bounds a list response; a page of 24 GIFs is about 30 KB.
const maxListBody = 4 << 20

// klipyPage is Klipy's list response (trending, search, items):
// {"result": true, "data": {"data": [...], "current_page": 1, "per_page": 24, "has_next": true}}.
type klipyPage struct {
	Result bool `json:"result"`
	Data   struct {
		Data    []klipyItem `json:"data"`
		HasNext bool        `json:"has_next"`
	} `json:"data"`
}

// klipyItem is one list entry. GIFs have type "gif"; ad slots have type "ad"
// and no files.
type klipyItem struct {
	Type  string `json:"type"`
	Slug  string `json:"slug"`
	Title string `json:"title"`
	// File maps a size (hd, md, sm, xs) to its formats (gif, webp, jpg, mp4, webm).
	File map[string]map[string]klipyFile `json:"file"`
}

type klipyFile struct {
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Size   int64  `json:"size"`
}

type klipy struct {
	base   string // e.g. https://api.klipy.com
	client *http.Client
}

// list calls GET /api/v1/{key}/gifs/{endpoint}; endpoint is trending, search or items.
func (k *klipy) list(ctx context.Context, key, endpoint string, q url.Values) (*klipyPage, error) {
	u := k.base + "/api/v1/" + url.PathEscape(key) + "/gifs/" + endpoint + "?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: bad request", errUpstream)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUpstream, redact(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: status %d", errUpstream, resp.StatusCode)
	}
	var p klipyPage
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxListBody)).Decode(&p); err != nil {
		return nil, fmt.Errorf("%w: %v", errUpstream, err)
	}
	if !p.Result {
		return nil, fmt.Errorf("%w: result false", errUpstream)
	}
	return &p, nil
}

// download opens a media file. Its URL came from Klipy, never from a client.
func (k *klipy) download(ctx context.Context, rawURL string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: bad media URL", errUpstream)
	}
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUpstream, redact(err))
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("%w: media status %d", errUpstream, resp.StatusCode)
	}
	return resp.Body, nil
}

// redact drops the URL from a transport error: Klipy's URLs contain the API key.
func redact(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// slugPattern is what a GIF id (Klipy's slug) may look like. No commas: the
// items endpoint takes a comma-separated list.
var slugPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,200}$`)

// isGIF reports whether a list entry is a GIF we can serve. Ad slots and
// other types are not; Klipy's docs always show type "gif" on GIFs, and an
// entry without a type is accepted.
func isGIF(it klipyItem) bool {
	return (it.Type == "gif" || it.Type == "") && slugPattern.MatchString(it.Slug)
}

var (
	sizes = []string{"hd", "md", "sm", "xs"} // largest first
	// stored lists the formats a posted GIF may be stored in, best first.
	stored = []string{"mp4", "webp", "gif"}
	// previews lists the small animated images a picker shows, best first.
	previews = [][2]string{{"sm", "webp"}, {"xs", "webp"}, {"sm", "gif"}, {"xs", "gif"}, {"md", "webp"}, {"md", "gif"}}
)

// preview picks the small animated image the picker shows.
func preview(it klipyItem) (klipyFile, bool) {
	for _, p := range previews {
		if f, ok := it.File[p[0]][p[1]]; ok && f.URL != "" {
			return f, true
		}
	}
	return klipyFile{}, false
}

// rendition picks the file to store: MP4 if any size fits under limit, else
// WebP, else GIF, and within a format the largest size that fits. A size of
// 0 (unknown) is tried; the download is capped anyway.
func rendition(it klipyItem, limit int64) (klipyFile, string, bool) {
	for _, format := range stored {
		for _, size := range sizes {
			f, ok := it.File[size][format]
			if ok && f.URL != "" && f.Size <= limit {
				return f, format, true
			}
		}
	}
	return klipyFile{}, "", false
}

// customerID is Klipy's customer_id for a user: an HMAC of the user ID keyed
// by the instance secret. Klipy can tell users apart without learning who
// they are.
func customerID(secret []byte, userID id.ID) string {
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(userID.String()))
	return hex.EncodeToString(m.Sum(nil))
}
