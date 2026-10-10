package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// KindMemberLeave marks the message left behind when someone leaves a group DM.
const KindMemberLeave = "member_leave"

func registerLeaveDM(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("leave-dm", http.MethodPost, "/api/dms/{id}/leave", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			return nil, s.leaveDM(ctx, auth.Current(ctx).User, chID)
		})
}

// leaveDM takes the user out of a group DM and tells the rest with a
// member_leave message. The last one out deletes the conversation.
func (s *Service) leaveDM(ctx context.Context, u *auth.User, chID id.ID) error {
	ch, _, err := s.channels.Access(ctx, u.ID, chID, 0)
	if err != nil {
		return err
	}
	if ch.Type != channels.TypeDM || !ch.Group {
		return httpx.BadRequest("NOT_A_GROUP", "only group conversations can be left")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `DELETE FROM dm_participants WHERE channel_id = $1 AND user_id = $2`, ch.ID, u.ID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("channel") // left concurrently
	}
	var left int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM dm_participants WHERE channel_id = $1`, ch.ID).Scan(&left); err != nil {
		return err
	}
	author := u.Public()
	m := &Message{ID: id.New(), ChannelID: ch.ID, Author: &author, Kind: KindMemberLeave, Mentions: []id.ID{}}
	m.CreatedAt = m.ID.Time()
	if left == 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM channels WHERE id = $1`, ch.ID); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, kind) VALUES ($1, $2, $3, '', $4)`,
		m.ID, ch.ID, u.ID, KindMemberLeave); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "CHANNEL_DELETE", Data: channels.ChannelDeleted{ID: ch.ID}, Scope: events.Scope{UserIDs: []id.ID{u.ID}}})
	if left == 0 {
		return nil
	}
	updated, err := s.channels.Get(ctx, ch.ID)
	if err != nil {
		return err
	}
	s.publish("CHANNEL_UPDATE", ch.ID, updated)
	one := []Message{*m}
	if err := s.hydrate(ctx, one); err != nil {
		return err
	}
	s.publish("MESSAGE_CREATE", ch.ID, &one[0])
	return nil
}
