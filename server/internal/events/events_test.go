package events_test

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/events"
)

func TestBusDeliversToAllSubscribersInOrder(t *testing.T) {
	var b events.Bus
	var got []string
	b.Subscribe(func(e events.Event) { got = append(got, "a:"+e.Type) })
	b.Subscribe(func(e events.Event) { got = append(got, "b:"+e.Type) })
	b.Publish(events.Event{Type: "X"})
	b.Publish(events.Event{Type: "Y"})
	require.Equal(t, []string{"a:X", "b:X", "a:Y", "b:Y"}, got)
}
