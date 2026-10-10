package integrations

import (
	"context"
	"errors"
)

// PollAll runs every check at once, whatever the tick.
func PollAll(ctx context.Context, s *Service) error {
	return errors.Join(s.pollSpotify(ctx), s.pollTwitch(ctx), s.pollYouTube(ctx))
}
