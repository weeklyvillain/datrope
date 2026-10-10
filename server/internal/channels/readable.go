package channels

import (
	"context"
	"errors"

	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Readable returns the channels whose messages userID may read: server text,
// voice, webhook, announcement, forum and gallery channels where they have
// VIEW_CHANNEL and READ_HISTORY, and their DMs. Threads (and forum posts) are
// not listed: a thread is readable when its parent is.
func (s *Service) Readable(ctx context.Context, userID id.ID) ([]id.ID, error) {
	out := []id.ID{}
	sid, err := s.communities.ServerID(ctx)
	if err != nil && !errors.Is(err, communities.ErrNotFound) {
		return nil, err
	}
	if err == nil {
		m, err := s.communities.PermMember(ctx, sid, userID)
		switch {
		case errors.Is(err, communities.ErrNotMember): // DMs only
		case err != nil:
			return nil, err
		default:
			chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE community_id = $1 AND type IN ('text', 'voice', 'webhook', 'announcement', 'forum', 'gallery')`, sid)
			if err != nil {
				return nil, err
			}
			for _, c := range chs {
				if effective(m, c).Has(perms.ViewChannel | perms.ReadHistory) {
					out = append(out, c.ID)
				}
			}
		}
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
