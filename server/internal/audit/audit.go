// Package audit keeps the server's audit log: what moderators and admins
// changed, and who did it. Services call Record next to the change; members
// holding VIEW_AUDIT_LOG read it newest first, a page at a time.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Retention is how long entries are kept.
const Retention = 90 * 24 * time.Hour

type Action string

const (
	MemberKick       Action = "member.kick"
	MemberBan        Action = "member.ban"
	MemberUnban      Action = "member.unban"
	MemberRoleAdd    Action = "member.role_add"
	MemberRoleRemove Action = "member.role_remove"

	VoiceMove       Action = "voice.move"
	VoiceDisconnect Action = "voice.disconnect"
	VoiceMute       Action = "voice.mute"
	VoiceUnmute     Action = "voice.unmute"

	ChannelCreate  Action = "channel.create"
	ChannelUpdate  Action = "channel.update"
	ChannelDelete  Action = "channel.delete"
	OverrideUpdate Action = "channel.override_update"
	OverrideDelete Action = "channel.override_delete"
	CategoryCreate Action = "category.create"
	CategoryUpdate Action = "category.update"
	CategoryDelete Action = "category.delete"
	AlertCreate    Action = "alert.create"
	AlertDelete    Action = "alert.delete"
	WebhookCreate  Action = "webhook.create"
	WebhookUpdate  Action = "webhook.update"
	WebhookDelete  Action = "webhook.delete"
	MessageDelete  Action = "message.delete"
	MessagePin     Action = "message.pin"
	MessageUnpin   Action = "message.unpin"
	RoleCreate     Action = "role.create"
	RoleUpdate     Action = "role.update"
	RoleDelete     Action = "role.delete"
	ServerUpdate   Action = "server.update"
	WelcomeUpdate  Action = "welcome.update"
	InviteCreate   Action = "invite.create"
	InviteDelete   Action = "invite.delete"
	EmojiCreate    Action = "emoji.create"
	EmojiUpdate    Action = "emoji.update"
	EmojiDelete    Action = "emoji.delete"
	SoundCreate    Action = "sound.create"
	SoundUpdate    Action = "sound.update"
	SoundDelete    Action = "sound.delete"
)

// Actions lists every action, for the OpenAPI enum.
var Actions = []Action{
	MemberKick, MemberBan, MemberUnban, MemberRoleAdd, MemberRoleRemove,
	VoiceMove, VoiceDisconnect, VoiceMute, VoiceUnmute,
	ChannelCreate, ChannelUpdate, ChannelDelete, OverrideUpdate, OverrideDelete,
	CategoryCreate, CategoryUpdate, CategoryDelete, AlertCreate, AlertDelete,
	WebhookCreate, WebhookUpdate, WebhookDelete, MessageDelete, MessagePin, MessageUnpin,
	RoleCreate, RoleUpdate, RoleDelete, ServerUpdate, WelcomeUpdate, InviteCreate, InviteDelete,
	EmojiCreate, EmojiUpdate, EmojiDelete, SoundCreate, SoundUpdate, SoundDelete,
}

// LogRef names a channel, role or other thing as it was when the entry was made.
type LogRef struct {
	ID   id.ID  `json:"id"`
	Name string `json:"name"`
}

// LogChange is one field an update changed. Old and New are display text.
type LogChange struct {
	Field string `json:"field"`
	Old   string `json:"old"`
	New   string `json:"new"`
}

// LogDetails says what an entry is about; each action sets the fields it needs.
type LogDetails struct {
	Name    string      `json:"name,omitempty" doc:"The target's name when it is not a user: channel, category, role, emoji, sound, webhook, invite code"`
	Channel *LogRef     `json:"channel,omitempty" doc:"Where it happened: the channel of a message, override, webhook or alert, or a member's voice channel"`
	From    *LogRef     `json:"from,omitempty" doc:"voice.move: the channel the member left"`
	To      *LogRef     `json:"to,omitempty" doc:"voice.move: the channel the member was sent to"`
	Role    *LogRef     `json:"role,omitempty" doc:"The role given or taken, or whose override changed"`
	Reason  string      `json:"reason,omitempty"`
	Changes []LogChange `json:"changes,omitempty"`
}

// Execer is a pool or a transaction.
type Execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Record adds an entry made by the signed-in caller. targetID is 0 when there
// is none. Run it in the change's transaction when there is one.
func Record(ctx context.Context, q Execer, action Action, targetID id.ID, d LogDetails) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	var target *int64
	if targetID != 0 {
		t := int64(targetID)
		target = &t
	}
	_, err = q.Exec(ctx, `INSERT INTO audit_log (id, actor_id, action, target_id, details) VALUES ($1, $2, $3, $4, $5)`,
		id.New(), auth.Current(ctx).User.ID, action, target, b)
	if err != nil {
		return fmt.Errorf("audit: %w", err)
	}
	return nil
}

// Diff appends a change when old and new differ.
func Diff(cs []LogChange, field, old, new string) []LogChange {
	if old == new {
		return cs
	}
	return append(cs, LogChange{Field: field, Old: old, New: new})
}

type Perms interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
}

type Users interface {
	PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]auth.PublicUser, error)
}

type Service struct {
	db    *pgxpool.Pool
	perms Perms
	users Users
	done  chan struct{}
	stop  sync.Once
}

func NewService(db *pgxpool.Pool, p Perms, u Users) *Service {
	return &Service{db: db, perms: p, users: u, done: make(chan struct{})}
}

// Prune deletes entries older than Retention before now and reports how many.
func (s *Service) Prune(ctx context.Context, now time.Time) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM audit_log WHERE id < $1`, id.FirstAt(now.Add(-Retention)))
	return tag.RowsAffected(), err
}

// Start prunes old entries every hour until Close.
func (s *Service) Start() {
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		prune := func(now time.Time) {
			if _, err := s.Prune(context.Background(), now); err != nil {
				slog.Error("audit: prune", "err", err)
			}
		}
		prune(time.Now())
		for {
			select {
			case <-s.done:
				return
			case now := <-t.C:
				prune(now)
			}
		}
	}()
}

func (s *Service) Close() { s.stop.Do(func() { close(s.done) }) }
