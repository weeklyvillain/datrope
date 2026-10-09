// Package expressions owns custom emoji (and, in M7, soundboard sounds).
package expressions

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	MaxEmoji      = 200
	MaxEmojiBytes = 256 << 10
)

var nameRe = regexp.MustCompile(`^[A-Za-z0-9_]{2,32}$`)

var errNotFound = errors.New("emoji not found")

type Emoji struct {
	ID        id.ID  `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url" doc:"Public image URL"`
	CreatorID *id.ID `json:"creator_id,omitempty"`
}

type EmojiUpdate struct {
	Emoji []Emoji `json:"emoji" doc:"Every custom emoji on the server"`
}

// Server is what this package needs from communities.
type Server interface {
	ServerID(ctx context.Context) (id.ID, error)
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
	PermMember(ctx context.Context, communityID, userID id.ID) (communities.PermMember, error)
}

// Blobs is what this package needs from files.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	StoreBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum string, err error)
	RemoveBlobs(ctx context.Context, sums []string) error
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
}

// Reactions is what this package needs from messages.
type Reactions interface {
	RemoveReactions(ctx context.Context, emoji string) error
}

type Service struct {
	db        *pgxpool.Pool
	bus       *events.Bus
	server    Server
	blobs     Blobs
	reactions Reactions
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, server Server, blobs Blobs, reactions Reactions) *Service {
	return &Service{db: pool, bus: bus, server: server, blobs: blobs, reactions: reactions}
}

func (s *Service) List(ctx context.Context) ([]Emoji, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name, creator_id FROM emoji ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Emoji{}
	for rows.Next() {
		var e Emoji
		var creator *int64
		if err := rows.Scan(&e.ID, &e.Name, &creator); err != nil {
			return nil, err
		}
		e.CreatorID = id.FromNullable(creator)
		e.URL = "/api/emoji/" + e.ID.String()
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Service) EmojiExists(ctx context.Context, emojiID id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM emoji WHERE id = $1)`, emojiID).Scan(&ok)
	return ok, err
}

func (s *Service) get(ctx context.Context, emojiID id.ID) (*Emoji, string, string, error) {
	var e Emoji
	var sum, ct string
	var creator *int64
	err := s.db.QueryRow(ctx, `SELECT id, name, creator_id, sha256, content_type FROM emoji WHERE id = $1`, emojiID).
		Scan(&e.ID, &e.Name, &creator, &sum, &ct)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", "", errNotFound
	}
	if err != nil {
		return nil, "", "", err
	}
	e.CreatorID = id.FromNullable(creator)
	e.URL = "/api/emoji/" + e.ID.String()
	return &e, sum, ct, nil
}

func (s *Service) publish(ctx context.Context) error {
	list, err := s.List(ctx)
	if err != nil {
		return err
	}
	sid, err := s.server.ServerID(ctx)
	if err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: "EMOJI_UPDATE", Data: EmojiUpdate{Emoji: list}, Scope: events.Scope{CommunityID: sid}})
	return nil
}
