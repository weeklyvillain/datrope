package channels

import (
	"context"
	"slices"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
)

// SystemDM returns userID's conversation with the System account, creating it on first use.
// Unlike people, System needs no shared server.
func (s *Service) SystemDM(ctx context.Context, userID id.ID) (*Channel, error) {
	return s.openDM(ctx, userID, []id.ID{auth.SystemUserID})
}

// IsSystemDM reports whether c is a conversation with the System account, which nobody can reply to.
func IsSystemDM(c *Channel) bool {
	return c.Type == TypeDM && slices.ContainsFunc(c.Participants, func(p auth.PublicUser) bool { return p.ID == auth.SystemUserID })
}
