// Package slot tells a server whether it is the live one of the two update slots (blue/green).
// The updater writes the live slot's name to a file on a shared volume; the other slot keeps
// answering HTTP but pauses its background jobs.
package slot

import (
	"context"
	"log/slog"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Gate reports whether this server is live. A nil Gate is always live (no slots configured).
type Gate struct {
	inactive atomic.Bool
	mu       sync.Mutex
	onActive []func()
}

// OnActive registers f to run each time the slot becomes live (on Watch's goroutine), so jobs can
// catch up at once instead of on their next tick.
func (g *Gate) OnActive(f func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.onActive = append(g.onActive, f)
}

func (g *Gate) Active() bool { return g == nil || !g.inactive.Load() }

// SetInactive marks the gate inactive, for the state read before Watch starts.
func (g *Gate) SetInactive() { g.inactive.Store(true) }

// ReadActive reports whether the file at path names mine. A missing file means not live.
func ReadActive(path, mine string) bool {
	b, err := os.ReadFile(path)
	return err == nil && strings.TrimSpace(string(b)) == mine
}

// Watch sets g from path, then again every interval until ctx ends.
func Watch(ctx context.Context, g *Gate, path, mine string, every time.Duration) {
	set := func() {
		active := ReadActive(path, mine)
		if was := !g.inactive.Swap(!active); was != active {
			slog.Info("slot", "slot", mine, "active", active)
			if active {
				g.mu.Lock()
				fs := append([]func(){}, g.onActive...)
				g.mu.Unlock()
				for _, f := range fs {
					f()
				}
			}
		}
	}
	set()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			set()
		}
	}
}
