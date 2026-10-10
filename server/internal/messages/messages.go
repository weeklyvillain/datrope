// Package messages owns messages, typing notifications, and read markers.
package messages

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
	Readable(ctx context.Context, userID id.ID) ([]id.ID, error)
	Get(ctx context.Context, channelID id.ID) (*channels.Channel, error)
}

type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
	UserIDsByUsername(ctx context.Context, names []string) (map[string]id.ID, error)
}

// Ranks is what this package needs from communities: the role hierarchy.
type Ranks interface {
	Outranks(ctx context.Context, actorID, targetID id.ID) (bool, error)
}

// Attachments is what this package needs from files.
type Attachments interface {
	Claim(ctx context.Context, tx pgx.Tx, messageID, channelID, uploaderID id.ID, ids []id.ID) ([]files.Attachment, error)
	ForMessages(ctx context.Context, messageIDs []id.ID) (map[id.ID][]files.Attachment, error)
	DeleteForMessage(ctx context.Context, tx pgx.Tx, messageID id.ID) ([]string, error)
	RemoveBlobs(ctx context.Context, sums []string) error
}

type Message struct {
	ID              id.ID                `json:"id"`
	ChannelID       id.ID                `json:"channel_id"`
	Author          *auth.PublicUser     `json:"author,omitempty" doc:"Absent for webhook messages"`
	Webhook         *WebhookAuthor       `json:"webhook,omitempty" doc:"Who a webhook message shows as; absent for people's messages"`
	Title           string               `json:"title,omitempty" doc:"Announcements only"`
	Content         string               `json:"content"`
	Attachments     []files.Attachment   `json:"attachments"`
	CreatedAt       time.Time            `json:"created_at"`
	EditedAt        *time.Time           `json:"edited_at,omitempty"`
	Deleted         bool                 `json:"deleted"`
	Nonce           string               `json:"nonce,omitempty" doc:"Echoes the sender's nonce on create"`
	ReplyTo         *ReplyRef            `json:"reply_to,omitempty"`
	Mentions        []id.ID              `json:"mentions"`
	Reactions       []Reaction           `json:"reactions"`
	Embed           *linkpreview.Preview `json:"embed,omitempty" doc:"Text preview of the first link; attached after send by MESSAGE_UPDATE"`
	Pinned          bool                 `json:"pinned"`
	PinnedAt        *time.Time           `json:"pinned_at,omitempty"`
	Thread          *ThreadSummary       `json:"thread,omitempty" doc:"The thread started from this message"`
	Embeds          []WebhookEmbed       `json:"embeds,omitempty" doc:"Rich embeds a webhook posted (not link previews); image URLs point at this instance"`
	Poll            *Poll                `json:"poll,omitempty" doc:"Set when the message is a poll"`
	MentionEveryone bool                 `json:"mention_everyone,omitempty" doc:"The message pings everyone who can read it"`
	Kind            string               `json:"kind,omitempty" enum:"member_leave" doc:"Set on system messages: member_leave means the author left the group DM"`

	replyToID *id.ID
}

type MessageDeleted struct {
	ID        id.ID `json:"id"`
	ChannelID id.ID `json:"channel_id"`
}

type TypingStart struct {
	ChannelID id.ID     `json:"channel_id"`
	UserID    id.ID     `json:"user_id"`
	At        time.Time `json:"at"`
}

// ReadState says how far a user has read a channel and where it ends.
type ReadState struct {
	ChannelID     id.ID  `json:"channel_id"`
	LastReadID    *id.ID `json:"last_read_id,omitempty"`
	LastMessageID *id.ID `json:"last_message_id,omitempty"`
}

type Service struct {
	db          *pgxpool.Pool
	bus         *events.Bus
	channels    Channels
	users       Users
	attachments Attachments
	ranks       Ranks
	custom      CustomEmoji
	reactLimit  *ratelimit.Limiter
	voteLimit   *ratelimit.Limiter
	searchLimit *ratelimit.Limiter
	previews    Previews
	threads     Threads
	blobs       Blobs          // stores and serves webhook messages' images
	bg          sync.WaitGroup // background preview work
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, c Channels, u Users, a Attachments, r Ranks) *Service {
	return &Service{db: pool, bus: bus, channels: c, users: u, attachments: a, ranks: r, reactLimit: ratelimit.New(60, 10), voteLimit: ratelimit.New(60, 10), searchLimit: ratelimit.New(120, 30)}
}

const messageCols = `id, channel_id, author_id, content, edited_at, deleted, reply_to_id, mentions, embed, pinned_at,
	webhook_id, author_name, author_avatar_sha256, embeds, title, kind, mention_everyone`

func scanMessage(row pgx.Row, extra ...any) (*Message, error) {
	var m Message
	var authorID, webhookID, replyTo *int64
	var mentions []int64
	var embed, embeds []byte
	var authorName string
	var avatar *string
	dest := append([]any{&m.ID, &m.ChannelID, &authorID, &m.Content, &m.EditedAt, &m.Deleted, &replyTo, &mentions, &embed, &m.PinnedAt,
		&webhookID, &authorName, &avatar, &embeds, &m.Title, &m.Kind, &m.MentionEveryone}, extra...)
	if err := row.Scan(dest...); err != nil {
		return nil, err
	}
	if embed != nil {
		if err := json.Unmarshal(embed, &m.Embed); err != nil {
			return nil, err
		}
	}
	if embeds != nil {
		if err := json.Unmarshal(embeds, &m.Embeds); err != nil {
			return nil, err
		}
	}
	if authorID != nil {
		m.Author = &auth.PublicUser{ID: id.ID(*authorID)} // the rest is filled by withAuthors
	} else { // posted by a webhook
		m.Webhook = &WebhookAuthor{ID: id.FromNullable(webhookID), Name: authorName}
		if avatar != nil {
			m.Webhook.AvatarURL = imageURL(m.ID, *avatar)
		}
	}
	m.Pinned = m.PinnedAt != nil
	m.replyToID = id.FromNullable(replyTo)
	m.Mentions = make([]id.ID, len(mentions))
	for i, v := range mentions {
		m.Mentions[i] = id.ID(v)
	}
	m.CreatedAt = m.ID.Time()
	m.Attachments = []files.Attachment{}
	return &m, nil
}

// withAuthors fills the authors of people's messages; webhook messages have none.
func (s *Service) withAuthors(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		if m.Author != nil {
			ids = append(ids, m.Author.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	users, err := s.users.PublicUsers(ctx, ids)
	if err != nil {
		return err
	}
	for i := range ms {
		if ms[i].Author != nil {
			u := users[ms[i].Author.ID]
			ms[i].Author = &u
		}
	}
	return nil
}

// list returns up to limit messages, newest first: the latest ones, or those
// before, after or around a message ID (callers set at most one).
func (s *Service) list(ctx context.Context, channelID id.ID, before, after, around *id.ID, limit int) ([]Message, error) {
	var sql string
	args := []any{channelID}
	switch {
	case after != nil:
		sql = `SELECT * FROM (SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id LIMIT $3) x ORDER BY id DESC`
		args = append(args, *after, limit)
	case around != nil: // the message, older ones, then newer ones
		sql = `(SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id <= $2 ORDER BY id DESC LIMIT $3)
			UNION ALL (SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id LIMIT $4)
			ORDER BY id DESC`
		args = append(args, *around, limit-limit/2, limit/2)
	default:
		sql = `SELECT ` + messageCols + ` FROM messages WHERE channel_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`
		args = append(args, before, limit)
	}
	rows, err := s.db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	return out, s.hydrate(ctx, out)
}

// hydrate fills what the messages table does not hold: authors, attachments,
// reply references, reactions, polls and thread summaries.
func (s *Service) hydrate(ctx context.Context, ms []Message) error {
	if err := s.withAuthors(ctx, ms); err != nil {
		return err
	}
	if err := s.withAttachments(ctx, ms); err != nil {
		return err
	}
	if err := s.withReplies(ctx, ms); err != nil {
		return err
	}
	if err := s.withReactions(ctx, ms); err != nil {
		return err
	}
	if err := s.withPolls(ctx, ms); err != nil {
		return err
	}
	return s.withThreads(ctx, ms)
}

func (s *Service) withAttachments(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		if !m.Deleted {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	byMessage, err := s.attachments.ForMessages(ctx, ids)
	if err != nil {
		return err
	}
	for i := range ms {
		if a := byMessage[ms[i].ID]; a != nil {
			ms[i].Attachments = a
		}
	}
	return nil
}

// get returns a live (not deleted) message in a channel.
func (s *Service) get(ctx context.Context, channelID id.ID, rawMessageID string) (*Message, error) {
	mid, err := httpx.ParseID(rawMessageID, "message")
	if err != nil {
		return nil, err
	}
	m, err := scanMessage(s.db.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted`, mid, channelID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("message")
	}
	return m, err
}

// ReadStates returns, for each channel, the user's read marker and the
// newest live message. A forum has no messages of its own; its newest
// message is the newest one across its posts.
func (s *Service) ReadStates(ctx context.Context, userID id.ID, channelIDs []id.ID) ([]ReadState, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, rs.last_message_id, lm.max_id
		FROM unnest($2::bigint[]) AS c(id)
		LEFT JOIN channels ch ON ch.id = c.id
		LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
		LEFT JOIN LATERAL (
			SELECT max(x.id) AS max_id FROM (
				SELECT max(m.id) AS id FROM messages m
				WHERE ch.type IS DISTINCT FROM 'forum' AND m.channel_id = c.id AND NOT m.deleted
				UNION ALL
				SELECT max(t.id) FROM channels p
				CROSS JOIN LATERAL (SELECT m.id FROM messages m WHERE m.channel_id = p.id AND NOT m.deleted ORDER BY m.id DESC LIMIT 1) t
				WHERE ch.type = 'forum' AND p.parent_channel_id = c.id AND p.type = 'thread'
			) x
		) lm ON TRUE`,
		userID, id.Int64s(channelIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReadState{}
	for rows.Next() {
		var r ReadState
		var lastRead, lastMsg *int64
		if err := rows.Scan(&r.ChannelID, &lastRead, &lastMsg); err != nil {
			return nil, err
		}
		r.LastReadID, r.LastMessageID = id.FromNullable(lastRead), id.FromNullable(lastMsg)
		out = append(out, r)
	}
	return out, rows.Err()
}

// markRead moves userID's read marker in each channel up to messageID, so a
// message someone sends is read for them, even after they reload.
func markRead(ctx context.Context, tx pgx.Tx, userID, messageID id.ID, channelIDs ...id.ID) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO read_states (user_id, channel_id, last_message_id)
		SELECT $1, c, $2 FROM unnest($3::bigint[]) AS c
		ON CONFLICT (user_id, channel_id)
		DO UPDATE SET last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id)`,
		userID, messageID, id.Int64s(channelIDs))
	return err
}

func (s *Service) publish(typ string, channelID id.ID, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{ChannelID: channelID}})
}
