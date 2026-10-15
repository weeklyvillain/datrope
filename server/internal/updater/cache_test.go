package updater

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type slowLister struct {
	calls atomic.Int32
	delay time.Duration
}

func (s *slowLister) Containers(ctx context.Context, _ string) ([]ContainerInfo, error) {
	n := s.calls.Add(1)
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return []ContainerInfo{{Service: "server", CPUPercent: float64(n)}}, nil
}

func TestCachedListerAnswersFromCache(t *testing.T) {
	inner := &slowLister{delay: 200 * time.Millisecond}
	c := NewCachedLister(inner, "datrope", 20*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx)

	// Before the first sample: falls through to the slow call once.
	cs, err := c.Containers(ctx, "datrope")
	require.NoError(t, err)
	require.Len(t, cs, 1)

	// After that every call is instant.
	require.Eventually(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.last != nil
	}, 2*time.Second, 10*time.Millisecond)
	start := time.Now()
	cs, err = c.Containers(ctx, "datrope")
	require.NoError(t, err)
	require.Less(t, time.Since(start), 20*time.Millisecond)
	require.Equal(t, "server", cs[0].Service)
}

func TestCachedListerIgnoresOtherProjects(t *testing.T) {
	inner := &slowLister{}
	c := NewCachedLister(inner, "datrope", time.Hour)
	_, err := c.Containers(context.Background(), "other")
	require.NoError(t, err)
	require.EqualValues(t, 1, inner.calls.Load()) // passed through, not cached
}

// flakyLister answers once, then fails.
type flakyLister struct{ calls atomic.Int32 }

var errDocker = errors.New("docker gone")

func (f *flakyLister) Containers(context.Context, string) ([]ContainerInfo, error) {
	if f.calls.Add(1) == 1 {
		return []ContainerInfo{{Service: "server"}}, nil
	}
	return nil, errDocker
}

func TestCachedListerDropsStaleSampleOnError(t *testing.T) {
	inner := &flakyLister{}
	c := NewCachedLister(inner, "datrope", time.Hour)
	ctx := context.Background()
	c.sample(ctx) // good
	cs, err := c.Containers(ctx, "datrope")
	require.NoError(t, err)
	require.Len(t, cs, 1)

	c.sample(ctx) // fails: the old numbers must not stay up as if live
	_, err = c.Containers(ctx, "datrope")
	require.ErrorIs(t, err, errDocker)
}
