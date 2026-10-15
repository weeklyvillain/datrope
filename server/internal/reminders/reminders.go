// Package reminders stores reminders and delivers them as DMs from the System account when they are due.
package reminders

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

const (
	MaxPending = 100                  // pending reminders per user
	MaxAhead   = 366 * 24 * time.Hour // how far ahead a reminder may be set
	batch      = 50                   // reminders claimed per query
	maxWait    = time.Minute          // the scheduler looks again at least this often
)

// Messages is what this package needs from messages.
type Messages interface {
	Quote(ctx context.Context, viewer, channelID, messageID id.ID) (*messages.ReminderQuote, error)
	PostReminder(ctx context.Context, r messages.DueReminder) (*messages.Message, error)
}

type Reminder struct {
	ID        id.ID                   `json:"id"`
	DueAt     time.Time               `json:"due_at"`
	Note      string                  `json:"note"`
	ChannelID *id.ID                  `json:"channel_id,omitempty"`
	MessageID *id.ID                  `json:"message_id,omitempty"`
	Quote     *messages.ReminderQuote `json:"quote,omitempty" doc:"The message, as I may see it now; absent for free text or when unavailable"`
}

type ReminderList struct {
	Reminders []Reminder `json:"reminders" doc:"Pending reminders, soonest first"`
}

type CreateReminderRequest struct {
	DueAt     time.Time `json:"due_at" doc:"When to remind; in the future, at most 366 days ahead"`
	Note      string    `json:"note,omitempty" maxLength:"500"`
	ChannelID *id.ID    `json:"channel_id,omitempty" doc:"With message_id: the message to be reminded about"`
	MessageID *id.ID    `json:"message_id,omitempty"`
}

// RemindersUpdate tells a user their pending reminders changed; clients refetch the list.
type RemindersUpdate struct{}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	messages Messages
	wake     chan struct{} // nudges the scheduler: a reminder was added or removed
	done     chan struct{}
	stop     sync.Once
	wg       sync.WaitGroup
	mu       sync.Mutex
	clock    func() time.Time
	active   func() bool // nil: always live; see SetActive
}

func NewService(db *pgxpool.Pool, bus *events.Bus, m Messages) *Service {
	return &Service{db: db, bus: bus, messages: m, wake: make(chan struct{}, 1), done: make(chan struct{}), clock: time.Now}
}

func (s *Service) now() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.clock()
}

func (s *Service) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) changed(userID id.ID) {
	s.bus.Publish(events.Event{Type: "REMINDERS_UPDATE", Data: RemindersUpdate{}, Scope: events.Scope{UserIDs: []id.ID{userID}}})
}

func (s *Service) create(ctx context.Context, userID id.ID, req CreateReminderRequest) (*Reminder, error) {
	now := s.now()
	if !req.DueAt.After(now) || req.DueAt.After(now.Add(MaxAhead)) {
		return nil, httpx.BadRequest("INVALID_DUE_AT", "pick a time in the future, at most a year ahead")
	}
	if (req.ChannelID == nil) != (req.MessageID == nil) {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "give both channel_id and message_id, or neither")
	}
	r := &Reminder{ID: id.New(), DueAt: req.DueAt.UTC(), Note: strings.TrimSpace(req.Note), ChannelID: req.ChannelID, MessageID: req.MessageID}
	if r.MessageID != nil {
		q, err := s.messages.Quote(ctx, userID, *r.ChannelID, *r.MessageID)
		if err != nil {
			return nil, err
		}
		if q == nil {
			return nil, httpx.NotFound("message")
		}
		r.Quote = q
	}
	tag, err := s.db.Exec(ctx, `
		INSERT INTO reminders (id, user_id, due_at, note, channel_id, message_id)
		SELECT $1, $2, $3, $4, $5, $6
		WHERE (SELECT count(*) FROM reminders WHERE user_id = $2 AND fired_at IS NULL) < $7`,
		r.ID, userID, r.DueAt, r.Note, r.ChannelID, r.MessageID, MaxPending)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, httpx.BadRequest("TOO_MANY_REMINDERS", "you have 100 pending reminders; cancel one first")
	}
	s.changed(userID)
	s.poke()
	return r, nil
}

func (s *Service) list(ctx context.Context, userID id.ID) ([]Reminder, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, due_at, note, channel_id, message_id FROM reminders
		WHERE user_id = $1 AND fired_at IS NULL ORDER BY due_at, id`, userID)
	if err != nil {
		return nil, err
	}
	out := []Reminder{}
	for rows.Next() {
		var r Reminder
		var ch, msg *int64
		if err := rows.Scan(&r.ID, &r.DueAt, &r.Note, &ch, &msg); err != nil {
			rows.Close()
			return nil, err
		}
		r.ChannelID, r.MessageID = id.FromNullable(ch), id.FromNullable(msg)
		out = append(out, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, r := range out {
		if r.MessageID == nil {
			continue
		}
		q, err := s.messages.Quote(ctx, userID, *r.ChannelID, *r.MessageID)
		if err != nil {
			return nil, err
		}
		out[i].Quote = q
	}
	return out, nil
}

func (s *Service) delete(ctx context.Context, userID, reminderID id.ID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM reminders WHERE id = $1 AND user_id = $2 AND fired_at IS NULL`, reminderID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("reminder")
	}
	s.changed(userID)
	s.poke()
	return nil
}

// SetClock replaces the clock; tests move time forward with it.
func (s *Service) SetClock(now func() time.Time) {
	s.mu.Lock()
	s.clock = now
	s.mu.Unlock()
	s.poke()
}

// Start delivers due reminders until Close: at once (catching up after downtime), then whenever
// the next one is due, a reminder is added or removed, or a minute has passed.
func (s *Service) Start() {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx := context.Background()
		for {
			if s.isActive() {
				if err := s.FireDue(ctx); err != nil {
					slog.Error("reminders: fire", "err", err)
				}
			}
			t := time.NewTimer(s.untilNext(ctx))
			select {
			case <-s.done:
				t.Stop()
				return
			case <-s.wake:
			case <-t.C:
			}
			t.Stop()
		}
	}()
}

func (s *Service) Close() {
	s.stop.Do(func() { close(s.done) })
	s.wg.Wait()
}

// untilNext is how long to sleep: until the next reminder is due, at most maxWait.
func (s *Service) untilNext(ctx context.Context) time.Duration {
	var next *time.Time
	if err := s.db.QueryRow(ctx, `SELECT min(due_at) FROM reminders WHERE fired_at IS NULL`).Scan(&next); err != nil {
		slog.Error("reminders: next", "err", err)
		return maxWait
	}
	if next == nil {
		return maxWait
	}
	return min(max(next.Sub(s.now()), 0), maxWait)
}

// FireDue delivers every reminder that is due. Each is marked fired before it is delivered,
// so one whose DM fails is dropped rather than retried forever; two servers never both deliver one.
func (s *Service) FireDue(ctx context.Context) error {
	for {
		rows, err := s.db.Query(ctx, `
			UPDATE reminders SET fired_at = $1
			WHERE id IN (SELECT id FROM reminders WHERE fired_at IS NULL AND due_at <= $1
			             ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
			RETURNING id, user_id, note, channel_id, message_id`, s.now(), batch)
		if err != nil {
			return err
		}
		due, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (messages.DueReminder, error) {
			var r messages.DueReminder
			var ch, msg *int64
			err := row.Scan(&r.ID, &r.UserID, &r.Note, &ch, &msg)
			r.ChannelID, r.MessageID = id.FromNullable(ch), id.FromNullable(msg)
			return r, err
		})
		if err != nil {
			return err
		}
		for _, r := range due {
			if _, err := s.messages.PostReminder(ctx, r); err != nil {
				slog.Error("reminders: deliver", "reminder", r.ID, "err", err)
			}
			s.changed(r.UserID) // it left the pending list either way
		}
		if len(due) < batch {
			return nil
		}
	}
}
