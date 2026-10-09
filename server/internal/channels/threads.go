package channels

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/id"
)

// CreateThread starts the thread on a message, or returns the existing one.
// The bool reports whether this call created it.
func (s *Service) CreateThread(ctx context.Context, parent *Channel, messageID, creatorID id.ID, name string) (*Channel, bool, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "Thread"
	}
	if r := []rune(name); len(r) > 100 {
		name = string(r[:100])
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO channels (id, community_id, type, name, position, parent_channel_id, parent_message_id, created_by)
		VALUES ($1, $2, 'thread', $3, 0, $4, $5, $6)
		ON CONFLICT (parent_message_id) WHERE type = 'thread' DO NOTHING`,
		id.New(), parent.CommunityID, name, parent.ID, messageID, creatorID)
	if err != nil {
		return nil, false, err
	}
	created := tag.RowsAffected() > 0
	var tid id.ID
	if err := s.db.QueryRow(ctx, `SELECT id FROM channels WHERE parent_message_id = $1 AND type = 'thread'`, messageID).Scan(&tid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrNotFound
		}
		return nil, false, err
	}
	c, err := s.get(ctx, tid)
	return c, created, err
}

// ThreadsOf lists a channel's threads.
func (s *Service) ThreadsOf(ctx context.Context, parentID id.ID) ([]Channel, error) {
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE parent_channel_id = $1 AND type = 'thread'`, parentID)
	if err != nil {
		return nil, err
	}
	out := make([]Channel, 0, len(chs))
	for _, c := range chs {
		out = append(out, *c)
	}
	return out, nil
}
