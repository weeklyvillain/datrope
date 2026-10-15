// Package notes is personal notes: private rich-text notes only their owner sees (spec: personal notes).
package notes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

const (
	maxNotes     = 500
	maxTitle     = 100
	maxBytes     = 200 * 1024
	maxQuery     = 100
	previewRunes = 140
)

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// NoteSummary is a note in the list; it is also the NOTE_CREATE event.
type NoteSummary struct {
	ID        id.ID     `json:"id"`
	Title     string    `json:"title"`
	Preview   string    `json:"preview" doc:"The start of the note's text"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Note is a whole note; it is also the NOTE_UPDATE event.
type Note struct {
	ID        id.ID          `json:"id"`
	Title     string         `json:"title"`
	Content   map[string]any `json:"content" doc:"A Tiptap (ProseMirror) document"`
	Text      string         `json:"text" doc:"The plain text of content"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
}

// NoteDeleted is the NOTE_DELETE event.
type NoteDeleted struct {
	ID id.ID `json:"id"`
}

type NoteCreate struct {
	Title   *string        `json:"title,omitempty"`
	Content map[string]any `json:"content,omitempty" doc:"Sent together with text"`
	Text    *string        `json:"text,omitempty" doc:"Sent together with content"`
}

type NoteUpdate struct {
	Title   *string        `json:"title,omitempty"`
	Content map[string]any `json:"content,omitempty" doc:"Sent together with text"`
	Text    *string        `json:"text,omitempty" doc:"Sent together with content"`
}

type Service struct {
	db  *pgxpool.Pool
	bus *events.Bus
}

func NewService(pool *pgxpool.Pool, bus *events.Bus) *Service {
	return &Service{db: pool, bus: bus}
}

var emptyDoc = []byte(`{"type":"doc","content":[{"type":"paragraph"}]}`)

// fields is a validated create or update body; nil means "not sent".
type fields struct {
	title   *string
	content []byte
	text    *string
}

func validate(title *string, content map[string]any, text *string) (fields, error) {
	var f fields
	if title != nil {
		t := strings.TrimSpace(*title)
		if utf8.RuneCountInString(t) > maxTitle {
			return f, httpx.BadRequest("NOTE_TITLE_TOO_LONG", fmt.Sprintf("a title has at most %d characters", maxTitle))
		}
		f.title = &t
	}
	if (content == nil) != (text == nil) {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content and text are sent together")
	}
	if content == nil {
		return f, nil
	}
	if content["type"] != "doc" {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content must be a document")
	}
	b, err := json.Marshal(content)
	if err != nil {
		return f, httpx.BadRequest("NOTE_INVALID_CONTENT", "content must be a document")
	}
	if len(b) > maxBytes || len(*text) > maxBytes {
		return f, httpx.BadRequest("NOTE_TOO_LARGE", "the note is too long")
	}
	f.content, f.text = b, text
	return f, nil
}

func preview(text string) string {
	s := strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(s) <= previewRunes {
		return s
	}
	return string([]rune(s)[:previewRunes])
}

func (s *Service) list(ctx context.Context, userID id.ID, q string) ([]NoteSummary, error) {
	q = strings.TrimSpace(q)
	if utf8.RuneCountInString(q) > maxQuery {
		q = string([]rune(q)[:maxQuery])
	}
	rows, err := s.db.Query(ctx, `SELECT id, title, text, updated_at FROM notes
		WHERE user_id = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR text ILIKE '%' || $2 || '%')
		ORDER BY updated_at DESC, id DESC`, userID, likeEscaper.Replace(q))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NoteSummary{}
	for rows.Next() {
		var n NoteSummary
		var text string
		if err := rows.Scan(&n.ID, &n.Title, &text, &n.UpdatedAt); err != nil {
			return nil, err
		}
		n.Preview = preview(text)
		out = append(out, n)
	}
	return out, rows.Err()
}

func (s *Service) get(ctx context.Context, userID, noteID id.ID) (*Note, error) {
	var n Note
	var content []byte
	err := s.db.QueryRow(ctx, `SELECT id, title, content, text, updated_at FROM notes WHERE id = $1 AND user_id = $2`, noteID, userID).
		Scan(&n.ID, &n.Title, &content, &n.Text, &n.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("note")
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(content, &n.Content); err != nil {
		return nil, err
	}
	n.CreatedAt = n.ID.Time()
	return &n, nil
}

func (s *Service) create(ctx context.Context, userID id.ID, in NoteCreate) (*Note, error) {
	f, err := validate(in.Title, in.Content, in.Text)
	if err != nil {
		return nil, err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM notes WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= maxNotes {
		return nil, httpx.BadRequest("NOTE_LIMIT", fmt.Sprintf("you have the most notes you can have (%d)", maxNotes))
	}
	title, content, text := "", emptyDoc, ""
	if f.title != nil {
		title = *f.title
	}
	if f.content != nil {
		content, text = f.content, *f.text
	}
	nid := id.New()
	if _, err := s.db.Exec(ctx, `INSERT INTO notes (id, user_id, title, content, text) VALUES ($1, $2, $3, $4, $5)`,
		nid, userID, title, content, text); err != nil {
		return nil, err
	}
	n, err := s.get(ctx, userID, nid)
	if err != nil {
		return nil, err
	}
	s.publish(userID, "NOTE_CREATE", NoteSummary{ID: n.ID, Title: n.Title, Preview: preview(n.Text), UpdatedAt: n.UpdatedAt})
	return n, nil
}

func (s *Service) update(ctx context.Context, userID, noteID id.ID, in NoteUpdate) (*Note, error) {
	f, err := validate(in.Title, in.Content, in.Text)
	if err != nil {
		return nil, err
	}
	if f.title == nil && f.content == nil {
		return s.get(ctx, userID, noteID) // nothing to change: no bump, no event
	}
	tag, err := s.db.Exec(ctx, `UPDATE notes SET title = coalesce($3, title), content = coalesce($4::jsonb, content),
		text = coalesce($5, text), updated_at = now() WHERE id = $1 AND user_id = $2`, noteID, userID, f.title, f.content, f.text)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, httpx.NotFound("note")
	}
	n, err := s.get(ctx, userID, noteID)
	if err != nil {
		return nil, err
	}
	s.publish(userID, "NOTE_UPDATE", n)
	return n, nil
}

func (s *Service) delete(ctx context.Context, userID, noteID id.ID) error {
	tag, err := s.db.Exec(ctx, `DELETE FROM notes WHERE id = $1 AND user_id = $2`, noteID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("note")
	}
	s.publish(userID, "NOTE_DELETE", NoteDeleted{ID: noteID})
	return nil
}

// publish reaches every session of the owner, so their other devices stay current.
func (s *Service) publish(userID id.ID, typ string, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{UserIDs: []id.ID{userID}}})
}
