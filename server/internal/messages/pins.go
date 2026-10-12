package messages

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const maxPins = 50

func registerPins(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	pinAccess := func(ctx context.Context, raw string) (*channels.Channel, error) {
		ch, have, err := access(ctx, raw, perms.ReadHistory)
		if err != nil {
			return nil, err
		}
		if ch.Type != channels.TypeDM && !have.Has(perms.ManageMessages) {
			return nil, httpx.MissingPermission()
		}
		return ch, nil
	}

	huma.Register(api, op("pin-message", http.MethodPut, "/api/channels/{id}/pins/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, err := pinAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('pins:' || $1::text, 0))`, ch.ID); err != nil {
				return nil, err
			}
			var count int
			if err := tx.QueryRow(ctx, `SELECT count(*) FROM messages WHERE channel_id = $1 AND pinned_at IS NOT NULL AND NOT deleted`, ch.ID).Scan(&count); err != nil {
				return nil, err
			}
			tag, err := tx.Exec(ctx, `UPDATE messages SET pinned_at = now(), pinned_by = $2 WHERE id = $1 AND pinned_at IS NULL`,
				m.ID, auth.Current(ctx).User.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, nil // already pinned
			}
			if count >= maxPins {
				return nil, httpx.BadRequest("PIN_LIMIT", "a channel can have at most 50 pinned messages")
			}
			if err := auditPin(ctx, tx, audit.MessagePin, ch, m); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishUpdated(ctx, ch.ID, m.ID)
			return nil, nil
		})

	huma.Register(api, op("unpin-message", http.MethodDelete, "/api/channels/{id}/pins/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, err := pinAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1 AND pinned_at IS NOT NULL`, m.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() > 0 {
				s.publishUpdated(ctx, ch.ID, m.ID)
				if err := auditPin(ctx, s.db, audit.MessageUnpin, ch, m); err != nil {
					return nil, err
				}
			}
			return nil, nil
		})

	huma.Register(api, op("list-pins", http.MethodGet, "/api/channels/{id}/pins", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body []Message }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages
				WHERE channel_id = $1 AND pinned_at IS NOT NULL AND NOT deleted ORDER BY pinned_at DESC LIMIT $2`, ch.ID, maxPins)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			out := []Message{}
			for rows.Next() {
				m, err := scanMessage(rows)
				if err != nil {
					return nil, err
				}
				out = append(out, *m)
			}
			if err := rows.Err(); err != nil {
				return nil, err
			}
			return &struct{ Body []Message }{out}, s.hydrate(ctx, out)
		})
}

// auditPin logs a pin change in a server channel; DM pins are not moderation.
func auditPin(ctx context.Context, q audit.Execer, action audit.Action, ch *channels.Channel, m *Message) error {
	if ch.CommunityID == nil {
		return nil
	}
	var target id.ID
	if m.Author != nil {
		target = m.Author.ID
	}
	return audit.Record(ctx, q, action, target, audit.LogDetails{Channel: &audit.LogRef{ID: ch.ID, Name: ch.Name}})
}
