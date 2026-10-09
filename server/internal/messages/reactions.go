package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Reaction struct {
	Emoji   string  `json:"emoji" doc:"A Unicode emoji or custom:<emoji id>"`
	Count   int     `json:"count"`
	UserIDs []id.ID `json:"user_ids"`
}

type ReactionEvent struct {
	ChannelID id.ID  `json:"channel_id"`
	MessageID id.ID  `json:"message_id"`
	Emoji     string `json:"emoji"`
	UserID    id.ID  `json:"user_id"`
}

// CustomEmoji is what this package needs from expressions.
type CustomEmoji interface {
	EmojiExists(ctx context.Context, emojiID id.ID) (bool, error)
}

func (s *Service) SetCustomEmoji(c CustomEmoji) { s.custom = c }

type reactionPath struct {
	ID        string `path:"id"`
	MessageID string `path:"messageID"`
	Emoji     string `path:"emoji" maxLength:"64"`
}

func errInvalidEmoji() *httpx.Error {
	return httpx.BadRequest("INVALID_EMOJI", "that is not an emoji this server knows")
}

func (s *Service) checkEmoji(ctx context.Context, emoji string) error {
	if n, ok := customEmojiID(emoji); ok {
		if s.custom == nil {
			return errInvalidEmoji()
		}
		exists, err := s.custom.EmojiExists(ctx, id.ID(n))
		if err != nil {
			return err
		}
		if !exists {
			return errInvalidEmoji()
		}
		return nil
	}
	if !ValidUnicodeEmoji(emoji) {
		return errInvalidEmoji()
	}
	return nil
}

// withReactions fills Reactions, ordered by each emoji's first use.
func (s *Service) withReactions(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for i := range ms {
		ms[i].Reactions = []Reaction{}
		ids = append(ids, ms[i].ID)
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT message_id, emoji, array_agg(user_id ORDER BY created_at)
		FROM message_reactions WHERE message_id = ANY($1)
		GROUP BY message_id, emoji ORDER BY min(created_at)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	byMsg := map[id.ID][]Reaction{}
	for rows.Next() {
		var mid id.ID
		var r Reaction
		var users []int64
		if err := rows.Scan(&mid, &r.Emoji, &users); err != nil {
			return err
		}
		for _, u := range users {
			r.UserIDs = append(r.UserIDs, id.ID(u))
		}
		r.Count = len(r.UserIDs)
		byMsg[mid] = append(byMsg[mid], r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		if rs := byMsg[ms[i].ID]; rs != nil {
			ms[i].Reactions = rs
		}
	}
	return nil
}

// RemoveReactions deletes every reaction with this emoji (a deleted custom emoji).
func (s *Service) RemoveReactions(ctx context.Context, emoji string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM message_reactions WHERE emoji = $1`, emoji)
	return err
}

type accessFunc func(ctx context.Context, raw string, need perms.Perms) (*channels.Channel, perms.Perms, error)

func registerReactions(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("add-reaction", http.MethodPut, "/api/channels/{id}/messages/{messageID}/reactions/{emoji}", http.StatusNoContent),
		func(ctx context.Context, in *reactionPath) (*struct{}, error) {
			ch, have, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if err := s.checkEmoji(ctx, in.Emoji); err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			if !s.reactLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			var exists bool
			if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM message_reactions WHERE message_id = $1 AND emoji = $2)`,
				m.ID, in.Emoji).Scan(&exists); err != nil {
				return nil, err
			}
			if !exists && !have.Has(perms.AddReactions) {
				return nil, httpx.MissingPermission()
			}
			tag, err := s.db.Exec(ctx, `INSERT INTO message_reactions (message_id, emoji, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
				m.ID, in.Emoji, me)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publish("MESSAGE_REACTION_ADD", ch.ID, ReactionEvent{ChannelID: ch.ID, MessageID: m.ID, Emoji: in.Emoji, UserID: me})
			}
			return nil, nil
		})

	huma.Register(api, op("remove-reaction", http.MethodDelete, "/api/channels/{id}/messages/{messageID}/reactions/{emoji}", http.StatusNoContent),
		func(ctx context.Context, in *reactionPath) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			mid, err := httpx.ParseID(in.MessageID, "message")
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			tag, err := s.db.Exec(ctx, `
				DELETE FROM message_reactions r USING messages m
				WHERE r.message_id = m.id AND m.channel_id = $1 AND r.message_id = $2 AND r.emoji = $3 AND r.user_id = $4`,
				ch.ID, mid, in.Emoji, me)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publish("MESSAGE_REACTION_REMOVE", ch.ID, ReactionEvent{ChannelID: ch.ID, MessageID: mid, Emoji: in.Emoji, UserID: me})
			}
			return nil, nil
		})
}
