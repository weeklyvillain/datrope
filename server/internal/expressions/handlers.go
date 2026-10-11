package expressions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type RenameRequest struct {
	Name string `json:"name" pattern:"^[A-Za-z0-9_]{2,32}$"`
}

type emojiPath struct {
	EmojiID string `path:"emojiID"`
}

func errNotAMember() *httpx.Error {
	return httpx.E(http.StatusForbidden, "NOT_A_MEMBER", "you are not a member of this server; ask for an invite")
}

func errInvalidName() *httpx.Error {
	return httpx.BadRequest("INVALID_NAME", "names use letters, digits and _ (2 to 32 characters)")
}

func errNameTaken() *httpx.Error {
	return httpx.E(http.StatusConflict, "NAME_TAKEN", "another emoji already has that name")
}

func errTooLarge() *httpx.Error {
	return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "emoji can be at most 256 KB")
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// requireMember allows any member, including one held at the rules gate.
func (s *Service) requireMember(ctx context.Context) error {
	sid, err := s.server.ServerID(ctx)
	if errors.Is(err, communities.ErrNotFound) {
		return errNotAMember()
	}
	if err != nil {
		return err
	}
	_, err = s.server.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, communities.ErrNotMember) {
		return errNotAMember()
	}
	return err
}

// require checks a server-wide permission; gated members hold none.
func (s *Service) require(ctx context.Context, need perms.Perms) error {
	p, err := s.server.BasePerms(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return err
	}
	if p == 0 {
		return errNotAMember()
	}
	if !p.Has(need) {
		return httpx.MissingPermission()
	}
	return nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"expressions"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("list-emoji", http.MethodGet, "/api/server/emoji", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Emoji }, error) {
			if err := s.requireMember(ctx); err != nil {
				return nil, err
			}
			list, err := s.List(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body []Emoji }{list}, nil
		})

	huma.Register(api, op("rename-emoji", http.MethodPatch, "/api/server/emoji/{emojiID}", 0),
		func(ctx context.Context, in *struct {
			EmojiID string `path:"emojiID"`
			Body    RenameRequest
		}) (*struct{ Body *Emoji }, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			eid, err := httpx.ParseID(in.EmojiID, "emoji")
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `UPDATE emoji SET name = $2 WHERE id = $1`, eid, in.Body.Name)
			if isUniqueViolation(err) {
				return nil, errNameTaken()
			}
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("emoji")
			}
			e, _, _, err := s.get(ctx, eid)
			if errors.Is(err, errNotFound) {
				return nil, httpx.NotFound("emoji")
			}
			if err != nil {
				return nil, err
			}
			if err := s.publish(ctx); err != nil {
				slog.WarnContext(ctx, "expressions: publishing EMOJI_UPDATE", "err", err)
			}
			return &struct{ Body *Emoji }{e}, nil
		})

	huma.Register(api, op("delete-emoji", http.MethodDelete, "/api/server/emoji/{emojiID}", http.StatusNoContent),
		func(ctx context.Context, in *emojiPath) (*struct{}, error) {
			if err := s.require(ctx, perms.ManageExpressions); err != nil {
				return nil, err
			}
			eid, err := httpx.ParseID(in.EmojiID, "emoji")
			if err != nil {
				return nil, err
			}
			var sum string
			if err := s.db.QueryRow(ctx, `DELETE FROM emoji WHERE id = $1 RETURNING sha256`, eid).Scan(&sum); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return nil, httpx.NotFound("emoji")
				}
				return nil, err
			}
			if err := s.reactions.RemoveReactions(ctx, "custom:"+eid.String()); err != nil {
				return nil, err
			}
			if err := s.blobs.RemoveBlobs(ctx, []string{sum}); err != nil {
				slog.WarnContext(ctx, "expressions: removing an emoji blob; the sweep will retry", "err", err)
			}
			if err := s.publish(ctx); err != nil {
				slog.WarnContext(ctx, "expressions: publishing EMOJI_UPDATE", "err", err)
			}
			return nil, nil
		})

	huma.Register(api, op("search-7tv-emotes", http.MethodGet, "/api/server/emoji/7tv/search", 0),
		func(ctx context.Context, in *struct {
			Q    string `query:"q" maxLength:"100" doc:"Words in the emote's name"`
			Page int    `query:"page" minimum:"1" maximum:"50" default:"1"`
		}) (*struct{ Body *SevenTVPage }, error) {
			if err := s.requireSevenTV(ctx); err != nil {
				return nil, err
			}
			p, err := s.searchSevenTV(ctx, strings.TrimSpace(in.Q), in.Page)
			if err != nil {
				return nil, err
			}
			return &struct{ Body *SevenTVPage }{p}, nil
		})

	huma.Register(api, op("get-7tv-emote-set", http.MethodGet, "/api/server/emoji/7tv/sets/{setID}", 0),
		func(ctx context.Context, in *struct {
			SetID string `path:"setID" doc:"A 7TV emote set ID"`
		}) (*struct{ Body *SevenTVSet }, error) {
			if err := s.requireSevenTV(ctx); err != nil {
				return nil, err
			}
			set, err := s.sevenTVSet(ctx, in.SetID)
			if err != nil {
				return nil, err
			}
			return &struct{ Body *SevenTVSet }{set}, nil
		})

	huma.Register(api, op("import-7tv-emote", http.MethodPost, "/api/server/emoji/7tv", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body ImportSevenTVRequest }) (*struct{ Body *Emoji }, error) {
			if err := s.requireSevenTV(ctx); err != nil {
				return nil, err
			}
			e, err := s.importSevenTV(ctx, in.Body.EmoteID, in.Body.Name)
			if err != nil {
				return nil, err
			}
			return &struct{ Body *Emoji }{e}, nil
		})

	registerSounds(api, s, op)
}

// requireSevenTV allows MANAGE_EXPRESSIONS, within the 7TV rate limit.
func (s *Service) requireSevenTV(ctx context.Context) error {
	if err := s.require(ctx, perms.ManageExpressions); err != nil {
		return err
	}
	if !s.sevenTVLimit.Allow(auth.Current(ctx).User.ID.String()) {
		return httpx.RateLimited()
	}
	return nil
}

// UploadHandler serves POST /api/server/emoji (multipart: name, file). It
// must run behind auth.RequireHTTP.
func (s *Service) UploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e, err := s.upload(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, e)
	})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) (*Emoji, error) {
	ctx := r.Context()
	if err := s.require(ctx, perms.ManageExpressions); err != nil {
		return nil, err
	}
	r.Body = http.MaxBytesReader(w, r.Body, MaxEmojiBytes+64<<10)
	if err := r.ParseMultipartForm(MaxEmojiBytes + 64<<10); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, errTooLarge()
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	name := strings.TrimSpace(r.FormValue("name"))
	if !nameRe.MatchString(name) {
		return nil, errInvalidName()
	}
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	if hdr.Size > MaxEmojiBytes {
		return nil, errTooLarge()
	}
	data, err := io.ReadAll(io.LimitReader(f, MaxEmojiBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxEmojiBytes {
		return nil, errTooLarge()
	}
	return s.insert(ctx, name, data)
}

// insert stores an image of at most MaxEmojiBytes as a new emoji named name.
func (s *Service) insert(ctx context.Context, name string, data []byte) (*Emoji, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// One upload at a time, so the count check holds.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('emoji', 0))`); err != nil {
		return nil, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM emoji`).Scan(&count); err != nil {
		return nil, err
	}
	if count >= MaxEmoji {
		return nil, httpx.BadRequest("EMOJI_LIMIT", fmt.Sprintf("this server already has %d emoji", MaxEmoji))
	}
	// A refused JPEG leaves a committed blob with no row; the hourly sweep collects it.
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data)
	if err != nil {
		return nil, err
	}
	if ct == "image/jpeg" {
		return nil, httpx.BadRequest("NOT_AN_IMAGE", "emoji must be PNG, GIF or WebP")
	}
	eid := id.New()
	me := auth.Current(ctx).User.ID
	if _, err := tx.Exec(ctx, `INSERT INTO emoji (id, name, sha256, content_type, creator_id) VALUES ($1, $2, $3, $4, $5)`,
		eid, name, sum, ct, me); err != nil {
		if isUniqueViolation(err) {
			return nil, errNameTaken()
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if err := s.publish(ctx); err != nil {
		slog.WarnContext(ctx, "expressions: publishing EMOJI_UPDATE", "err", err)
	}
	e, _, _, err := s.get(ctx, eid)
	return e, err
}

// ImageHandler serves GET /api/emoji/{id} without a session.
func (s *Service) ImageHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		eid, err := httpx.ParseID(r.PathValue("id"), "emoji")
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		_, sum, ct, err := s.get(r.Context(), eid)
		if errors.Is(err, errNotFound) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("emoji"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		s.blobs.ServeBlob(w, r, sum, ct, true) // the image behind an emoji ID never changes
	})
}
