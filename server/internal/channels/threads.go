package channels

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const maxPostTags = 5

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

// postTags checks a post's tags against its forum and returns them in the
// forum's spelling.
func postTags(forum *Channel, in []string) ([]string, error) {
	tags, err := normalizeTags(in, maxPostTags)
	if err != nil {
		return nil, err
	}
	known := make(map[string]string, len(forum.Tags))
	for _, t := range forum.Tags {
		known[strings.ToLower(t)] = t
	}
	for i, t := range tags {
		canonical, ok := known[strings.ToLower(t)]
		if !ok {
			return nil, httpx.BadRequest("UNKNOWN_TAG", "this forum has no tag "+t)
		}
		tags[i] = canonical
	}
	if forum.RequireTag && len(tags) == 0 {
		return nil, httpx.BadRequest("TAG_REQUIRED", "posts in this forum need a tag")
	}
	return tags, nil
}

func postTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return "", httpx.BadRequest("VALIDATION_FAILED", "a post needs a title")
	}
	return title, nil
}

// CreatePost starts a forum post inside tx: a thread on the forum with no
// parent message. The caller inserts its first message in the same tx.
func (s *Service) CreatePost(ctx context.Context, tx pgx.Tx, forum *Channel, creatorID id.ID, title string, tags []string) (*Channel, error) {
	title, err := postTitle(title)
	if err != nil {
		return nil, err
	}
	if tags, err = postTags(forum, tags); err != nil {
		return nil, err
	}
	c := &Channel{ID: id.New(), CommunityID: forum.CommunityID, Type: TypeThread, Name: title, Overrides: []Override{},
		ParentChannelID: &forum.ID, Tags: tags, CreatedBy: &creatorID}
	if _, err := tx.Exec(ctx, `
		INSERT INTO channels (id, community_id, type, name, position, parent_channel_id, created_by, tags)
		VALUES ($1, $2, 'thread', $3, 0, $4, $5, $6)`,
		c.ID, c.CommunityID, c.Name, forum.ID, creatorID, tags); err != nil {
		return nil, err
	}
	return c, nil
}

// UpdatePost changes a post's title and/or tags; nil leaves a field as is.
func (s *Service) UpdatePost(ctx context.Context, post *Channel, title *string, tags *[]string) (*Channel, error) {
	var newTitle *string
	if title != nil {
		t, err := postTitle(*title)
		if err != nil {
			return nil, err
		}
		newTitle = &t
	}
	var newTags []string // nil keeps the tags
	if tags != nil {
		forum, err := s.get(ctx, *post.ParentChannelID)
		if err != nil {
			return nil, err
		}
		if newTags, err = postTags(forum, *tags); err != nil {
			return nil, err
		}
	}
	if _, err := s.db.Exec(ctx, `UPDATE channels SET name = COALESCE($2, name), tags = COALESCE($3, tags) WHERE id = $1`,
		post.ID, newTitle, newTags); err != nil {
		return nil, err
	}
	return s.get(ctx, post.ID)
}

// DeletePost deletes a forum post. Its messages and their attachment rows
// go with it (ON DELETE CASCADE); the blob sweep removes the files later.
func (s *Service) DeletePost(ctx context.Context, post *Channel) error {
	_, err := s.db.Exec(ctx, `DELETE FROM channels WHERE id = $1 AND type = 'thread'`, post.ID)
	return err
}

// ThreadPerms returns what userID may do in parent's threads: parent's
// permissions without the webhook-channel mask, since a thread uses its
// parent's overrides but anyone may post in a webhook channel's threads.
func (s *Service) ThreadPerms(ctx context.Context, userID id.ID, parent *Channel) (perms.Perms, error) {
	return s.permsIn(ctx, userID, parent)
}
