package updater

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// CachedLister keeps the project's container list, with CPU and memory, fresh in the background, so the System page's
// poll answers at once instead of waiting a second or two per container for Docker's stats.
type CachedLister struct {
	inner   Lister
	project string
	every   time.Duration

	mu   sync.Mutex
	last []ContainerInfo // nil until the first sample
}

func NewCachedLister(inner Lister, project string, every time.Duration) *CachedLister {
	return &CachedLister{inner: inner, project: project, every: every}
}

// Run samples until ctx ends.
func (c *CachedLister) Run(ctx context.Context) {
	t := time.NewTicker(c.every)
	defer t.Stop()
	for {
		c.sample(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (c *CachedLister) sample(ctx context.Context) {
	cs, err := c.inner.Containers(ctx, c.project)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("updater: container stats", "err", err)
			// Forget the old numbers: Containers then asks Docker itself, so the error shows instead of a frozen list.
			c.mu.Lock()
			c.last = nil
			c.mu.Unlock()
		}
		return
	}
	c.mu.Lock()
	c.last = cs
	c.mu.Unlock()
}

// Containers answers from the last sample; before the first one (or for another project) it asks Docker directly.
func (c *CachedLister) Containers(ctx context.Context, project string) ([]ContainerInfo, error) {
	if project == c.project {
		c.mu.Lock()
		last := c.last
		c.mu.Unlock()
		if last != nil {
			return last, nil
		}
	}
	return c.inner.Containers(ctx, project)
}
