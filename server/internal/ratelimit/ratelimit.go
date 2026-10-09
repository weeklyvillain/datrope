// Package ratelimit keeps one token bucket per key (an IP, an account...).
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type Limiter struct {
	mu    sync.Mutex
	limit rate.Limit
	burst int
	m     map[string]*entry
}

type entry struct {
	l    *rate.Limiter
	seen time.Time
}

// New allows perMinute events per key per minute, in bursts of up to burst.
func New(perMinute, burst int) *Limiter {
	return &Limiter{limit: rate.Limit(float64(perMinute) / 60), burst: burst, m: map[string]*entry{}}
}

func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.m) > 10000 { // forget idle keys so the map cannot grow forever
		for k, e := range l.m {
			if now.Sub(e.seen) > 10*time.Minute {
				delete(l.m, k)
			}
		}
	}
	e := l.m[key]
	if e == nil {
		e = &entry{l: rate.NewLimiter(l.limit, l.burst)}
		l.m[key] = e
	}
	e.seen = now
	return e.l.Allow()
}
