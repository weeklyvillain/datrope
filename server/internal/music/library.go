package music

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
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
	Artist     string    `json:"artist,omitempty"`
	Duration   int       `json:"duration" doc:"Seconds; 0 when unknown"`
	Cover      string    `json:"cover,omitempty" doc:"The cover image's path, from the file's tags"`
	Size       int64     `json:"size" doc:"Bytes stored"`
	UploadedBy *id.ID    `json:"uploaded_by,omitempty"`
	CreatedAt  time.Time `json:"created_at"`

	sum      string
	format   string // "opus" (stored as the bot plays it) or "original"
	coverSum string
}

// Library is the server's uploaded tracks and how much room they take.
type Library struct {
	Tracks     []LibraryTrack `json:"tracks"`
	UsedBytes  int64          `json:"used_bytes"`
	LimitBytes int64          `json:"limit_bytes"`
}

const (
	maxUploadBytes = 100 << 20 // what may be uploaded; it is stored as Opus, much smaller
	maxStoredBytes = 60 << 20  // the Opus result: about 60 minutes
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

const libraryCols = `id, title, artist, duration, uploaded_by, sha256, format, size, coalesce(cover, '')`

func scanLibrary(row pgx.Row) (LibraryTrack, error) {
	var t LibraryTrack
	var by *int64
	err := row.Scan(&t.ID, &t.Title, &t.Artist, &t.Duration, &by, &t.sum, &t.format, &t.Size, &t.coverSum)
	t.UploadedBy = id.FromNullable(by)
	t.CreatedAt = t.ID.Time()
	t.Cover = coverPath(t.coverSum)
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

// ffmpegRun runs ffmpeg on a file and returns its stdout (at most limit bytes) and stderr.
func (s *Service) ffmpegRun(ctx context.Context, limit int64, args ...string) ([]byte, string, error) {
	cmd := exec.CommandContext(ctx, s.ffmpeg, append([]string{"-hide_banner", "-nostdin"}, args...)...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{w: &stdout, left: limit}
	cmd.Stderr = &stderr
	err := cmd.Run()
	if lw := cmd.Stdout.(*limitedWriter); lw.over {
		return nil, stderr.String(), errTooLong
	}
	return stdout.Bytes(), stderr.String(), err
}

var errTooLong = errors.New("music: output too large")

type limitedWriter struct {
	w    io.Writer
	left int64
	over bool
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > l.left {
		l.over = true
		return 0, errTooLong
	}
	l.left -= int64(len(p))
	return l.w.Write(p)
}

// probe checks ffmpeg can decode the file as audio and reads its length.
func (s *Service) probe(ctx context.Context, path string) (int, error) {
	_, stderr, err := s.ffmpegRun(ctx, 0, "-i", path, "-map", "0:a:0", "-t", "1", "-f", "null", "-")
	if err != nil {
		return 0, httpx.BadRequest("NOT_AUDIO", "upload an audio file (MP3, Ogg, Opus, FLAC, WAV, M4A …)")
	}
	m := durationRe.FindStringSubmatch(stderr)
	if m == nil {
		return 0, nil // a stream with no known length
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	sec, _ := strconv.Atoi(m[3])
	return h*3600 + mi*60 + sec, nil
}

// tags reads a file's title and artist tags.
func (s *Service) tags(ctx context.Context, path string) (title, artist string) {
	out, _, err := s.ffmpegRun(ctx, 1<<20, "-loglevel", "error", "-i", path, "-f", "ffmetadata", "pipe:1")
	if err != nil {
		return "", ""
	}
	return parseTags(out)
}

// parseTags reads title and artist from ffmpeg's ffmetadata output.
func parseTags(out []byte) (title, artist string) {
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "[") { // a stream's or chapter's section: the file's own tags came first
			break
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(k, ";") {
			continue
		}
		v = strings.TrimSpace(strings.ReplaceAll(v, `\`, ""))
		switch strings.ToLower(k) {
		case "title":
			title = v
		case "artist":
			artist = v
		case "album_artist":
			if artist == "" {
				artist = v
			}
		}
	}
	return clip(title, 100), clip(artist, 100)
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		s = string([]rune(s)[:n])
	}
	return s
}

// coverArt extracts a file's embedded cover picture as PNG, if it has one.
func (s *Service) coverArt(ctx context.Context, path string) []byte {
	out, _, err := s.ffmpegRun(ctx, 10<<20, "-loglevel", "error", "-i", path, "-map", "0:v:0", "-frames:v", "1",
		"-vf", "scale='min(512,iw)':-2", "-c:v", "png", "-f", "image2pipe", "pipe:1")
	if err != nil || len(out) == 0 {
		return nil
	}
	return out
}

// transcode turns the file into what the bot sends (Ogg Opus), so playing
// it later needs no ffmpeg.
func (s *Service) transcode(ctx context.Context, path string) ([]byte, error) {
	out, stderr, err := s.ffmpegRun(ctx, maxStoredBytes, append(append([]string{"-loglevel", "error", "-i", path, "-map", "0:a:0"}, opusArgs...), "pipe:1")...)
	if errors.Is(err, errTooLong) {
		return nil, httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "tracks can be at most about an hour long")
	}
	if err != nil {
		return nil, fmt.Errorf("transcoding: %w: %s", err, strings.TrimSpace(stderr))
	}
	return out, nil
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
	tooLarge := httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "tracks can be at most 100 MB")
	r.Body = http.MaxBytesReader(w, r.Body, int64(maxUploadBytes)+64<<10)
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
	// A file, not a pipe: ffmpeg can only measure many formats when it can seek.
	tmp, err := os.CreateTemp("", "datrope-track-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp.Name())
	n, err := io.Copy(tmp, io.LimitReader(f, maxUploadBytes+1))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if n > maxUploadBytes {
		return nil, tooLarge
	}

	work, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	dur, err := s.probe(work, tmp.Name())
	if err != nil {
		return nil, err
	}
	tagTitle, artist := s.tags(work, tmp.Name())
	title := clip(r.FormValue("title"), 100)
	if title == "" {
		title = tagTitle
	}
	if title == "" {
		title = clip(strings.TrimSuffix(hdr.Filename, extOf(hdr.Filename)), 100)
	}
	if title == "" {
		title = "Untitled"
	}
	cover := s.coverArt(work, tmp.Name())
	opus, err := s.transcode(work, tmp.Name())
	if err != nil {
		return nil, err
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var count int
	var used int64
	if err := tx.QueryRow(ctx, `SELECT count(*), coalesce(sum(size), 0) FROM music_tracks`).Scan(&count, &used); err != nil {
		return nil, err
	}
	if count >= maxLibrarySize {
		return nil, httpx.BadRequest("LIBRARY_FULL", fmt.Sprintf("the music library is full (%d tracks)", maxLibrarySize))
	}
	if used+int64(len(opus)) > s.library {
		return nil, httpx.BadRequest("LIBRARY_FULL", fmt.Sprintf("the music library is full (%d of %d MB used)", used>>20, s.library>>20))
	}
	sum, err := s.blobs.StoreBlob(ctx, tx, opus)
	if err != nil {
		return nil, err
	}
	var coverSum, coverType *string
	if cover != nil {
		if cs, ct, err := s.blobs.StoreImageBlob(ctx, tx, cover); err == nil {
			coverSum, coverType = &cs, &ct
		}
	}
	me := auth.Current(ctx).User.ID
	t, err := scanLibrary(tx.QueryRow(ctx, `INSERT INTO music_tracks (id, title, artist, duration, uploaded_by, sha256, format, size, cover, cover_type)
		VALUES ($1, $2, $3, $4, $5, $6, 'opus', $7, $8, $9) RETURNING `+libraryCols,
		id.New(), title, artist, dur, me, sum, len(opus), coverSum, coverType))
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
		func(ctx context.Context, _ *struct{}) (*struct{ Body Library }, error) {
			if _, err := s.member(ctx); err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+libraryCols+` FROM music_tracks ORDER BY lower(title), id`)
			if err != nil {
				return nil, err
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (LibraryTrack, error) { return scanLibrary(r) })
			if err != nil {
				return nil, err
			}
			lib := Library{Tracks: list, LimitBytes: s.library}
			if lib.Tracks == nil {
				lib.Tracks = []LibraryTrack{}
			}
			for _, t := range list {
				lib.UsedBytes += t.Size
			}
			return &struct{ Body Library }{lib}, nil
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
			// Playlists holding it lose the track (cascade); tell their viewers.
			rows, err := s.db.Query(ctx, `SELECT DISTINCT playlist_id FROM music_playlist_items WHERE track_id = $1`, tid)
			if err != nil {
				return nil, err
			}
			affected, err := pgx.CollectRows(rows, pgx.RowTo[id.ID])
			if err != nil {
				return nil, err
			}
			if _, err := s.db.Exec(ctx, `DELETE FROM music_tracks WHERE id = $1`, tid); err != nil {
				return nil, err
			}
			sums := []string{t.sum}
			if t.coverSum != "" {
				sums = append(sums, t.coverSum)
			}
			_ = s.blobs.RemoveBlobs(ctx, sums) // the sweep retries; if it is queued, it is skipped when its turn comes
			for _, pid := range affected {
				s.renumber(ctx, pid)
				s.publishPlaylist(ctx, pid)
			}
			return nil, nil
		})
}
