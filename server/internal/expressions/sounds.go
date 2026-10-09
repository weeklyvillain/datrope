package expressions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	MaxSounds        = 100
	MaxSoundBytes    = 512 << 10
	MaxSoundDuration = 5 * time.Second
)

var errSoundNotFound = errors.New("sound not found")

type Sound struct {
	ID         id.ID  `json:"id"`
	Name       string `json:"name"`
	Emoji      string `json:"emoji" doc:"One Unicode emoji"`
	DurationMs int    `json:"duration_ms" doc:"Length measured by the server from the file"`
	URL        string `json:"url" doc:"Public audio URL"`
	CreatorID  *id.ID `json:"creator_id,omitempty"`
}

type SoundUpdate struct {
	Sounds []Sound `json:"sounds" doc:"Every soundboard sound on the server"`
}

type SoundPatch struct {
	Name  *string `json:"name,omitempty" doc:"1 to 32 characters"`
	Emoji *string `json:"emoji,omitempty" doc:"One Unicode emoji"`
}

func errSoundTooLarge() *httpx.Error {
	return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "sounds can be at most 512 KB")
}

func errInvalidEmoji() *httpx.Error {
	return httpx.BadRequest("INVALID_EMOJI", "pick one Unicode emoji")
}

// soundName trims a name and checks its length (1 to 32 characters).
func soundName(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > 32 {
		return "", httpx.BadRequest("VALIDATION_FAILED", "sound names are 1 to 32 characters")
	}
	return s, nil
}

const soundColumns = `id, name, emoji, duration_ms, creator_id`

func scanSound(row pgx.Row, extra ...any) (*Sound, error) {
	var snd Sound
	var creator *int64
	if err := row.Scan(append([]any{&snd.ID, &snd.Name, &snd.Emoji, &snd.DurationMs, &creator}, extra...)...); err != nil {
		return nil, err
	}
	snd.CreatorID = id.FromNullable(creator)
	snd.URL = "/api/sounds/" + snd.ID.String()
	return &snd, nil
}

func (s *Service) Sounds(ctx context.Context) ([]Sound, error) {
	rows, err := s.db.Query(ctx, `SELECT `+soundColumns+` FROM sounds ORDER BY lower(name), id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sound{}
	for rows.Next() {
		snd, err := scanSound(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *snd)
	}
	return out, rows.Err()
}

func (s *Service) SoundExists(ctx context.Context, soundID id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM sounds WHERE id = $1)`, soundID).Scan(&ok)
	return ok, err
}

func (s *Service) getSound(ctx context.Context, soundID id.ID) (*Sound, string, string, error) {
	var sum, ct string
	snd, err := scanSound(s.db.QueryRow(ctx, `SELECT `+soundColumns+`, sha256, content_type FROM sounds WHERE id = $1`, soundID), &sum, &ct)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", "", errSoundNotFound
	}
	if err != nil {
		return nil, "", "", err
	}
	return snd, sum, ct, nil
}

// publishSounds sends SOUND_UPDATE with the full list; a failure is logged.
func (s *Service) publishSounds(ctx context.Context) {
	list, err := s.Sounds(ctx)
	if err == nil {
		var sid id.ID
		if sid, err = s.server.ServerID(ctx); err == nil {
			s.bus.Publish(events.Event{Type: "SOUND_UPDATE", Data: SoundUpdate{Sounds: list}, Scope: events.Scope{CommunityID: sid}})
			return
		}
	}
	slog.WarnContext(ctx, "expressions: publishing SOUND_UPDATE", "err", err)
}

func registerSounds(api huma.API, s *Service, op func(oid, method, path string, status int) huma.Operation) {
	huma.Register(api, op("list-sounds", http.MethodGet, "/api/server/sounds", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Sound }, error) {
			if err := s.requireMember(ctx); err != nil {
				return nil, err
			}
			list, err := s.Sounds(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body []Sound }{list}, nil
		})

	huma.Register(api, op("update-sound", http.MethodPatch, "/api/server/sounds/{soundID}", 0),
		func(ctx context.Context, in *struct {
			SoundID string `path:"soundID"`
			Body    SoundPatch
		}) (*struct{ Body *Sound }, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			sid, err := httpx.ParseID(in.SoundID, "sound")
			if err != nil {
				return nil, err
			}
			var name *string
			if in.Body.Name != nil {
				n, err := soundName(*in.Body.Name)
				if err != nil {
					return nil, err
				}
				name = &n
			}
			if in.Body.Emoji != nil && !messages.ValidUnicodeEmoji(*in.Body.Emoji) {
				return nil, errInvalidEmoji()
			}
			changed := name != nil || in.Body.Emoji != nil
			if changed {
				tag, err := s.db.Exec(ctx, `UPDATE sounds SET name = coalesce($2, name), emoji = coalesce($3, emoji) WHERE id = $1`,
					sid, name, in.Body.Emoji)
				if err != nil {
					return nil, err
				}
				if tag.RowsAffected() == 0 {
					return nil, httpx.NotFound("sound")
				}
			}
			snd, _, _, err := s.getSound(ctx, sid)
			if errors.Is(err, errSoundNotFound) {
				return nil, httpx.NotFound("sound")
			}
			if err != nil {
				return nil, err
			}
			if changed {
				s.publishSounds(ctx)
			}
			return &struct{ Body *Sound }{snd}, nil
		})

	huma.Register(api, op("delete-sound", http.MethodDelete, "/api/server/sounds/{soundID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			SoundID string `path:"soundID"`
		}) (*struct{}, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			sid, err := httpx.ParseID(in.SoundID, "sound")
			if err != nil {
				return nil, err
			}
			var sum string
			if err := s.db.QueryRow(ctx, `DELETE FROM sounds WHERE id = $1 RETURNING sha256`, sid).Scan(&sum); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, httpx.NotFound("sound")
				}
				return nil, err
			}
			if err := s.blobs.RemoveBlobs(ctx, []string{sum}); err != nil {
				slog.WarnContext(ctx, "expressions: removing a sound blob; the sweep will retry", "err", err)
			}
			s.publishSounds(ctx)
			return nil, nil
		})
}

// UploadSoundHandler serves POST /api/server/sounds (multipart: name, emoji,
// file). It must run behind auth.RequireHTTP.
func (s *Service) UploadSoundHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		snd, err := s.uploadSound(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, snd)
	})
}

func (s *Service) uploadSound(w http.ResponseWriter, r *http.Request) (*Sound, error) {
	ctx := r.Context()
	if err := s.require(ctx, perms.ManageExpressions); err != nil {
		return nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxSoundBytes+64<<10)
	if err := r.ParseMultipartForm(MaxSoundBytes + 64<<10); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, errSoundTooLarge()
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	name, err := soundName(r.FormValue("name"))
	if err != nil {
		return nil, err
	}
	emoji := r.FormValue("emoji")
	if !messages.ValidUnicodeEmoji(emoji) {
		return nil, errInvalidEmoji()
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > MaxSoundBytes {
		return nil, errSoundTooLarge()
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxSoundBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxSoundBytes {
		return nil, errSoundTooLarge()
	}
	ct, d, err := audioInfo(data)
	if err != nil || d <= 0 {
		return nil, httpx.BadRequest("NOT_AUDIO", "upload an OGG, MP3 or WAV file")
	}
	if d > MaxSoundDuration {
		return nil, httpx.BadRequest("TOO_LONG", "sounds can be at most 5 seconds")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// One upload at a time, so the count check holds.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('sounds', 0))`); err != nil {
		return nil, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM sounds`).Scan(&count); err != nil {
		return nil, err
	}
	if count >= MaxSounds {
		return nil, httpx.BadRequest("SOUND_LIMIT", fmt.Sprintf("this server already has %d sounds", MaxSounds))
	}
	sum, err := s.blobs.StoreBlob(ctx, tx, data)
	if err != nil {
		return nil, err
	}
	sid := id.New()
	if _, err := tx.Exec(ctx, `INSERT INTO sounds (id, name, emoji, sha256, content_type, duration_ms, creator_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		sid, name, emoji, sum, ct, int(d.Milliseconds()), auth.Current(ctx).User.ID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	s.publishSounds(ctx)
	snd, _, _, err := s.getSound(ctx, sid)
	return snd, err
}

// SoundFileHandler serves GET /api/sounds/{id} without a session.
func (s *Service) SoundFileHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sid, err := httpx.ParseID(r.PathValue("id"), "sound")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		_, sum, ct, err := s.getSound(r.Context(), sid)
		if errors.Is(err, errSoundNotFound) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("sound"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		s.blobs.ServeBlob(w, r, sum, ct, true) // the file behind a sound ID never changes
	})
}
