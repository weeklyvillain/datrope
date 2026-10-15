package music

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// attachmentTrack makes a channel's audio file a track, for a playlist: the caller must be
// able to read it (404 otherwise, like downloading it), and it must be audio outside a DM.
func (s *Service) attachmentTrack(ctx context.Context, aid id.ID) (MusicTrack, error) {
	var filename, contentType, sum, chType string
	var channelID id.ID
	err := s.db.QueryRow(ctx, `SELECT a.filename, a.content_type, a.sha256, a.channel_id, c.type
		FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE a.id = $1 AND a.message_id IS NOT NULL AND a.expired_at IS NULL`, aid).
		Scan(&filename, &contentType, &sum, &channelID, &chType)
	if errors.Is(err, pgx.ErrNoRows) {
		return MusicTrack{}, httpx.NotFound("attachment")
	}
	if err != nil {
		return MusicTrack{}, err
	}
	if _, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, channelID, perms.ReadHistory); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return MusicTrack{}, httpx.NotFound("attachment")
		}
		return MusicTrack{}, err
	}
	if chType == "dm" {
		return MusicTrack{}, httpx.BadRequest("NOT_ALLOWED_HERE", "files from direct messages can't go in playlists")
	}
	if !strings.HasPrefix(contentType, "audio/") {
		return MusicTrack{}, httpx.BadRequest("NOT_AUDIO", "only audio files can go in playlists")
	}
	title := strings.TrimSuffix(filename, filepath.Ext(filename))
	if title == "" {
		title = filename
	}
	return MusicTrack{Title: clip(title, 200), Source: "file", Duration: s.blobDuration(ctx, sum), blob: sum, attachmentID: aid}, nil
}

// blobDuration measures a stored file's length; 0 when it cannot.
func (s *Service) blobDuration(ctx context.Context, sum string) int {
	if s.blobs == nil {
		return 0
	}
	f, err := s.blobs.OpenBlob(sum)
	if err != nil {
		return 0
	}
	defer f.Close()
	tmp, err := os.CreateTemp("", "datrope-probe-*")
	if err != nil {
		return 0
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := io.Copy(tmp, f); err != nil {
		return 0
	}
	d, err := s.probe(ctx, tmp.Name())
	if err != nil {
		return 0
	}
	return d
}
