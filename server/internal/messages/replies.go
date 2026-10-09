package messages

import (
	"context"
	"net/http"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

const replyPreviewLen = 200

// ReplyRef is the message a reply points at, as the reply shows it.
type ReplyRef struct {
	ID      id.ID           `json:"id"`
	Author  auth.PublicUser `json:"author"`
	Content string          `json:"content" doc:"Up to 200 characters; empty when deleted"`
	Deleted bool            `json:"deleted"`
}

func errReplyNotFound() *httpx.Error {
	return httpx.E(http.StatusBadRequest, "REPLY_NOT_FOUND", "you can only reply to a message in this channel")
}

// checkReply verifies that replyTo is a live message in channelID.
func (s *Service) checkReply(ctx context.Context, channelID, replyTo id.ID) error {
	var ok bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted)`,
		replyTo, channelID).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return errReplyNotFound()
	}
	return nil
}

// withReplies fills ReplyTo for messages that reply to another.
func (s *Service) withReplies(ctx context.Context, ms []Message) error {
	var ids []id.ID
	for _, m := range ms {
		if m.replyToID != nil {
			ids = append(ids, *m.replyToID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT id, author_id, left(content, $2), deleted FROM messages WHERE id = ANY($1)`,
		id.Int64s(ids), replyPreviewLen)
	if err != nil {
		return err
	}
	defer rows.Close()
	refs := map[id.ID]*ReplyRef{}
	var authors []id.ID
	for rows.Next() {
		r := &ReplyRef{}
		if err := rows.Scan(&r.ID, &r.Author.ID, &r.Content, &r.Deleted); err != nil {
			return err
		}
		if r.Deleted {
			r.Content = ""
		}
		refs[r.ID] = r
		authors = append(authors, r.Author.ID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	users, err := s.users.PublicUsers(ctx, authors)
	if err != nil {
		return err
	}
	for i := range ms {
		if ms[i].replyToID == nil {
			continue
		}
		if r := refs[*ms[i].replyToID]; r != nil {
			r.Author = users[r.Author.ID]
			ms[i].ReplyTo = r
		}
	}
	return nil
}
