package id

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNextIsIncreasing(t *testing.T) {
	g := NewGenerator(1)
	prev := g.Next()
	for i := 0; i < 10000; i++ {
		n := g.Next()
		if n <= prev {
			t.Fatalf("id %d not greater than %d", n, prev)
		}
		prev = n
	}
}

func TestSequenceOverflowStaysOrdered(t *testing.T) {
	fixed := time.UnixMilli(Epoch + 1000)
	g := NewGenerator(0)
	g.now = func() time.Time { return fixed }
	prev := g.Next()
	for i := 0; i < 5000; i++ { // more than the 4096 IDs one millisecond holds
		n := g.Next()
		if n <= prev {
			t.Fatalf("not ordered at %d: %d <= %d", i, n, prev)
		}
		prev = n
	}
}

func TestTime(t *testing.T) {
	before := time.Now().Truncate(time.Millisecond)
	got := New().Time()
	if got.Before(before) || got.After(time.Now()) {
		t.Fatalf("Time() = %v, want between %v and now", got, before)
	}
}

func TestJSONIsString(t *testing.T) {
	type wrap struct {
		ID ID `json:"id"`
	}
	b, err := json.Marshal(wrap{ID: 123})
	if err != nil || string(b) != `{"id":"123"}` {
		t.Fatalf("marshal = %s, %v", b, err)
	}
	var v wrap
	if err := json.Unmarshal([]byte(`{"id":"456"}`), &v); err != nil || v.ID != 456 {
		t.Fatalf("unmarshal = %v, %v", v.ID, err)
	}
	if err := json.Unmarshal([]byte(`{"id":456}`), &v); err == nil {
		t.Fatal("a JSON number was accepted")
	}
}

func TestParseRejectsJunk(t *testing.T) {
	for _, s := range []string{"", "abc", "-1", "0", "99999999999999999999"} {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) succeeded", s)
		}
	}
	if v, err := Parse("42"); err != nil || v != 42 {
		t.Fatalf("Parse(42) = %v, %v", v, err)
	}
}

func TestFirstAt(t *testing.T) {
	at := time.UnixMilli(Epoch + 5000)
	require.Equal(t, at.UnixMilli(), FirstAt(at).Time().UnixMilli())
	require.Equal(t, ID(0), FirstAt(time.UnixMilli(Epoch-1)))
	require.Equal(t, ID(math.MaxInt64), FirstAt(time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)))
	require.Greater(t, int64(New()), int64(FirstAt(time.Now().Add(-time.Second))))
}
