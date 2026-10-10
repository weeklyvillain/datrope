// Package webhooks owns incoming webhooks: secret URLs that services outside
// Datrope post Discord-style messages to, each into one webhook channel.
package webhooks

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

// Blobs is what this package needs from files: cleaned, stored images.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ImageSize(data []byte) (width, height int, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServePrivateBlob(w http.ResponseWriter, r *http.Request, sum, contentType string)
}

type Webhook struct {
	ID        id.ID     `json:"id"`
	ChannelID id.ID     `json:"channel_id"`
	Name      string    `json:"name"`
	AvatarURL string    `json:"avatar_url,omitempty" doc:"Absent when it has none; clients draw the webhook icon"`
	CreatedBy *id.ID    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// WebhookWithURL is a webhook with its secret. Only create and regenerate
// return it: the token is not stored, only its SHA-256.
type WebhookWithURL struct {
	Webhook
	Token string `json:"token" doc:"Shown once"`
	URL   string `json:"url" doc:"POST Discord-style messages here; shown once"`
}

// Messages is what this package needs from messages.
type Messages interface {
	PostWebhook(ctx context.Context, p messages.WebhookPost) (*messages.Message, error)
}

type Service struct {
	db        *pgxpool.Pool
	channels  Channels
	messages  Messages
	blobs     Blobs
	publicURL string
	limit     *ratelimit.Limiter // posts per webhook
	images    *fetcher
}

func NewService(pool *pgxpool.Pool, c Channels, m Messages, b Blobs, publicURL string) *Service {
	return &Service{db: pool, channels: c, messages: m, blobs: b, publicURL: strings.TrimSuffix(publicURL, "/"),
		limit:  ratelimit.New(30, 30), // 30 a minute per webhook
		images: &fetcher{allow: linkpreview.Public}}
}

// SetImageAllow replaces the check on every address an image download
// dials. Tests use it to fetch from httptest servers on 127.0.0.1.
func (s *Service) SetImageAllow(allow func(net.IP) bool) { s.images.allow = allow }

const webhookCols = `id, channel_id, name, avatar_sha256, created_by, created_at`

func scanWebhook(row pgx.Row) (*Webhook, error) {
	var w Webhook
	var avatar *string
	var createdBy *int64
	if err := row.Scan(&w.ID, &w.ChannelID, &w.Name, &avatar, &createdBy, &w.CreatedAt); err != nil {
		return nil, err
	}
	w.CreatedBy = id.FromNullable(createdBy)
	if avatar != nil && len(*avatar) >= 12 {
		w.AvatarURL = "/api/webhooks/" + w.ID.String() + "/avatar?v=" + (*avatar)[:12]
	}
	return &w, nil
}

// withSecret adds the token and the execute URL built from it.
func (s *Service) withSecret(w *Webhook, token string) *WebhookWithURL {
	return &WebhookWithURL{Webhook: *w, Token: token, URL: s.publicURL + "/api/webhooks/" + w.ID.String() + "/" + token}
}

// channel loads a channel the signed-in user may manage webhooks in.
func (s *Service) channel(ctx context.Context, raw string) (*channels.Channel, error) {
	chID, err := httpx.ParseID(raw, "channel")
	if err != nil {
		return nil, err
	}
	ch, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, perms.ManageWebhooks)
	return ch, err
}

// manageable loads a webhook the signed-in user may manage: MANAGE_WEBHOOKS
// in its channel. One in a channel they cannot see is reported as missing.
func (s *Service) manageable(ctx context.Context, raw string) (*Webhook, error) {
	wid, err := httpx.ParseID(raw, "webhook")
	if err != nil {
		return nil, err
	}
	w, err := scanWebhook(s.db.QueryRow(ctx, `SELECT `+webhookCols+` FROM webhooks WHERE id = $1`, wid))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("webhook")
	}
	if err != nil {
		return nil, err
	}
	if _, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, w.ChannelID, perms.ManageWebhooks); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) && he.Status == http.StatusNotFound {
			return nil, httpx.NotFound("webhook")
		}
		return nil, err
	}
	return w, nil
}

// removeBlob drops an avatar blob nothing uses any more; the sweep retries failures.
func (s *Service) removeBlob(ctx context.Context, sum string) {
	if err := s.blobs.RemoveBlobs(ctx, []string{sum}); err != nil {
		slog.WarnContext(ctx, "webhooks: removing an old avatar; the sweep will retry", "err", err)
	}
}
