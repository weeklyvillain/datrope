package linkpreview

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/ratelimit"
)

const cacheTTL = 24 * time.Hour

type Preview struct {
	URL         string `json:"url"`
	Site        string `json:"site"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Author      string `json:"author,omitempty" doc:"Who made it: a YouTube video's channel"`
}

type Service struct {
	db    *pgxpool.Pool
	limit *ratelimit.Limiter
	fetch func(ctx context.Context, rawURL string) (*Preview, error)
}

func New(pool *pgxpool.Pool) *Service {
	return &Service{db: pool, limit: ratelimit.New(30, 30), fetch: fetch}
}

// Get returns the preview for rawURL from the cache or the web; nil when
// there is none (failed, no title, or rate limited).
func (s *Service) Get(ctx context.Context, rawURL string) (*Preview, error) {
	var p Preview
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT ok, site, title, description, author FROM link_previews WHERE url = $1 AND fetched_at > $2`,
		rawURL, time.Now().Add(-cacheTTL)).Scan(&ok, &p.Site, &p.Title, &p.Description, &p.Author)
	if err == nil {
		if !ok {
			return nil, nil
		}
		p.URL = rawURL
		return &p, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if !s.limit.Allow("server") { // 30 fetches a minute for the whole server
		return nil, nil
	}
	got, ferr := s.fetch(ctx, rawURL)
	if ferr != nil {
		slog.InfoContext(ctx, "link preview failed", "url", rawURL, "err", ferr)
		got = nil
	}
	row := Preview{}
	if got != nil {
		row = *got
	}
	if _, err := s.db.Exec(ctx, `
		INSERT INTO link_previews (url, ok, site, title, description, author, fetched_at) VALUES ($1, $2, $3, $4, $5, $6, now())
		ON CONFLICT (url) DO UPDATE SET ok = EXCLUDED.ok, site = EXCLUDED.site, title = EXCLUDED.title,
		    description = EXCLUDED.description, author = EXCLUDED.author, fetched_at = EXCLUDED.fetched_at`,
		rawURL, got != nil, row.Site, row.Title, row.Description, row.Author); err != nil {
		return nil, err
	}
	return got, nil
}
