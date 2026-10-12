package files

import (
	"context"
	"errors"
	"io"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// gifSize is a GIF provider's dimensions, used when the stored file is not
// a measurable image (an MP4).
type gifSize struct{ width, height int }

// UploadLimit checks that userID may attach files in channelID and returns
// the largest file they may upload there. Uploads and /gif both call it
// before reading any file.
func (s *Service) UploadLimit(ctx context.Context, userID, channelID id.ID) (int64, error) {
	ch, _, err := s.channels.Access(ctx, userID, channelID, perms.AttachFiles)
	if err != nil {
		return 0, err
	}
	if ch.Type == channels.TypeWelcome {
		return 0, httpx.BadRequest("NO_MESSAGES_HERE", "the welcome channel has no messages")
	}
	set, err := s.settings.Settings(ctx)
	if err != nil {
		return 0, err
	}
	return set.MaxUploadBytes, nil
}

// SaveGIF stores body as an unsent attachment flagged gif, exactly like an
// upload; call UploadLimit first. A body over limit bytes fails with 413
// TOO_LARGE and leaves nothing behind. width and height are the provider's.
func (s *Service) SaveGIF(ctx context.Context, channelID, uploaderID id.ID, filename string, body io.Reader, limit int64, width, height int) (*Attachment, error) {
	staged, err := s.store.Stage(body, limit)
	if errors.Is(err, ErrTooLarge) {
		return nil, uploadError(err, limit)
	}
	if err != nil {
		return nil, err
	}
	return s.save(ctx, home{channelID: &channelID}, uploaderID, cleanFilename(filename), staged, &gifSize{width, height})
}
