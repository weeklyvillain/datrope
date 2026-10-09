package linkpreview

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/pgtest"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

func TestGetCachesAndLimits(t *testing.T) {
	s := New(pgtest.New(t))
	calls := 0
	s.fetch = func(_ context.Context, rawURL string) (*Preview, error) {
		calls++
		if rawURL == "https://bad.example" {
			return nil, errors.New("boom")
		}
		return &Preview{URL: rawURL, Site: "Ex", Title: "T", Description: "D"}, nil
	}
	ctx := t.Context()

	p, err := s.Get(ctx, "https://ok.example")
	require.NoError(t, err)
	require.Equal(t, &Preview{URL: "https://ok.example", Site: "Ex", Title: "T", Description: "D"}, p)
	p, err = s.Get(ctx, "https://ok.example")
	require.NoError(t, err)
	require.Equal(t, "T", p.Title)
	require.Equal(t, 1, calls) // cached

	for range 2 { // failures are cached too
		p, err = s.Get(ctx, "https://bad.example")
		require.NoError(t, err)
		require.Nil(t, p)
	}
	require.Equal(t, 2, calls)

	// Rate limited: no fetch, and nothing cached, so a later Get fetches.
	s.limit = ratelimit.New(1, 1)
	require.True(t, s.limit.Allow("server"))
	p, err = s.Get(ctx, "https://later.example")
	require.NoError(t, err)
	require.Nil(t, p)
	require.Equal(t, 2, calls)
	s.limit = ratelimit.New(30, 30)
	p, err = s.Get(ctx, "https://later.example")
	require.NoError(t, err)
	require.Equal(t, "T", p.Title)
	require.Equal(t, 3, calls)
}
