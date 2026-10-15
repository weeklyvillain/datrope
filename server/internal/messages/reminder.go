package messages

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// KindReminder marks a reminder the System account delivered.
const KindReminder = "reminder"

const excerptLen = 200

// DueReminder is a reminder the scheduler claimed and wants delivered.
type DueReminder struct {
	ID, UserID           id.ID
	Note                 string
	ChannelID, MessageID *id.ID
}

// ReminderTarget is the message a reminder is about.
type ReminderTarget struct {
	ChannelID id.ID `json:"channel_id"`
	MessageID id.ID `json:"message_id"`
}

// ReminderQuote shows the message a reminder is about, as the reader may see it now.
type ReminderQuote struct {
	AuthorName  string    `json:"author_name" doc:"The author's display name, or a webhook's name"`
	ChannelName string    `json:"channel_name" doc:"Empty in a DM"`
	CreatedAt   time.Time `json:"created_at"`
	Excerpt     string    `json:"excerpt" doc:"Up to 200 characters; empty when the message is only attachments"`
}

// ReminderInfo is what a reminder message shows, resolved for its reader each time it is read.
type ReminderInfo struct {
	Note        string          `json:"note"`
	Target      *ReminderTarget `json:"target,omitempty" doc:"Absent for a free-text reminder, or when the message is unavailable"`
	Quote       *ReminderQuote  `json:"quote,omitempty"`
	Unavailable bool            `json:"unavailable,omitempty" doc:"The message was deleted, or the reader can no longer see it"`
}

// PostReminder delivers a reminder: a message from System in the owner's System DM.
func (s *Service) PostReminder(ctx context.Context, r DueReminder) (*Message, error) {
	dm, err := s.channels.SystemDM(ctx, r.UserID)
	if err != nil {
		return nil, err
	}
	content := "Reminder"
	if r.Note != "" {
		content += ": " + r.Note
	}
	m := &Message{ID: id.New(), ChannelID: dm.ID, Author: &auth.PublicUser{ID: auth.SystemUserID}, Content: content,
		Mentions: []id.ID{}, MentionRoles: []id.ID{}, Kind: KindReminder}
	m.CreatedAt = m.ID.Time()
	if _, err := s.db.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, kind, reminder_id) VALUES ($1, $2, $3, $4, $5, $6)`,
		m.ID, dm.ID, auth.SystemUserID, content, KindReminder, r.ID); err != nil {
		return nil, err
	}
	one := []Message{*m}
	if err := s.hydrate(ctx, one); err != nil {
		return nil, err
	}
	s.publish("MESSAGE_CREATE", dm.ID, &one[0])
	return &one[0], nil
}

// Quote shows a message to viewer, or returns nil when it is deleted or viewer cannot read its channel.
func (s *Service) Quote(ctx context.Context, viewer, channelID, messageID id.ID) (*ReminderQuote, error) {
	ch, _, err := s.channels.Access(ctx, viewer, channelID, perms.ViewChannel|perms.ReadHistory)
	var denied *httpx.Error
	if errors.As(err, &denied) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m, err := scanMessage(s.db.QueryRow(ctx,
		`SELECT `+messageCols+` FROM messages WHERE id = $1 AND channel_id = $2 AND NOT deleted`, messageID, channelID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	one := []Message{*m}
	if err := s.withAuthors(ctx, one); err != nil {
		return nil, err
	}
	q := &ReminderQuote{ChannelName: ch.Name, CreatedAt: one[0].CreatedAt, Excerpt: excerpt(one[0].Content)}
	switch a := one[0].Author; {
	case a != nil && a.DisplayName != "":
		q.AuthorName = a.DisplayName
	case a != nil:
		q.AuthorName = a.Username
	case one[0].Webhook != nil:
		q.AuthorName = one[0].Webhook.Name
	}
	return q, nil
}

func excerpt(s string) string {
	r := []rune(s)
	if len(r) <= excerptLen {
		return s
	}
	return string(r[:excerptLen]) + "…"
}

// withReminders fills Reminder on reminder messages. Only the owner reads their System DM,
// so the quote is resolved as the owner sees it now.
func (s *Service) withReminders(ctx context.Context, ms []Message) error {
	var ids []id.ID
	for _, m := range ms {
		if m.Kind == KindReminder && !m.Deleted {
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `
		SELECT m.id, r.user_id, r.note, r.channel_id, r.message_id
		FROM messages m JOIN reminders r ON r.id = m.reminder_id WHERE m.id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	type row struct {
		owner   id.ID
		note    string
		ch, msg *id.ID
	}
	got := map[id.ID]row{}
	for rows.Next() {
		var mid id.ID
		var r row
		var ch, msg *int64
		if err := rows.Scan(&mid, &r.owner, &r.note, &ch, &msg); err != nil {
			rows.Close()
			return err
		}
		r.ch, r.msg = id.FromNullable(ch), id.FromNullable(msg)
		got[mid] = r
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range ms {
		r, ok := got[ms[i].ID]
		if !ok {
			continue
		}
		info := &ReminderInfo{Note: r.note}
		if r.ch != nil && r.msg != nil {
			q, err := s.Quote(ctx, r.owner, *r.ch, *r.msg)
			if err != nil {
				return err
			}
			if q == nil {
				info.Unavailable = true
			} else {
				info.Quote, info.Target = q, &ReminderTarget{ChannelID: *r.ch, MessageID: *r.msg}
			}
		}
		ms[i].Reminder = info
	}
	return nil
}
