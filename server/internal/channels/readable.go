package channels

import (
	"context"
	"errors"

	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Readable returns the channels whose messages userID may read: server text,
// voice, webhook, announcement, forum and gallery channels where they have
// VIEW_CHANNEL and READ_HISTORY, and their DMs. Threads (and forum posts) are
// not listed: a thread is readable when its parent is.
func (s *Service) Readable(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out, err := s.readableServer(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT channel_id FROM dm_participants WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid id.ID
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}

// readableServer is Readable without DMs.
func (s *Service) readableServer(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out := []id.ID{}
	sid, err := s.communities.ServerID(ctx)
	if errors.Is(err, communities.ErrNotFound) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	m, err := s.communities.PermMember(ctx, sid, userID)
	if errors.Is(err, communities.ErrNotMember) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE community_id = $1 AND type IN ('text', 'voice', 'webhook', 'announcement', 'forum', 'gallery')`, sid)
	if err != nil {
		return nil, err
	}
	for _, c := range chs {
		if effective(m, c).Has(perms.ViewChannel | perms.ReadHistory) {
			out = append(out, c.ID)
		}
	}
	return out, nil
}

// GalleryScope returns the channels whose files a gallery shows userID: the gallery itself and its
// sources, each only if userID can read it. Threads are not listed; a thread comes with its parent.
// A gallery the user can't see is a 404; another type of channel is a 400.
func (s *Service) GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error) {
	g, _, err := s.Access(ctx, userID, galleryID, perms.ViewChannel)
	if err != nil {
		return nil, err
	}
	if g.Type != TypeGallery {
		return nil, httpx.BadRequest("NOT_A_GALLERY", "that channel is not a gallery")
	}
	readable, err := s.readableServer(ctx, userID)
	if err != nil {
		return nil, err
	}
	want := map[id.ID]bool{g.ID: true}
	for _, c := range g.SourceChannelIDs {
		want[c] = true
	}
	out := []id.ID{}
	for _, c := range readable {
		if g.GallerySources == SourcesAll || want[c] {
			out = append(out, c)
		}
	}
	return out, nil
}
