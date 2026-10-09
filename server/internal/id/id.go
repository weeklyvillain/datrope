// Package id generates Snowflake-style IDs: 64-bit, time-ordered.
//
// Layout: 41 bits of milliseconds since Epoch | 10 bits node | 12 bits sequence.
package id

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

// Epoch is 2026-01-01T00:00:00Z in Unix milliseconds.
const Epoch int64 = 1767225600000

// ID is encoded as a decimal string in JSON because JavaScript numbers
// cannot hold 64-bit integers.
type ID int64

func (i ID) String() string { return strconv.FormatInt(int64(i), 10) }

// Time returns when the ID was generated.
func (i ID) Time() time.Time { return time.UnixMilli(int64(i)>>22 + Epoch) }

func (i ID) MarshalJSON() ([]byte, error) { return json.Marshal(i.String()) }

func (i *ID) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("id must be a string: %w", err)
	}
	v, err := Parse(s)
	if err != nil {
		return err
	}
	*i = v
	return nil
}

// Parse reads a positive decimal ID.
func Parse(s string) (ID, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("invalid id %q", s)
	}
	return ID(n), nil
}

// Int64s converts IDs for use as a Postgres bigint[] parameter.
func Int64s(ids []ID) []int64 {
	out := make([]int64, len(ids))
	for i, v := range ids {
		out[i] = int64(v)
	}
	return out
}

// FromNullable converts a scanned nullable bigint.
func FromNullable(n *int64) *ID {
	if n == nil {
		return nil
	}
	v := ID(*n)
	return &v
}

type Generator struct {
	mu   sync.Mutex
	node int64
	last int64
	seq  int64
	now  func() time.Time
}

func NewGenerator(node int64) *Generator {
	return &Generator{node: node & 0x3FF, now: time.Now}
}

func (g *Generator) Next() ID {
	g.mu.Lock()
	defer g.mu.Unlock()
	ms := g.now().UnixMilli() - Epoch
	if ms < g.last {
		ms = g.last // the clock went backwards: keep IDs ordered
	}
	if ms == g.last {
		g.seq = (g.seq + 1) & 0xFFF
		if g.seq == 0 {
			ms++ // sequence exhausted: borrow the next millisecond
		}
	} else {
		g.seq = 0
	}
	g.last = ms
	return ID(ms<<22 | g.node<<12 | g.seq)
}

var def = NewGenerator(0)

// New returns a fresh ID from the process-wide generator.
func New() ID { return def.Next() }

// Schema tells Huma (and so the OpenAPI document) that an ID is a string.
func (ID) Schema(huma.Registry) *huma.Schema {
	return &huma.Schema{Type: huma.TypeString, Pattern: "^[0-9]+$", Description: "Snowflake ID as a decimal string"}
}

// FirstAt returns the smallest ID made at or after t; 0 for times before Epoch
// and the largest ID for times past the 41-bit range.
func FirstAt(t time.Time) ID {
	ms := t.UnixMilli() - Epoch
	if ms < 0 {
		return 0
	}
	if ms >= 1<<41 {
		return ID(math.MaxInt64) // beyond the last time an ID can hold
	}
	return ID(ms << 22)
}
