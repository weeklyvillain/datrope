package voice

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

func TestParticipants(t *testing.T) {
	s := NewService(Config{}, &events.Bus{}, nil, nil)
	require.Zero(t, s.Participants())
	s.users[id.ID(1)] = &participant{}
	s.users[id.ID(2)] = &participant{}
	require.Equal(t, 2, s.Participants())
}
