package ratelimit_test

import (
	"testing"

	"github.com/datrope/datrope/server/internal/ratelimit"
)

func TestLimiter(t *testing.T) {
	l := ratelimit.New(1, 2)
	first := l.Allow("a")
	second := l.Allow("a")
	if !first || !second {
		t.Fatal("burst of 2 should be allowed")
	}
	if l.Allow("a") {
		t.Fatal("third call should be limited")
	}
	if !l.Allow("b") {
		t.Fatal("keys are independent")
	}
}
