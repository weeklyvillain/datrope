package webhooks

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type WebhookRequest struct {
	Name string `json:"name" minLength:"1" maxLength:"80"`
}

type pathID struct {
	ID string `path:"id"`
}

// cleanName trims a webhook name; a blank one is refused.
func cleanName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", httpx.BadRequest("VALIDATION_FAILED", "a webhook needs a name")
	}
	return name, nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"webhooks"}
	op := func(opID, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: opID, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("list-webhooks", http.MethodGet, "/api/channels/{id}/webhooks", 0),
		func(ctx context.Context, in *pathID) (*struct{ Body []Webhook }, error) {
			ch, err := s.channel(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+webhookCols+` FROM webhooks WHERE channel_id = $1 ORDER BY id`, ch.ID)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			out := []Webhook{}
			for rows.Next() {
				w, err := scanWebhook(rows)
				if err != nil {
					return nil, err
				}
				out = append(out, *w)
			}
			return &struct{ Body []Webhook }{out}, rows.Err()
		})

	huma.Register(api, op("create-webhook", http.MethodPost, "/api/channels/{id}/webhooks", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body WebhookRequest
		}) (*struct{ Body *WebhookWithURL }, error) {
			ch, err := s.channel(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if ch.Type != channels.TypeWebhook {
				return nil, httpx.BadRequest("NOT_A_WEBHOOK_CHANNEL", "webhooks can only be added to webhook channels")
			}
			name, err := cleanName(in.Body.Name)
			if err != nil {
				return nil, err
			}
			token, hash, err := auth.NewToken()
			if err != nil {
				return nil, err
			}
			w, err := scanWebhook(s.db.QueryRow(ctx, `
				INSERT INTO webhooks (id, channel_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4, $5)
				RETURNING `+webhookCols, id.New(), ch.ID, name, hash, auth.Current(ctx).User.ID))
			if err != nil {
				return nil, err
			}
			if err := s.record(ctx, s.db, audit.WebhookCreate, w, nil); err != nil {
				return nil, err
			}
			return &struct{ Body *WebhookWithURL }{s.withSecret(w, token)}, nil
		})

	huma.Register(api, op("update-webhook", http.MethodPatch, "/api/webhooks/{id}", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body WebhookRequest
		}) (*struct{ Body *Webhook }, error) {
			w, err := s.manageable(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			name, err := cleanName(in.Body.Name)
			if err != nil {
				return nil, err
			}
			updated, err := scanWebhook(s.db.QueryRow(ctx, `UPDATE webhooks SET name = $2 WHERE id = $1 RETURNING `+webhookCols, w.ID, name))
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("webhook")
			}
			if err != nil {
				return nil, err
			}
			if cs := audit.Diff(nil, "name", w.Name, updated.Name); len(cs) > 0 {
				if err := s.record(ctx, s.db, audit.WebhookUpdate, updated, cs); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Webhook }{updated}, nil
		})

	huma.Register(api, op("delete-webhook", http.MethodDelete, "/api/webhooks/{id}", http.StatusNoContent),
		func(ctx context.Context, in *pathID) (*struct{}, error) {
			w, err := s.manageable(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			var avatar *string
			err = s.db.QueryRow(ctx, `DELETE FROM webhooks WHERE id = $1 RETURNING avatar_sha256`, w.ID).Scan(&avatar)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("webhook")
			}
			if err != nil {
				return nil, err
			}
			if err := s.record(ctx, s.db, audit.WebhookDelete, w, nil); err != nil {
				return nil, err
			}
			if avatar != nil {
				s.removeBlob(ctx, *avatar) // messages that show it keep it (message_images)
			}
			return nil, nil
		})

	huma.Register(api, op("regenerate-webhook-token", http.MethodPost, "/api/webhooks/{id}/token", 0),
		func(ctx context.Context, in *pathID) (*struct{ Body *WebhookWithURL }, error) {
			w, err := s.manageable(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			token, hash, err := auth.NewToken()
			if err != nil {
				return nil, err
			}
			updated, err := scanWebhook(s.db.QueryRow(ctx, `UPDATE webhooks SET token_hash = $2 WHERE id = $1 RETURNING `+webhookCols, w.ID, hash))
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("webhook")
			}
			if err != nil {
				return nil, err
			}
			// Never the token itself: only that it changed.
			if err := s.record(ctx, s.db, audit.WebhookUpdate, updated, []audit.LogChange{{Field: "token"}}); err != nil {
				return nil, err
			}
			return &struct{ Body *WebhookWithURL }{s.withSecret(updated, token)}, nil
		})
}
