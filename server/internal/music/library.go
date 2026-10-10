package music

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Community is what the library needs from communities: membership and permissions.
type Community interface {
	ServerID(ctx context.Context) (id.ID, error)
	PermMember(ctx context.Context, communityID, userID id.ID) (communities.PermMember, error)
}

func (s *Service) SetCommunity(c Community) { s.community = c }

// LibraryTrack is an uploaded track anyone in the server can queue.
type LibraryTrack struct {
	ID         id.ID     `json:"id"`
	Title      string    `json:"title"`
	Duration   int       `json:"duration" doc:"Seconds; 0 when unknown"`
	UploadedBy *id.ID    `json:"uploaded_by,omitempty"`
	CreatedAt  time.Time `json:"created_at"`

	sum string
}

const (
	maxTrackBytes  = 30 << 20
	maxLibrarySize = 500
)

// member returns the caller's base permissions in the server.
func (s *Service) member(ctx context.Context) (perms.Perms, error) {
	sid, err := s.community.ServerID(ctx)
	if err != nil {
		return 0, httpx.MissingPermission()
	}
	m, err := s.community.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, communities.ErrNotMember) || (err == nil && m.Gated) {
		return 0, httpx.MissingPermission()
	}
	if err != nil {
		return 0, err
	}
	return perms.Base(m.Perms), nil
}

const libraryCols = `id, title, duration, uploaded_by, sha256`

func scanLibrary(row pgx.Row) (LibraryTrack, error) {
	var t LibraryTrack
	var by *int64
	err := row.Scan(&t.ID, &t.Title, &t.Duration, &by, &t.sum)
	t.UploadedBy = id.FromNullable(by)
	t.CreatedAt = t.ID.Time()
	return t, err
}

func (s *Service) libraryTrack(ctx context.Context, trackID id.ID) (LibraryTrack, error) {
	t, err := scanLibrary(s.db.QueryRow(ctx, `SELECT `+libraryCols+` FROM music_tracks WHERE id = $1`, trackID))
	if errors.Is(err, pgx.ErrNoRows) {
		return t, httpx.NotFound("track")
	}
	return t, err
}

var durationRe = regexp.MustCompile(`Duration: (\d+):(\d\d):(\d\d)`)

// probe checks ffmpeg can decode data as audio and reads its length.
func (s *Service) probe(ctx context.Context, data []byte) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// A file, not a pipe: ffmpeg can only measure many formats when it can seek.
	f, err := os.CreateTemp("", "datrope-track-*")
	if err != nil {
		return 0, err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, err
	}
	cmd := exec.CommandContext(ctx, s.ffmpeg, "-hide_banner", "-nostdin", "-i", f.Name(), "-map", "0:a:0", "-t", "1", "-f", "null", "-")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return 0, httpx.BadRequest("NOT_AUDIO", "upload an audio file (MP3, Ogg, Opus, FLAC, WAV, M4A …)")
	}
	m := durationRe.FindStringSubmatch(stderr.String())
	if m == nil {
		return 0, nil // a stream with no known length
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	sec, _ := strconv.Atoi(m[3])
	return h*3600 + mi*60 + sec, nil
}

// UploadHandler serves POST /api/server/music (multipart "file" and an
// optional "title"); it must run behind RequireHTTP.
func (s *Service) UploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t, err := s.upload(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, t)
	})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) (*LibraryTrack, error) {
	ctx := r.Context()
	if s.ffmpeg == "" {
		return nil, unavailable("the music bot is not set up on this server (it needs ffmpeg)")
	}
	p, err := s.member(ctx)
	if err != nil {
		return nil, err
	}
	if !p.Has(perms.AttachFiles) {
		return nil, httpx.MissingPermission()
	}
	tooLarge := httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "tracks can be at most 30 MB")
	limit := int64(maxTrackBytes) + 64<<10
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, tooLarge
		}
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()
	f, hdr, err := r.FormFile("file")
	if err != nil {
		return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxTrackBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxTrackBytes {
		return nil, tooLarge
	}
	title := strings.TrimSpace(r.FormValue("title"))
	if title == "" {
		title = strings.TrimSpace(strings.TrimSuffix(hdr.Filename, extOf(hdr.Filename)))
	}
	if title == "" {
		title = "Untitled"
	}
	if utf8.RuneCountInString(title) > 100 {
		title = string([]rune(title)[:100])
	}
	dur, err := s.probe(ctx, data)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM music_tracks`).Scan(&n); err != nil {
		return nil, err
	}
	if n >= maxLibrarySize {
		return nil, httpx.BadRequest("LIBRARY_FULL", "the music library is full (500 tracks)")
	}
	sum, err := s.blobs.StoreBlob(ctx, tx, data)
	if err != nil {
		return nil, err
	}
	me := auth.Current(ctx).User.ID
	t, err := scanLibrary(tx.QueryRow(ctx, `INSERT INTO music_tracks (id, title, duration, uploaded_by, sha256) VALUES ($1, $2, $3, $4, $5)
		RETURNING `+libraryCols, id.New(), title, dur, me, sum))
	if err != nil {
		return nil, err
	}
	return &t, tx.Commit(ctx)
}

func extOf(name string) string {
	if i := strings.LastIndexByte(name, '.'); i > 0 {
		return name[i:]
	}
	return ""
}

func registerLibrary(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-music-library", http.MethodGet, "/api/server/music", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []LibraryTrack }, error) {
			if _, err := s.member(ctx); err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+libraryCols+` FROM music_tracks ORDER BY lower(title), id`)
			if err != nil {
				return nil, err
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (LibraryTrack, error) { return scanLibrary(r) })
			if list == nil {
				list = []LibraryTrack{}
			}
			return &struct{ Body []LibraryTrack }{list}, err
		})

	huma.Register(api, op("delete-music-track", http.MethodDelete, "/api/server/music/{trackID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			TrackID string `path:"trackID"`
		}) (*struct{}, error) {
			p, err := s.member(ctx)
			if err != nil {
				return nil, err
			}
			tid, err := httpx.ParseID(in.TrackID, "track")
			if err != nil {
				return nil, err
			}
			t, err := s.libraryTrack(ctx, tid)
			if err != nil {
				return nil, err
			}
			mine := t.UploadedBy != nil && *t.UploadedBy == auth.Current(ctx).User.ID
			if !mine && !p.Has(perms.ManageExpressions) {
				return nil, httpx.MissingPermission()
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM music_tracks WHERE id = $1`, tid); err != nil {
				return nil, err
			}
			_ = s.blobs.RemoveBlobs(ctx, []string{t.sum}) // the sweep retries; if it is queued, it is skipped when its turn comes
			return nil, nil
		})
}
