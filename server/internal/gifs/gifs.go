// Package gifs serves /gif (spec §2): it proxies Klipy's trending and search
// lists, and stores a picked GIF on this server as an unsent attachment.
package gifs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

// Config is the instance's Klipy setup (auth.Service implements it).
type Config interface {
	// KlipyConfig returns the Klipy API key ("" when /gif is off) and the instance secret.
	KlipyConfig(ctx context.Context) (apiKey string, secret []byte, err error)
}

// Files stores a picked GIF (files.Service implements it).
type Files interface {
	UploadLimit(ctx context.Context, userID, channelID id.ID) (int64, error)
	SaveGIF(ctx context.Context, channelID, uploaderID id.ID, filename string, body io.Reader, limit int64, width, height int) (*files.Attachment, error)
}

// GIF is one trending or search result. Clients load PreviewURL straight from Klipy's CDN.
type GIF struct {
	ID         string `json:"id" doc:"Pass to POST /api/gifs/{id}/attach"`
	Title      string `json:"title"`
	PreviewURL string `json:"preview_url" doc:"A small animated WebP (or GIF) on Klipy's CDN"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
}

type GIFPage struct {
	Items []GIF  `json:"items"`
	Next  string `json:"next,omitempty" doc:"Pass as pos to get the next page; absent on the last page"`
}

const (
	maxGIFBytes = 8 << 20 // the largest GIF stored, if the upload limit is higher
	perPage     = 24
	maxPage     = 100
	seenFor     = time.Hour // how long a listed GIF can be attached without asking Klipy again
	maxSeen     = 10000
)

type Service struct {
	config      Config
	files       Files
	klipy       *klipy
	listLimit   *ratelimit.Limiter
	attachLimit *ratelimit.Limiter

	// seen remembers the GIFs recently listed, by slug. Klipy's items lookup
	// does not find some GIFs its search returns (seen with mixed-case slugs
	// such as pikachu-1gM--kmTHjZACZ), so Attach looks here first.
	mu   sync.Mutex
	seen map[string]seenGIF
}

type seenGIF struct {
	item klipyItem
	at   time.Time
}

// NewService talks to Klipy at klipyURL ("" for DefaultKlipyURL).
func NewService(cfg Config, f Files, klipyURL string) *Service {
	if klipyURL == "" {
		klipyURL = DefaultKlipyURL
	}
	return &Service{
		config:      cfg,
		files:       f,
		klipy:       &klipy{base: strings.TrimSuffix(klipyURL, "/"), client: &http.Client{Timeout: 20 * time.Second}},
		listLimit:   ratelimit.New(60, 20),
		attachLimit: ratelimit.New(10, 5),
		seen:        map[string]seenGIF{},
	}
}

func providerError() *httpx.Error {
	return httpx.E(http.StatusBadGateway, "GIF_PROVIDER_ERROR", "couldn't reach Klipy, try again")
}

// apiKey returns the Klipy key and the instance secret. Without a key, /gif does not exist (404).
func (s *Service) apiKey(ctx context.Context) (string, []byte, error) {
	key, secret, err := s.config.KlipyConfig(ctx)
	if err != nil {
		return "", nil, err
	}
	if key == "" {
		return "", nil, httpx.NotFound("gifs")
	}
	return key, secret, nil
}

// List returns a page of search results for q, or trending GIFs when q is "".
// pos is the next value of the previous page ("" for the first).
func (s *Service) List(ctx context.Context, userID id.ID, q, pos string) (*GIFPage, error) {
	key, secret, err := s.apiKey(ctx)
	if err != nil {
		return nil, err
	}
	page := 1
	if pos != "" {
		page, err = strconv.Atoi(pos)
		if err != nil || page < 1 || page > maxPage {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "pos must be a next value from a previous page")
		}
	}
	if !s.listLimit.Allow(userID.String()) {
		return nil, httpx.RateLimited()
	}
	params := url.Values{
		"page":        {strconv.Itoa(page)},
		"per_page":    {strconv.Itoa(perPage)},
		"customer_id": {customerID(secret, userID)},
	}
	endpoint := "trending"
	if q != "" {
		endpoint = "search"
		params.Set("q", q)
	}
	p, err := s.klipy.list(ctx, key, endpoint, params)
	if err != nil {
		slog.WarnContext(ctx, "gifs: list", "endpoint", endpoint, "err", err)
		return nil, providerError()
	}
	out := &GIFPage{Items: []GIF{}}
	for _, it := range p.Data.Data {
		if !isGIF(it) { // ad slots and other kinds of content
			continue
		}
		f, ok := preview(it)
		if !ok {
			continue
		}
		out.Items = append(out.Items, GIF{ID: it.Slug, Title: it.Title, PreviewURL: f.URL, Width: f.Width, Height: f.Height})
		s.remember(it)
	}
	if p.Data.HasNext && page < maxPage {
		out.Next = strconv.Itoa(page + 1)
	}
	return out, nil
}

// Attach looks the GIF up with Klipy by its id, downloads its best rendition
// that fits and stores it as an unsent attachment in channelID. It never
// fetches a URL a client supplied.
func (s *Service) Attach(ctx context.Context, userID, channelID id.ID, slug string) (*files.Attachment, error) {
	key, _, err := s.apiKey(ctx)
	if err != nil {
		return nil, err
	}
	if !slugPattern.MatchString(slug) {
		return nil, httpx.NotFound("gif")
	}
	limit, err := s.files.UploadLimit(ctx, userID, channelID)
	if err != nil {
		return nil, err
	}
	limit = min(limit, maxGIFBytes)
	if !s.attachLimit.Allow(userID.String()) {
		return nil, httpx.RateLimited()
	}
	item, err := s.lookUp(ctx, key, slug)
	if err != nil {
		return nil, err
	}
	f, format, ok := rendition(*item, limit)
	if !ok {
		return nil, httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", fmt.Sprintf("this GIF is over the %d-byte limit", limit))
	}
	rc, err := s.klipy.download(ctx, f.URL)
	if err != nil {
		slog.WarnContext(ctx, "gifs: download", "err", err)
		return nil, providerError()
	}
	defer rc.Close()
	body := &tracked{r: rc}
	name := strings.TrimSpace(item.Title)
	if name == "" {
		name = slug
	}
	a, err := s.files.SaveGIF(ctx, channelID, userID, name+"."+format, body, limit, f.Width, f.Height)
	if err != nil && body.err != nil { // the download broke off: Klipy's fault, not ours
		slog.WarnContext(ctx, "gifs: download", "err", redact(body.err))
		return nil, providerError()
	}
	return a, err
}

// remember notes a GIF Klipy listed, for Attach.
func (s *Service) remember(it klipyItem) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.seen) >= maxSeen {
		for slug, g := range s.seen {
			if now.Sub(g.at) > seenFor {
				delete(s.seen, slug)
			}
		}
		if len(s.seen) >= maxSeen {
			clear(s.seen)
		}
	}
	s.seen[it.Slug] = seenGIF{item: it, at: now}
}

// lookUp finds a GIF by its slug: among those recently listed, else with Klipy's items lookup.
func (s *Service) lookUp(ctx context.Context, key, slug string) (*klipyItem, error) {
	s.mu.Lock()
	g, ok := s.seen[slug]
	s.mu.Unlock()
	if ok && time.Since(g.at) <= seenFor {
		return &g.item, nil
	}
	p, err := s.klipy.list(ctx, key, "items", url.Values{"slugs": {slug}})
	if err != nil {
		slog.WarnContext(ctx, "gifs: look up", "err", err)
		return nil, providerError()
	}
	for i := range p.Data.Data {
		if it := &p.Data.Data[i]; isGIF(*it) && it.Slug == slug {
			return it, nil
		}
	}
	return nil, httpx.NotFound("gif")
}

// tracked remembers a read error from the download, so a broken download is
// reported as a provider error rather than an internal one.
type tracked struct {
	r   io.Reader
	err error
}

func (t *tracked) Read(p []byte) (int, error) {
	n, err := t.r.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		t.err = err
	}
	return n, err
}
