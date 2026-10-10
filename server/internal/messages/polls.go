package messages

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// Poll limits (spec §3), in characters after trimming.
const (
	maxPollQuestion = 300
	maxPollOption   = 55
	minPollOptions  = 2
	maxPollOptions  = 10
)

// pollDurations are the end times a poll may be created with.
var pollDurations = map[string]time.Duration{
	"1h": time.Hour, "4h": 4 * time.Hour, "8h": 8 * time.Hour, "24h": 24 * time.Hour,
	"3d": 72 * time.Hour, "1w": 168 * time.Hour,
}

// pollEndedSQL is true once a poll has ended, early or by its end time (p is polls).
const pollEndedSQL = `(p.ended_at IS NOT NULL OR coalesce(p.ends_at <= now(), FALSE))`

type PollRequest struct {
	Question  string              `json:"question" minLength:"1" maxLength:"300"`
	Options   []PollOptionRequest `json:"options" minItems:"2" maxItems:"10"`
	Multi     bool                `json:"multi,omitempty" doc:"Voters may choose several answers"`
	Anonymous bool                `json:"anonymous,omitempty" doc:"Nobody can see who chose what"`
	Duration  string              `json:"duration,omitempty" enum:"1h,4h,8h,24h,3d,1w" doc:"Omit for a poll that runs until ended"`
}

type PollOptionRequest struct {
	Text  string `json:"text" minLength:"1" maxLength:"55"`
	Emoji string `json:"emoji,omitempty" maxLength:"64" doc:"A Unicode emoji or custom:<emoji id>"`
}

// Poll is a message's poll: counts for everyone, plus the asking user's own votes.
type Poll struct {
	Question    string       `json:"question"`
	Multi       bool         `json:"multi"`
	Anonymous   bool         `json:"anonymous"`
	EndsAt      *time.Time   `json:"ends_at,omitempty" doc:"When the poll closes by itself; absent when it runs until ended"`
	Ended       bool         `json:"ended" doc:"Ended early, or ends_at has passed"`
	Options     []PollOption `json:"options"`
	TotalVoters int          `json:"total_voters"`
	MyVotes     []int        `json:"my_votes" doc:"Positions the requesting user chose; always empty in gateway events"`
}

type PollOption struct {
	Text  string `json:"text"`
	Emoji string `json:"emoji,omitempty" doc:"A Unicode emoji or custom:<emoji id>"`
	Count int    `json:"count"`
}

func errPollNotEditable() *httpx.Error {
	return httpx.E(http.StatusConflict, "POLL_NOT_EDITABLE", "polls cannot be edited")
}

// checkPoll trims a poll request in place and validates it.
func (s *Service) checkPoll(ctx context.Context, p *PollRequest) error {
	invalid := func(msg string) error { return httpx.BadRequest("VALIDATION_FAILED", msg) }
	p.Question = strings.TrimSpace(p.Question)
	if n := utf8.RuneCountInString(p.Question); n < 1 || n > maxPollQuestion {
		return invalid("a poll question needs 1 to 300 characters")
	}
	if len(p.Options) < minPollOptions || len(p.Options) > maxPollOptions {
		return invalid("a poll needs 2 to 10 answers")
	}
	for i := range p.Options {
		o := &p.Options[i]
		o.Text = strings.TrimSpace(o.Text)
		if n := utf8.RuneCountInString(o.Text); n < 1 || n > maxPollOption {
			return invalid("each answer needs 1 to 55 characters")
		}
		if o.Emoji != "" {
			if err := s.checkEmoji(ctx, o.Emoji); err != nil {
				return err
			}
		}
	}
	if _, ok := pollDurations[p.Duration]; p.Duration != "" && !ok {
		return invalid("duration must be one of 1h, 4h, 8h, 24h, 3d and 1w")
	}
	return nil
}

// insertPoll stores the poll of a message being created.
func insertPoll(ctx context.Context, tx pgx.Tx, messageID id.ID, created time.Time, p *PollRequest) error {
	var endsAt *time.Time
	if d, ok := pollDurations[p.Duration]; ok {
		t := created.Add(d)
		endsAt = &t
	}
	if _, err := tx.Exec(ctx, `INSERT INTO polls (message_id, question, multi, anonymous, ends_at) VALUES ($1, $2, $3, $4, $5)`,
		messageID, p.Question, p.Multi, p.Anonymous, endsAt); err != nil {
		return err
	}
	for i, o := range p.Options {
		var emoji *string
		if o.Emoji != "" {
			emoji = &o.Emoji
		}
		if _, err := tx.Exec(ctx, `INSERT INTO poll_options (message_id, position, text, emoji) VALUES ($1, $2, $3, $4)`,
			messageID, i, o.Text, emoji); err != nil {
			return err
		}
	}
	return nil
}

// querier is a pool or a transaction.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

// loadPolls reads polls with their vote counts. MyVotes stays empty: it
// depends on who asks (withMyVotes), and events go to everyone.
func loadPolls(ctx context.Context, q querier, messageIDs []id.ID) (map[id.ID]*Poll, error) {
	out := map[id.ID]*Poll{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT p.message_id, p.question, p.multi, p.anonymous, p.ends_at, `+pollEndedSQL+`,
		       (SELECT count(DISTINCT v.user_id) FROM poll_votes v WHERE v.message_id = p.message_id)
		FROM polls p WHERE p.message_id = ANY($1)`, id.Int64s(messageIDs))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var mid id.ID
		p := &Poll{Options: []PollOption{}, MyVotes: []int{}}
		if err := rows.Scan(&mid, &p.Question, &p.Multi, &p.Anonymous, &p.EndsAt, &p.Ended, &p.TotalVoters); err != nil {
			rows.Close()
			return nil, err
		}
		out[mid] = p
	}
	rows.Close() // before the next query: a transaction runs one at a time
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return out, nil
	}
	rows, err = q.Query(ctx, `
		SELECT o.message_id, o.text, coalesce(o.emoji, ''), count(v.user_id)
		FROM poll_options o
		LEFT JOIN poll_votes v ON v.message_id = o.message_id AND v.position = o.position
		WHERE o.message_id = ANY($1)
		GROUP BY o.message_id, o.position ORDER BY o.message_id, o.position`, id.Int64s(messageIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var mid id.ID
		var o PollOption
		if err := rows.Scan(&mid, &o.Text, &o.Emoji, &o.Count); err != nil {
			return nil, err
		}
		if p := out[mid]; p != nil {
			p.Options = append(p.Options, o)
		}
	}
	return out, rows.Err()
}

// withPolls fills Poll for poll messages.
func (s *Service) withPolls(ctx context.Context, ms []Message) error {
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		if !m.Deleted {
			ids = append(ids, m.ID)
		}
	}
	polls, err := loadPolls(ctx, s.db, ids)
	if err != nil {
		return err
	}
	for i := range ms {
		ms[i].Poll = polls[ms[i].ID]
	}
	return nil
}
