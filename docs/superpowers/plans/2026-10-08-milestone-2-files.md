# Milestone 2: Files and Images — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users can attach files and images to messages: streamed uploads with an admin-set size limit, content-addressed storage with deduplication, EXIF stripping and thumbnails for images, permission-checked downloads served safely, and cleanup of uploads that were never sent.

**Architecture:** A new `files` package owns the `attachments` table, a `Store` interface (local disk is the only implementation) that keeps contents at `<data>/files/<sha256>`, pure-Go image processing, and plain `net/http` upload/download handlers (uploads must stream, which Huma operations don't). `auth` gains a `net/http` wrapper so those handlers share the same session/CSRF rules. `messages` claims attachments inside the message's transaction and embeds them in every message payload. The web client uploads on pick/paste/drop and shows images inline.

**Tech Stack:** Go 1.25 standard library (`image/jpeg`, `image/png`, `image/gif`, `mime/multipart`), `golang.org/x/image` (WebP decoding, high-quality scaling) · existing Huma/pgx/goose stack · TypeScript `fetch` + `FormData` · Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-datrope-architecture-design.md` — §7 (Files and images) and §12 item 2. Milestone 1's plan (`docs/superpowers/plans/2026-10-08-milestone-1-foundation.md`) describes the code this builds on.

## Global Constraints

- **Never commit.** (CLAUDE.md §5.) Each task ends with a *Checkpoint*: the controller stages the task with `git add` after review; nobody commits.
- Upload: `POST /api/attachments`, streamed multipart. Size limit set by the admin, **default 50 MB** (52428800 bytes). The server checks `ATTACH_FILES` on the target channel.
- Files are stored at **`/data/files/<sha256>`** (data dir configurable via `DATROPE_DATA_DIR`, default `/data`); identical uploads share one copy.
- The upload returns an attachment ID; the client includes it when sending a message. **Attachments not linked to a message within 24 h are deleted.**
- Images (**JPEG, PNG, WebP, GIF**): record width and height, generate thumbnails, strip EXIF metadata. **Pure Go libraries only — no ffmpeg, no ImageMagick, no cgo.**
- Download: `GET /api/attachments/{id}` checks the user can still view the channel. Responses set `Content-Disposition`, `X-Content-Type-Options: nosniff`, and a strict CSP.
- Storage sits behind a small `Store` interface; local disk is the only implementation.
- REST error body `{code, message, details?}` with statuses from spec §9 (413 = `TOO_LARGE`).
- Project conventions from milestone 1 (all still binding):
  - Go module `github.com/datrope/datrope/server`, `go.mod` stays `go 1.25.6`; run Go with `GOTOOLCHAIN=local`. Pin new dependencies (e.g. `golang.org/x/image`) to the newest version that supports Go 1.25.
  - Huma v2.39.1 does **not** fill path params from unexported embedded structs: declare path fields directly on input structs.
  - Go nil slices appear in generated TS types as `T[] | null`; the server initialises list fields non-nil, the client guards with `?? []`.
  - Packages never query another package's tables; they call each other through interfaces declared by the consumer. Foreign keys to other tables are fine.
  - Every Go test that needs a database uses `pgtest`/`apptest` (real Postgres via testcontainers; Docker must be running).
- Out of scope: S3/object storage, video/audio transcoding, virus scanning, per-user quotas, upload resume, image editing.

## Decisions this plan makes (confirm with the user if any matter)

1. The upload names its channel: `POST /api/attachments?channel_id=<id>`. An attachment belongs to that channel and its uploader; only that uploader can send it, only in that channel.
2. Before it is sent, only the uploader can download an attachment (so the composer can preview it). After sending, anyone who can read the channel's history can.
3. Up to **10 attachments per message**. A message may be attachment-only (empty text); a message with neither text nor attachments is `EMPTY_MESSAGE`.
4. Thumbnails fit in **400×400**, encoded as JPEG (quality 82), or PNG when the image has transparency. Images already that small get no thumbnail. **GIFs get no thumbnail** so they stay animated. Images over 40 megapixels keep no thumbnail (decompression-bomb guard).
5. JPEG EXIF orientation (phone photos) is applied before stripping, by re-encoding at quality 90; JPEGs without a rotation are stripped losslessly. PNG text/EXIF chunks and WebP EXIF/XMP chunks are removed losslessly. GIFs carry no EXIF and are stored unchanged.
6. Images are served `inline` with their image type; every other file is served as `application/octet-stream` with `Content-Disposition: attachment`, whatever its name or content. Every download carries `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, and `Cross-Origin-Resource-Policy: same-origin`. A file that looks like an image but can't be parsed is stored as a plain download.
7. Deleting a message deletes its files (the rows, and the blobs once nothing else references them).
8. The limit lives in `instance_settings.max_upload_bytes` (admin-editable, 1 MB – 10 GB) and is published in `GET /api/instance` so clients can refuse oversized files before uploading.
9. Blob garbage collection: an hourly janitor deletes unsent uploads older than 24 h and blob files nothing references (including files orphaned by deleting a channel or community, after 24 h). Writers and the collector serialise per blob with a Postgres advisory lock, so a blob is never deleted while an upload of the same content is being saved.

## File Structure

```
server/internal/files/
  store.go          Store interface + LocalStore (staging, content addressing, walk)
  imageproc.go      Sniff, Clean (metadata stripping + JPEG orientation), Info, Thumbnail
  files.go          Attachment type, Service (save, get, sweep, janitor)
  claim.go          Claim / ForMessages / DeleteForMessage (used by messages)
  handlers.go       net/http upload and download handlers
  fixtures_test.go  test image builders shared by the package's tests
  store_test.go, imageproc_test.go, files_test.go
server/internal/db/migrations/
  00005_auth_upload_limit.sql   (owned by auth)
  00006_files.sql               (owned by files)
server/internal/auth/      Settings.MaxUploadBytes, InstanceInfo.max_upload_bytes, RequireHTTP
server/internal/httpx/     WriteJSON, WriteHTTPError for net/http handlers
server/internal/messages/  attachments on Message, attachment_ids on send
server/internal/app/       DataDir config, files wiring, App.Files
server/internal/apptest/   DataDir, Raw, Upload, UploadFail, SendWith
clients/core/src/          Attachment type, client.upload, client.url, send(..., attachments)
clients/web/src/           Composer attachments, message attachments, admin upload limit
deploy/, server/Dockerfile files volume, Caddy header scoping, backup docs, e2e upload step
```

---

### Task 1: Content-addressed file store

**Files:**
- Create: `server/internal/files/store.go`
- Test: `server/internal/files/store_test.go`

**Interfaces:**
- Produces: `files.Store` interface; `files.LocalStore` (`files.NewLocalStore(dir string) (*LocalStore, error)`); `files.Staged{Sum string; Size int64}` with `(*Staged).Open() (*os.File, error)` and `(*Staged).Bytes() ([]byte, error)`; `files.ErrTooLarge`; `files.ValidSum(string) bool`.
- `Store` methods: `Stage(r io.Reader, limit int64) (*Staged, error)`, `Commit(*Staged) error`, `Discard(*Staged)`, `Open(sum string) (io.ReadSeekCloser, error)`, `Remove(sum string) error`, `Walk(fn func(sum string, modTime time.Time) error) error`, `RemoveStaleTemp(before time.Time) error`.

- [ ] **Step 1: Write the failing test** — `server/internal/files/store_test.go`

```go
package files_test

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func TestStageAndCommitDeduplicates(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)

	a, err := s.Stage(strings.NewReader("hello"), 100)
	require.NoError(t, err)
	require.Equal(t, int64(5), a.Size)
	require.Equal(t, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", a.Sum)
	require.NoError(t, s.Commit(a))

	b, err := s.Stage(strings.NewReader("hello"), 100)
	require.NoError(t, err)
	require.NoError(t, s.Commit(b)) // same content: the staged copy is dropped

	var sums []string
	require.NoError(t, s.Walk(func(sum string, _ time.Time) error {
		sums = append(sums, sum)
		return nil
	}))
	require.Equal(t, []string{a.Sum}, sums)

	f, err := s.Open(a.Sum)
	require.NoError(t, err)
	got, err := io.ReadAll(f)
	require.NoError(t, err)
	require.NoError(t, f.Close())
	require.Equal(t, "hello", string(got))

	tmp, err := os.ReadDir(filepath.Join(dir, "tmp"))
	require.NoError(t, err)
	require.Empty(t, tmp, "no staged files are left behind")
}

func TestStageEnforcesLimit(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)

	_, err = s.Stage(bytes.NewReader(make([]byte, 11)), 10)
	require.ErrorIs(t, err, files.ErrTooLarge)
	ok, err := s.Stage(bytes.NewReader(make([]byte, 10)), 10)
	require.NoError(t, err)
	s.Discard(ok)

	tmp, err := os.ReadDir(filepath.Join(dir, "tmp"))
	require.NoError(t, err)
	require.Empty(t, tmp)
}

func TestRemoveAndInvalidSums(t *testing.T) {
	s, err := files.NewLocalStore(t.TempDir())
	require.NoError(t, err)
	a, err := s.Stage(strings.NewReader("x"), 10)
	require.NoError(t, err)
	require.NoError(t, s.Commit(a))

	require.NoError(t, s.Remove(a.Sum))
	require.NoError(t, s.Remove(a.Sum), "removing a missing file is not an error")
	_, err = s.Open(a.Sum)
	require.True(t, errors.Is(err, os.ErrNotExist))

	_, err = s.Open("../../etc/passwd")
	require.Error(t, err, "only 64-character hex names are accepted")
	require.False(t, files.ValidSum("ABC"))
}

func TestRemoveStaleTemp(t *testing.T) {
	dir := t.TempDir()
	s, err := files.NewLocalStore(dir)
	require.NoError(t, err)
	stale := filepath.Join(dir, "tmp", "upload-crashed")
	require.NoError(t, os.WriteFile(stale, []byte("partial"), 0o600))

	require.NoError(t, s.RemoveStaleTemp(time.Now().Add(time.Hour)))
	_, err = os.Stat(stale)
	require.True(t, errors.Is(err, os.ErrNotExist))
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && GOTOOLCHAIN=local go test ./internal/files/`
Expected: FAIL — build error `undefined: files.NewLocalStore` (no non-test files yet).

- [ ] **Step 3: Implement** — `server/internal/files/store.go`

```go
// Package files owns uploads: content-addressed storage, image processing,
// the attachments table, and the upload/download handlers (spec section 7).
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

var ErrTooLarge = errors.New("file too large")

// Store keeps file contents by SHA-256; identical content is stored once.
// Local disk is the only implementation.
type Store interface {
	// Stage copies r to a temporary file, failing with ErrTooLarge once it
	// exceeds limit bytes.
	Stage(r io.Reader, limit int64) (*Staged, error)
	// Commit moves a staged file into place under its hash. If that content
	// is already stored, the staged copy is simply removed.
	Commit(s *Staged) error
	// Discard removes a staged file that will not be committed. It is safe
	// to call on nil and on a file that was already committed.
	Discard(s *Staged)
	Open(sum string) (io.ReadSeekCloser, error)
	// Remove deletes stored content; missing content is not an error.
	Remove(sum string) error
	// Walk calls fn for every stored file.
	Walk(fn func(sum string, modTime time.Time) error) error
	// RemoveStaleTemp deletes staging files left by crashes.
	RemoveStaleTemp(before time.Time) error
}

// Staged is an uploaded file waiting to be committed.
type Staged struct {
	Sum  string // hex SHA-256 of the contents
	Size int64
	path string
}

func (s *Staged) Open() (*os.File, error) { return os.Open(s.path) }

func (s *Staged) Bytes() ([]byte, error) { return os.ReadFile(s.path) }

// ValidSum reports whether s looks like a hex SHA-256, which is also what
// keeps stored names from escaping the store directory.
func ValidSum(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

type LocalStore struct{ dir string }

// NewLocalStore stores files in dir and stages uploads in dir/tmp (same
// filesystem, so committing is a rename).
func NewLocalStore(dir string) (*LocalStore, error) {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return nil, err
	}
	return &LocalStore{dir: dir}, nil
}

func (l *LocalStore) pathFor(sum string) (string, error) {
	if !ValidSum(sum) {
		return "", fmt.Errorf("invalid content hash %q", sum)
	}
	return filepath.Join(l.dir, sum), nil
}

func (l *LocalStore) Stage(r io.Reader, limit int64) (*Staged, error) {
	f, err := os.CreateTemp(filepath.Join(l.dir, "tmp"), "upload-*")
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(r, limit+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil && n > limit {
		err = ErrTooLarge
	}
	if err != nil {
		_ = os.Remove(f.Name())
		return nil, err
	}
	return &Staged{Sum: hex.EncodeToString(h.Sum(nil)), Size: n, path: f.Name()}, nil
}

func (l *LocalStore) Commit(s *Staged) error {
	dst, err := l.pathFor(s.Sum)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return os.Remove(s.path)
	}
	return os.Rename(s.path, dst)
}

func (l *LocalStore) Discard(s *Staged) {
	if s != nil {
		_ = os.Remove(s.path)
	}
}

func (l *LocalStore) Open(sum string) (io.ReadSeekCloser, error) {
	p, err := l.pathFor(sum)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

func (l *LocalStore) Remove(sum string) error {
	p, err := l.pathFor(sum)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (l *LocalStore) Walk(fn func(sum string, modTime time.Time) error) error {
	entries, err := os.ReadDir(l.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !ValidSum(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // removed meanwhile
		}
		if err := fn(e.Name(), info.ModTime()); err != nil {
			return err
		}
	}
	return nil
}

func (l *LocalStore) RemoveStaleTemp(before time.Time) error {
	tmp := filepath.Join(l.dir, "tmp")
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().Before(before) {
			_ = os.Remove(filepath.Join(tmp, e.Name()))
		}
	}
	return nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && GOTOOLCHAIN=local go test ./internal/files/`
Expected: `ok`

- [ ] **Step 5: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): content-addressed file store`

---

### Task 2: Image processing (sniffing, metadata stripping, orientation, thumbnails)

**Files:**
- Create: `server/internal/files/imageproc.go`
- Create: `server/internal/files/fixtures_test.go`
- Test: `server/internal/files/imageproc_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type files.Kind string` with `KindJPEG`, `KindPNG`, `KindWebP`, `KindGIF`; `files.Sniff(head []byte) (contentType string, kind Kind)`; `files.Clean(kind Kind, data []byte) ([]byte, error)`; `files.Info(data []byte) (width, height int, err error)`; `files.Thumbnail(kind Kind, data []byte) ([]byte, error)` (nil, nil = no thumbnail needed); constants `ThumbMax = 400`, `MaxDecodePixels = 40_000_000`.
- Test fixtures (package `files_test`, used again in Task 5): `pngImage(w, h int, alpha bool) []byte`, `jpegImage(w, h int) []byte`, `gifImage(w, h int) []byte`, `exifSegment(orientation uint16, marker string) []byte`, `comSegment(text string) []byte`, `withSegments(jpg []byte, segs ...[]byte) []byte`, `pngWithText(p []byte, key, text string) []byte`, `webpWithExif(marker string) []byte`.

- [ ] **Step 1: Add the dependency**

```bash
cd server && GOTOOLCHAIN=local go get golang.org/x/image
```

If that version requires a newer Go than 1.25.6 (`go.mod`'s go line changes), reset `go.mod` to `go 1.25.6` and pin the newest `golang.org/x/image` release that supports it, then `GOTOOLCHAIN=local go mod tidy`.

- [ ] **Step 2: Write the fixtures** — `server/internal/files/fixtures_test.go`

```go
package files_test

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
)

func pngImage(w, h int, alpha bool) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	a := uint8(255)
	if alpha {
		a = 128
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 200, A: a})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func jpegImage(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 4), B: 90, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func gifImage(w, h int) []byte {
	img := image.NewPaletted(image.Rect(0, 0, w, h), color.Palette{color.Black, color.White})
	var buf bytes.Buffer
	if err := gif.Encode(&buf, img, nil); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// exifSegment builds a JPEG APP1 Exif segment holding an orientation tag
// and an ImageDescription carrying marker (a stand-in for GPS data etc.).
func exifSegment(orientation uint16, marker string) []byte {
	le := binary.LittleEndian
	var t bytes.Buffer
	t.WriteString("II*\x00")
	_ = binary.Write(&t, le, uint32(8)) // IFD0 offset
	_ = binary.Write(&t, le, uint16(2)) // two entries
	// Orientation: SHORT, count 1, value inline.
	_ = binary.Write(&t, le, uint16(0x0112))
	_ = binary.Write(&t, le, uint16(3))
	_ = binary.Write(&t, le, uint32(1))
	_ = binary.Write(&t, le, orientation)
	_ = binary.Write(&t, le, uint16(0))
	// ImageDescription: ASCII stored after the IFD.
	desc := marker + "\x00"
	_ = binary.Write(&t, le, uint16(0x010E))
	_ = binary.Write(&t, le, uint16(2))
	_ = binary.Write(&t, le, uint32(len(desc)))
	_ = binary.Write(&t, le, uint32(8+2+2*12+4))
	_ = binary.Write(&t, le, uint32(0)) // no next IFD
	t.WriteString(desc)
	payload := append([]byte("Exif\x00\x00"), t.Bytes()...)
	n := len(payload) + 2
	return append([]byte{0xFF, 0xE1, byte(n >> 8), byte(n)}, payload...)
}

func comSegment(text string) []byte {
	n := len(text) + 2
	return append([]byte{0xFF, 0xFE, byte(n >> 8), byte(n)}, text...)
}

// withSegments inserts JPEG segments right after the SOI marker.
func withSegments(jpg []byte, segs ...[]byte) []byte {
	out := append([]byte{}, jpg[:2]...)
	for _, s := range segs {
		out = append(out, s...)
	}
	return append(out, jpg[2:]...)
}

// pngWithText adds a tEXt chunk just before IEND.
func pngWithText(p []byte, key, text string) []byte {
	data := append([]byte(key+"\x00"), text...)
	chunk := make([]byte, 4, 12+len(data))
	binary.BigEndian.PutUint32(chunk, uint32(len(data)))
	chunk = append(chunk, "tEXt"...)
	chunk = append(chunk, data...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	iend := len(p) - 12
	out := append([]byte{}, p[:iend]...)
	out = append(out, chunk...)
	return append(out, p[iend:]...)
}

// tinyWebP is a valid 1x1 lossless WebP.
const tinyWebP = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=="

// webpWithExif wraps tinyWebP in an extended (VP8X) container that declares
// and carries an EXIF chunk.
func webpWithExif(marker string) []byte {
	base, err := base64.StdEncoding.DecodeString(tinyWebP)
	if err != nil {
		panic(err)
	}
	vp8l := base[12:] // the VP8L chunk, header and padding included
	vp8x := []byte{'V', 'P', '8', 'X', 10, 0, 0, 0, 0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0} // EXIF flag; 1x1 canvas
	exifData := []byte("Exif\x00\x00" + marker)
	exif := []byte("EXIF")
	exif = binary.LittleEndian.AppendUint32(exif, uint32(len(exifData)))
	exif = append(exif, exifData...)
	if len(exifData)%2 == 1 {
		exif = append(exif, 0)
	}
	body := append([]byte("WEBP"), vp8x...)
	body = append(body, vp8l...)
	body = append(body, exif...)
	out := []byte("RIFF")
	out = binary.LittleEndian.AppendUint32(out, uint32(len(body)))
	return append(out, body...)
}
```

- [ ] **Step 3: Write the failing test** — `server/internal/files/imageproc_test.go`

```go
package files_test

import (
	"bytes"
	"encoding/binary"
	"image/jpeg"
	"image/png"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/files"
)

func TestSniff(t *testing.T) {
	for _, tc := range []struct {
		data []byte
		ct   string
		kind files.Kind
	}{
		{pngImage(2, 2, false), "image/png", files.KindPNG},
		{jpegImage(2, 2), "image/jpeg", files.KindJPEG},
		{gifImage(2, 2), "image/gif", files.KindGIF},
		{webpWithExif("x"), "image/webp", files.KindWebP},
		{[]byte("hello there"), "text/plain; charset=utf-8", ""},
	} {
		ct, kind := files.Sniff(tc.data)
		require.Equal(t, tc.ct, ct)
		require.Equal(t, tc.kind, kind)
	}
}

func TestCleanJPEGStripsLosslessly(t *testing.T) {
	orig := jpegImage(40, 20)
	dirty := withSegments(orig, exifSegment(1, "SECRET-GPS"), comSegment("SECRET-NOTE"))
	clean, err := files.Clean(files.KindJPEG, dirty)
	require.NoError(t, err)
	require.Equal(t, orig, clean, "metadata segments are removed byte-for-byte")
}

func TestCleanJPEGAppliesOrientation(t *testing.T) {
	dirty := withSegments(jpegImage(40, 20), exifSegment(6, "SECRET-GPS"))
	clean, err := files.Clean(files.KindJPEG, dirty)
	require.NoError(t, err)
	require.NotContains(t, string(clean), "SECRET-GPS")
	require.NotContains(t, string(clean), "Exif")
	img, err := jpeg.Decode(bytes.NewReader(clean))
	require.NoError(t, err)
	require.Equal(t, 20, img.Bounds().Dx(), "rotated 90 degrees: width and height swap")
	require.Equal(t, 40, img.Bounds().Dy())
}

func TestCleanPNG(t *testing.T) {
	orig := pngImage(10, 10, false)
	clean, err := files.Clean(files.KindPNG, pngWithText(orig, "Comment", "SECRET"))
	require.NoError(t, err)
	require.Equal(t, orig, clean)
}

func TestCleanWebP(t *testing.T) {
	clean, err := files.Clean(files.KindWebP, webpWithExif("SECRET"))
	require.NoError(t, err)
	require.NotContains(t, string(clean), "SECRET")
	require.NotContains(t, string(clean), "EXIF")
	require.Zero(t, clean[20]&0x08, "the VP8X EXIF flag is cleared")
	require.Equal(t, uint32(len(clean)-8), binary.LittleEndian.Uint32(clean[4:8]), "RIFF size is updated")
	w, h, err := files.Info(clean)
	require.NoError(t, err)
	require.Equal(t, 1, w)
	require.Equal(t, 1, h)
}

func TestCleanGIFUnchanged(t *testing.T) {
	g := gifImage(5, 5)
	clean, err := files.Clean(files.KindGIF, g)
	require.NoError(t, err)
	require.Equal(t, g, clean)
}

func TestCleanRejectsMalformed(t *testing.T) {
	_, err := files.Clean(files.KindJPEG, []byte{0xFF, 0xD8, 0xFF})
	require.Error(t, err)
	_, err = files.Clean(files.KindPNG, []byte("not a png"))
	require.Error(t, err)
}

func TestInfo(t *testing.T) {
	w, h, err := files.Info(pngImage(30, 12, false))
	require.NoError(t, err)
	require.Equal(t, 30, w)
	require.Equal(t, 12, h)
}

func TestThumbnail(t *testing.T) {
	thumb, err := files.Thumbnail(files.KindPNG, pngImage(1000, 500, false))
	require.NoError(t, err)
	img, err := jpeg.Decode(bytes.NewReader(thumb))
	require.NoError(t, err, "opaque images become JPEG thumbnails")
	require.Equal(t, 400, img.Bounds().Dx())
	require.Equal(t, 200, img.Bounds().Dy())

	thumb, err = files.Thumbnail(files.KindPNG, pngImage(500, 1000, true))
	require.NoError(t, err)
	img, err = png.Decode(bytes.NewReader(thumb))
	require.NoError(t, err, "transparent images become PNG thumbnails")
	require.Equal(t, 200, img.Bounds().Dx())
	require.Equal(t, 400, img.Bounds().Dy())

	thumb, err = files.Thumbnail(files.KindPNG, pngImage(100, 100, false))
	require.NoError(t, err)
	require.Nil(t, thumb, "small images need no thumbnail")

	thumb, err = files.Thumbnail(files.KindGIF, gifImage(1000, 1000))
	require.NoError(t, err)
	require.Nil(t, thumb, "GIFs keep their animation")
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd server && GOTOOLCHAIN=local go test ./internal/files/`
Expected: FAIL — build error `undefined: files.Sniff`.

- [ ] **Step 5: Implement** — `server/internal/files/imageproc.go`

```go
package files

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // registers the GIF decoder
	"image/jpeg"
	"image/png"
	"net/http"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registers the WebP decoder
)

// Kind is a supported image format, or "" for any other file.
type Kind string

const (
	KindJPEG Kind = "jpeg"
	KindPNG  Kind = "png"
	KindWebP Kind = "webp"
	KindGIF  Kind = "gif"
)

const (
	ThumbMax        = 400        // thumbnails fit in ThumbMax x ThumbMax
	MaxDecodePixels = 40_000_000 // never fully decode larger images
)

var errBadImage = errors.New("malformed image")

// Sniff detects a file's type from its first bytes (up to 512).
func Sniff(head []byte) (contentType string, kind Kind) {
	ct := http.DetectContentType(head)
	switch ct {
	case "image/jpeg":
		return ct, KindJPEG
	case "image/png":
		return ct, KindPNG
	case "image/webp":
		return ct, KindWebP
	case "image/gif":
		return ct, KindGIF
	}
	return ct, ""
}

// Clean removes metadata (EXIF, XMP, text chunks, comments) from an image.
// A JPEG whose EXIF says it is rotated is re-encoded upright first, since
// the rotation would otherwise be lost with the metadata.
func Clean(kind Kind, data []byte) ([]byte, error) {
	switch kind {
	case KindJPEG:
		return cleanJPEG(data)
	case KindPNG:
		return cleanPNG(data)
	case KindWebP:
		return cleanWebP(data)
	case KindGIF:
		return data, nil // GIF has no EXIF
	}
	return nil, fmt.Errorf("not a supported image")
}

func cleanJPEG(data []byte) ([]byte, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, errBadImage
	}
	out := make([]byte, 0, len(data))
	out = append(out, 0xFF, 0xD8)
	orientation := 1
	for i := 2; ; {
		if i+2 > len(data) || data[i] != 0xFF {
			return nil, errBadImage
		}
		marker := data[i+1]
		if marker == 0xFF { // fill byte
			i++
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // start of scan / end of image: copy the rest
			out = append(out, data[i:]...)
			break
		}
		if marker == 0x01 || marker >= 0xD0 && marker <= 0xD7 { // markers without a length
			out = append(out, data[i:i+2]...)
			i += 2
			continue
		}
		if i+4 > len(data) {
			return nil, errBadImage
		}
		n := int(data[i+2])<<8 | int(data[i+3])
		if n < 2 || i+2+n > len(data) {
			return nil, errBadImage
		}
		seg := data[i : i+2+n]
		switch marker {
		case 0xE1: // APP1: EXIF or XMP
			if o, ok := exifOrientation(seg[4:]); ok {
				orientation = o
			}
		case 0xED, 0xFE: // APP13 (Photoshop/IPTC), COM
		default:
			out = append(out, seg...)
		}
		i += 2 + n
	}
	if orientation == 1 {
		return out, nil
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(out))
	if err != nil {
		return nil, err
	}
	if cfg.Width*cfg.Height > MaxDecodePixels {
		return out, nil // too big to rotate safely; keep it stripped but sideways
	}
	img, err := jpeg.Decode(bytes.NewReader(out))
	if err != nil {
		return nil, err
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, orient(img, orientation), &jpeg.Options{Quality: 90}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// exifOrientation reads the Orientation tag (1-8) from an APP1 payload.
func exifOrientation(p []byte) (int, bool) {
	if !bytes.HasPrefix(p, []byte("Exif\x00\x00")) {
		return 0, false
	}
	t := p[6:]
	if len(t) < 8 {
		return 0, false
	}
	var bo binary.ByteOrder
	switch string(t[:4]) {
	case "II*\x00":
		bo = binary.LittleEndian
	case "MM\x00*":
		bo = binary.BigEndian
	default:
		return 0, false
	}
	off := int(bo.Uint32(t[4:8]))
	if off < 8 || off+2 > len(t) {
		return 0, false
	}
	n := int(bo.Uint16(t[off:]))
	for k := 0; k < n; k++ {
		e := off + 2 + 12*k
		if e+12 > len(t) {
			return 0, false
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			v := int(bo.Uint16(t[e+8:]))
			return v, v >= 1 && v <= 8
		}
	}
	return 0, false
}

// orient applies an EXIF orientation (2-8) to an image.
func orient(src image.Image, o int) image.Image {
	if o < 2 || o > 8 {
		return src
	}
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2: // mirrored
				dx, dy = w-1-x, y
			case 3: // rotated 180
				dx, dy = w-1-x, h-1-y
			case 4: // mirrored vertically
				dx, dy = x, h-1-y
			case 5: // transposed
				dx, dy = y, x
			case 6: // rotated 90 clockwise
				dx, dy = h-1-y, x
			case 7: // transversed
				dx, dy = h-1-y, w-1-x
			case 8: // rotated 90 counter-clockwise
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, src.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

func cleanPNG(data []byte) ([]byte, error) {
	if !bytes.HasPrefix(data, pngSignature) {
		return nil, errBadImage
	}
	out := append([]byte{}, pngSignature...)
	for i := len(pngSignature); i < len(data); {
		if i+12 > len(data) {
			return nil, errBadImage
		}
		end := i + 12 + int(binary.BigEndian.Uint32(data[i:]))
		if end > len(data) {
			return nil, errBadImage
		}
		typ := string(data[i+4 : i+8])
		switch typ {
		case "eXIf", "tEXt", "zTXt", "iTXt", "tIME":
		default:
			out = append(out, data[i:end]...)
		}
		i = end
		if typ == "IEND" {
			break
		}
	}
	return out, nil
}

func cleanWebP(data []byte) ([]byte, error) {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil, errBadImage
	}
	out := append([]byte{}, data[:12]...)
	for i := 12; i < len(data); {
		if i+8 > len(data) {
			return nil, errBadImage
		}
		n := int(binary.LittleEndian.Uint32(data[i+4:]))
		end := i + 8 + n + n%2
		if end == len(data)+1 {
			end = len(data) // tolerate a missing final pad byte
		}
		if end > len(data) {
			return nil, errBadImage
		}
		switch string(data[i : i+4]) {
		case "EXIF", "XMP ":
		case "VP8X":
			chunk := append([]byte{}, data[i:end]...)
			if len(chunk) > 8 {
				chunk[8] &^= 0x08 | 0x04 // clear the EXIF and XMP flags
			}
			out = append(out, chunk...)
		default:
			out = append(out, data[i:end]...)
		}
		i = end
	}
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)-8))
	return out, nil
}

// Info returns an image's dimensions without decoding its pixels.
func Info(data []byte) (width, height int, err error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	return cfg.Width, cfg.Height, err
}

// Thumbnail returns a copy that fits in ThumbMax x ThumbMax, or nil when the
// image is already that small or is a GIF (kept as-is so it stays animated).
func Thumbnail(kind Kind, data []byte) ([]byte, error) {
	if kind == KindGIF {
		return nil, nil
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	if cfg.Width <= ThumbMax && cfg.Height <= ThumbMax {
		return nil, nil
	}
	if cfg.Width*cfg.Height > MaxDecodePixels {
		return nil, fmt.Errorf("image too large to thumbnail (%dx%d)", cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	tw, th := fit(cfg.Width, cfg.Height, ThumbMax)
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var buf bytes.Buffer
	if dst.Opaque() {
		err = jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82})
	} else {
		err = png.Encode(&buf, dst)
	}
	return buf.Bytes(), err
}

func fit(w, h, limit int) (int, int) {
	if w >= h {
		return limit, max(1, h*limit/w)
	}
	return max(1, w*limit/h), limit
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && GOTOOLCHAIN=local go test ./internal/files/ && GOTOOLCHAIN=local go vet ./internal/files/`
Expected: `ok`, vet clean.

If `TestCleanWebP`'s `files.Info` fails because the installed `golang.org/x/image/webp` rejects this minimal extended container, keep the stripping assertions and decode the result with `webp.DecodeConfig` to see the error; adjust only the fixture (`webpWithExif`), never the stripping rules.

- [ ] **Step 7: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): image sniffing, metadata stripping, thumbnails`

---

### Task 3: Admin-set upload limit

**Files:**
- Create: `server/internal/db/migrations/00005_auth_upload_limit.sql`
- Modify: `server/internal/auth/store.go` (`Settings`, `(*Store).Settings`, `(*Store).UpdateSettings`)
- Modify: `server/internal/auth/admin.go` (`UpdateSettingsRequest`, the `admin-update-settings` handler)
- Modify: `server/internal/auth/handlers.go` (`InstanceInfo`, the `get-instance` handler)
- Modify: `server/internal/auth/store_test.go:70`, `server/internal/auth/admin_test.go:27` (expected `Settings` values)
- Test: `server/internal/auth/admin_test.go` (new `TestUploadLimitSetting`)

**Interfaces:**
- Produces: `auth.Settings.MaxUploadBytes int64` (JSON `max_upload_bytes`), `auth.InstanceInfo.MaxUploadBytes int64` (JSON `max_upload_bytes`); `PATCH /api/admin/settings` accepts `max_upload_bytes` (1048576–10737418240). Default 52428800.

- [ ] **Step 1: Write the failing test** — append to `server/internal/auth/admin_test.go`

```go
func TestUploadLimitSetting(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")

	var info auth.InstanceInfo
	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, int64(52428800), info.MaxUploadBytes, "50 MB by default")

	var set auth.Settings
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"max_upload_bytes": 10485760}, http.StatusOK, &set)
	require.Equal(t, int64(10485760), set.MaxUploadBytes)
	require.Equal(t, auth.ModeOpen, set.RegistrationMode, "omitted settings are unchanged")

	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.Equal(t, int64(10485760), info.MaxUploadBytes)

	admin.Fail(http.MethodPatch, "/api/admin/settings", map[string]any{"max_upload_bytes": 1000}, http.StatusBadRequest, "VALIDATION_FAILED")
}
```

Also update the two existing equality assertions so they include the new field:

- `server/internal/auth/store_test.go:70` becomes
  `require.Equal(t, auth.Settings{RegistrationMode: auth.ModeInviteOnly, AllowCommunityCreation: true, MaxUploadBytes: 52428800}, set)`
- `server/internal/auth/admin_test.go:27` becomes
  `require.Equal(t, auth.Settings{RegistrationMode: auth.ModeAdminOnly, AllowCommunityCreation: false, MaxUploadBytes: 52428800}, set)`

- [ ] **Step 2: Run it to verify it fails**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./internal/auth/`
Expected: FAIL — build error `info.MaxUploadBytes undefined`.

- [ ] **Step 3: Write the migration** — `server/internal/db/migrations/00005_auth_upload_limit.sql`

```sql
-- +goose Up
ALTER TABLE instance_settings
    ADD COLUMN max_upload_bytes BIGINT NOT NULL DEFAULT 52428800
    CHECK (max_upload_bytes BETWEEN 1048576 AND 10737418240);

-- +goose Down
ALTER TABLE instance_settings DROP COLUMN max_upload_bytes;
```

- [ ] **Step 4: Implement**

In `server/internal/auth/store.go`, replace the `Settings` type and the two settings methods:

```go
type Settings struct {
	RegistrationMode       string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	AllowCommunityCreation bool   `json:"allow_community_creation"`
	MaxUploadBytes         int64  `json:"max_upload_bytes" doc:"Largest file a user may upload"`
}
```

```go
func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var x Settings
	err := s.db.QueryRow(ctx, `SELECT registration_mode, allow_community_creation, max_upload_bytes FROM instance_settings`).
		Scan(&x.RegistrationMode, &x.AllowCommunityCreation, &x.MaxUploadBytes)
	return x, err
}

func (s *Store) UpdateSettings(ctx context.Context, x Settings) error {
	_, err := s.db.Exec(ctx, `
		UPDATE instance_settings SET registration_mode = $1, allow_community_creation = $2, max_upload_bytes = $3`,
		x.RegistrationMode, x.AllowCommunityCreation, x.MaxUploadBytes)
	return err
}
```

In `server/internal/auth/admin.go`, add the field to `UpdateSettingsRequest`:

```go
type UpdateSettingsRequest struct {
	RegistrationMode       *string `json:"registration_mode,omitempty" enum:"invite_only,open,admin_only"`
	AllowCommunityCreation *bool   `json:"allow_community_creation,omitempty"`
	MaxUploadBytes         *int64  `json:"max_upload_bytes,omitempty" minimum:"1048576" maximum:"10737418240"`
}
```

and in the `admin-update-settings` handler, next to the `AllowCommunityCreation` block:

```go
			if in.Body.MaxUploadBytes != nil {
				set.MaxUploadBytes = *in.Body.MaxUploadBytes
			}
```

In `server/internal/auth/handlers.go`, add the field to `InstanceInfo`:

```go
type InstanceInfo struct {
	RegistrationMode string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	HasUsers         bool   `json:"has_users" doc:"False until the first (admin) account exists"`
	MaxUploadBytes   int64  `json:"max_upload_bytes" doc:"Largest file a user may upload"`
}
```

and in the `get-instance` handler replace the return with:

```go
			return &struct{ Body InstanceInfo }{InstanceInfo{
				RegistrationMode: set.RegistrationMode, HasUsers: n > 0, MaxUploadBytes: set.MaxUploadBytes,
			}}, nil
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./...`
Expected: all `ok`.

- [ ] **Step 6: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): admin-set upload size limit`

---

### Task 4: Authentication for plain HTTP handlers

Uploads and downloads are plain `net/http` handlers (Task 5). They need exactly the session rules Huma operations have: bearer token, or cookie plus CSRF header on writes.

**Files:**
- Modify: `server/internal/httpx/errors.go` (add `WriteJSON`, `WriteHTTPError`)
- Modify: `server/internal/auth/service.go` (extract `authenticateRequest`; `Middleware` uses it; add `RequireHTTP`)
- Test: `server/internal/httpx/httpx_test.go` (new `TestWriteHTTPError`)
- Test: `server/internal/auth/http_test.go`

**Interfaces:**
- Produces: `httpx.WriteJSON(w http.ResponseWriter, status int, v any)`; `httpx.WriteHTTPError(w http.ResponseWriter, r *http.Request, err error)` (`*httpx.Error` as-is; anything else is logged and becomes a 500 `INTERNAL` with only `request_id`); `(*auth.Service).RequireHTTP(next http.Handler) http.Handler` — `auth.Current(r.Context())` works inside `next`.

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/httpx/httpx_test.go`:

```go
func TestWriteHTTPError(t *testing.T) {
	rec := httptest.NewRecorder()
	httpx.WriteHTTPError(rec, httptest.NewRequest(http.MethodGet, "/", nil), httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "too big"))
	assertError(t, rec, http.StatusRequestEntityTooLarge, "TOO_LARGE")
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	rec = httptest.NewRecorder()
	httpx.WriteHTTPError(rec, httptest.NewRequest(http.MethodGet, "/", nil), errors.New("secret db detail"))
	assertError(t, rec, http.StatusInternalServerError, "INTERNAL")
	require.NotContains(t, rec.Body.String(), "secret")
}
```

Create `server/internal/auth/http_test.go`:

```go
package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/pgtest"
)

func TestRequireHTTP(t *testing.T) {
	ctx := context.Background()
	pool := pgtest.New(t)
	svc := auth.NewService(pool, &events.Bus{})
	store := auth.NewStore(pool)
	u := &auth.User{ID: id.New(), Username: "alice", DisplayName: "Alice", PasswordHash: "x"}
	require.NoError(t, store.CreateUser(ctx, u))
	token, hash, err := auth.NewToken()
	require.NoError(t, err)
	require.NoError(t, store.CreateSession(ctx, &auth.Session{ID: id.New(), UserID: u.ID, TokenHash: hash, DeviceName: "test"}))

	h := svc.RequireHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(auth.Current(r.Context()).User.Username))
	}))
	do := func(method string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/upload", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	code := func(rec *httptest.ResponseRecorder) string {
		var e httpx.Error
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
		return e.Code
	}

	rec := do(http.MethodPost, map[string]string{"Authorization": "Bearer " + token})
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "alice", rec.Body.String())

	rec = do(http.MethodGet, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Equal(t, "UNAUTHORIZED", code(rec))

	cookie := auth.CookieName + "=" + token
	require.Equal(t, http.StatusOK, do(http.MethodGet, map[string]string{"Cookie": cookie}).Code)

	rec = do(http.MethodPost, map[string]string{"Cookie": cookie})
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CSRF_FAILED", code(rec))

	require.Equal(t, http.StatusOK, do(http.MethodPost, map[string]string{"Cookie": cookie, auth.CSRFHeader: "1"}).Code)
}
```

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./internal/httpx/ ./internal/auth/`
Expected: FAIL — build errors `undefined: httpx.WriteHTTPError`, `svc.RequireHTTP undefined`.

- [ ] **Step 3: Implement the httpx helpers** — append to `server/internal/httpx/errors.go` (add imports `encoding/json` and `errors`)

```go
// WriteJSON writes v as the JSON body of a plain net/http handler's response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteHTTPError writes err from a plain net/http handler. An *Error is
// written as-is; anything else is logged and becomes a 500 that shows only
// the request ID.
func WriteHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	var e *Error
	if !errors.As(err, &e) {
		rid := RequestIDFrom(r.Context())
		slog.ErrorContext(r.Context(), "request failed", "request_id", rid, "err", err)
		e = &Error{Status: http.StatusInternalServerError, Code: "INTERNAL", Message: "internal error",
			Details: map[string]any{"request_id": rid}}
	}
	WriteJSON(w, e.Status, e)
}
```

- [ ] **Step 4: Implement `RequireHTTP`** — in `server/internal/auth/service.go`, replace the whole `Middleware` function with:

```go
// authenticateRequest applies the rules shared by Huma operations and plain
// handlers: a bearer token wins; otherwise the session cookie is used, and a
// cookie request that changes state must carry the CSRF header.
func (s *Service) authenticateRequest(ctx context.Context, authorization, cookie, method, csrf string) (*Principal, *httpx.Error) {
	token, viaCookie := strings.TrimPrefix(authorization, "Bearer "), false
	if authorization == "" {
		token, viaCookie = cookieValue(cookie), true
	}
	p, err := s.Authenticate(ctx, token)
	if errors.Is(err, ErrInvalidSession) {
		return nil, httpx.Unauthorized()
	}
	if err != nil {
		rid := httpx.RequestIDFrom(ctx)
		slog.ErrorContext(ctx, "authenticate", "request_id", rid, "err", err)
		return nil, &httpx.Error{Status: http.StatusInternalServerError, Code: "INTERNAL",
			Message: "internal error", Details: map[string]any{"request_id": rid}}
	}
	if viaCookie && !safeMethod(method) && csrf != "1" {
		return nil, httpx.E(http.StatusForbidden, "CSRF_FAILED", "missing "+CSRFHeader+" header")
	}
	p.ViaCookie = viaCookie
	return p, nil
}

// Middleware authenticates operations registered with Security: httpx.Authed.
// Native clients send a bearer token. Browsers send the session cookie, and
// must add the CSRF header to anything that changes state.
func (s *Service) Middleware(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if len(ctx.Operation().Security) == 0 {
			next(ctx)
			return
		}
		p, e := s.authenticateRequest(ctx.Context(), ctx.Header("Authorization"), ctx.Header("Cookie"),
			ctx.Method(), ctx.Header(CSRFHeader))
		if e != nil {
			httpx.WriteError(api, ctx, e)
			return
		}
		next(huma.WithValue(ctx, ctxKey{}, p))
	}
}

// RequireHTTP gives a plain net/http handler (file upload and download) the
// same authentication as Huma operations; auth.Current works inside next.
func (s *Service) RequireHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, e := s.authenticateRequest(r.Context(), r.Header.Get("Authorization"), r.Header.Get("Cookie"),
			r.Method, r.Header.Get(CSRFHeader))
		if e != nil {
			httpx.WriteHTTPError(w, r, e)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, p)))
	})
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./...`
Expected: all `ok` (the existing auth tests prove `Middleware` behaves as before).

- [ ] **Step 6: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): shared auth for plain http handlers`

---

### Task 5: Attachments — upload, download, cleanup

**Files:**
- Create: `server/internal/db/migrations/00006_files.sql`
- Create: `server/internal/files/files.go`
- Create: `server/internal/files/handlers.go`
- Modify: `server/internal/app/config.go` (`DataDir`)
- Modify: `server/internal/app/app.go` (wire files; `App.Files`)
- Modify: `server/internal/apptest/apptest.go` (`Env.DataDir`, `Raw`, `Upload`, `UploadFail`)
- Test: `server/internal/files/files_test.go`

**Interfaces:**
- Consumes: Task 1 `Store`, `LocalStore`, `Staged`, `ErrTooLarge`; Task 2 `Sniff`, `Clean`, `Info`, `Thumbnail`; Task 3 `auth.Settings.MaxUploadBytes`; Task 4 `RequireHTTP`, `httpx.WriteJSON`, `httpx.WriteHTTPError`; `channels.Service.Access`; `auth.Current`; `perms.AttachFiles`, `perms.ReadHistory`.
- Produces:
  - `files.Attachment{ID, ChannelID id.ID; Filename, ContentType string; Size int64; Width, Height *int; Inline bool; URL, ThumbnailURL string}` (JSON `id, channel_id, filename, content_type, size, width?, height?, inline, url, thumbnail_url?`). `URL` is `/api/attachments/{id}`; `ThumbnailURL` is `/api/attachments/{id}/thumbnail` when a thumbnail exists.
  - `files.NewService(*pgxpool.Pool, Store, Channels, Settings) *Service` with `Channels interface { Access(ctx, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error) }` and `Settings interface { Settings(ctx) (auth.Settings, error) }`.
  - `(*Service).UploadHandler() http.Handler`, `(*Service).DownloadHandler(thumbnail bool) http.Handler`, `(*Service).Start()`, `(*Service).Close()`, `(*Service).Sweep(ctx, now time.Time) error`.
  - Unexported helpers Task 6 builds on: `attachmentCols`, `scanAttachment(pgx.Row) (*Attachment, error)`, `lockBlobs`, `(*Service).removeUnreferenced(ctx, sums []string) error`, `collectSums(pgx.Rows) ([]string, error)`.
  - Endpoints: `POST /api/attachments?channel_id=<id>` (multipart field `file`) → 201 `Attachment`; `GET /api/attachments/{id}`; `GET /api/attachments/{id}/thumbnail`.
  - `app.Config.DataDir` (env `DATROPE_DATA_DIR`, default `/data`; files live in `<DataDir>/files`); `app.App.Files *files.Service` (nil when the app is built without a database).
  - apptest: `Env.DataDir string`; `(*Client).Raw(method, path string, body io.Reader, contentType string, want int) (*http.Response, []byte)`; `(*Client).Upload(channelID id.ID, filename string, content []byte, want int) files.Attachment`; `(*Client).UploadFail(channelID id.ID, filename string, content []byte, wantStatus int, wantCode string)`.

Error codes introduced: `TOO_LARGE` 413, `MISSING_FILE` 400.

- [ ] **Step 1: Write the migration** — `server/internal/db/migrations/00006_files.sql`

```sql
-- +goose Up
CREATE TABLE attachments (
    id           BIGINT PRIMARY KEY,
    channel_id   BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    uploader_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id   BIGINT REFERENCES messages (id) ON DELETE CASCADE, -- NULL until sent with a message
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    width        INT,
    height       INT,
    thumb_sha256 TEXT,
    inline       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_unsent_idx ON attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX attachments_sha_idx ON attachments (sha256);
CREATE INDEX attachments_thumb_idx ON attachments (thumb_sha256) WHERE thumb_sha256 IS NOT NULL;

-- +goose Down
DROP TABLE attachments;
```

- [ ] **Step 2: Extend the config and apptest**

In `server/internal/app/config.go`, add to `Config`:

```go
	DataDir string // uploads live in DataDir/files
```

and in `ConfigFromEnv` set it right after `TrustProxy`:

```go
		DataDir:     os.Getenv("DATROPE_DATA_DIR"),
```

and default it next to the `Addr` default:

```go
	if c.DataDir == "" {
		c.DataDir = "/data"
	}
```

In `server/internal/apptest/apptest.go` (add imports `mime/multipart`, `".../internal/files"`):
- add `DataDir string` to `Env`;
- in `NewWithConfig`, build the config as `cfg := app.Config{PublicURL: PublicURL, DataDir: t.TempDir()}` and set `DataDir: cfg.DataDir` in the returned `Env`;
- append:

```go
// Raw sends a request with any body and returns the response and its body,
// failing the test unless the status is want.
func (c *Client) Raw(method, path string, body io.Reader, contentType string, want int) (*http.Response, []byte) {
	t := c.env.T
	t.Helper()
	req, err := http.NewRequest(method, c.env.Server.URL+path, body)
	require.NoError(t, err)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range c.Header {
		req.Header[k] = v
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	return resp, raw
}

func multipartFile(t *testing.T, filename string, content []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = fw.Write(content)
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	return &buf, mw.FormDataContentType()
}

// Upload sends a file to POST /api/attachments.
func (c *Client) Upload(channelID id.ID, filename string, content []byte, want int) files.Attachment {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(http.MethodPost, "/api/attachments?channel_id="+channelID.String(), body, ct, want)
	var a files.Attachment
	if want == http.StatusCreated {
		require.NoError(c.env.T, json.Unmarshal(raw, &a), string(raw))
	}
	return a
}

// UploadFail sends a file that must be rejected with the given status and code.
func (c *Client) UploadFail(channelID id.ID, filename string, content []byte, wantStatus int, wantCode string) {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(http.MethodPost, "/api/attachments?channel_id="+channelID.String(), body, ct, wantStatus)
	var e httpx.Error
	require.NoError(c.env.T, json.Unmarshal(raw, &e), string(raw))
	require.Equal(c.env.T, wantCode, e.Code)
}
```

- [ ] **Step 3: Write the failing test** — `server/internal/files/files_test.go`

```go
package files_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func setup(t *testing.T) (*apptest.Env, *apptest.Client, *apptest.Client, communities.CommunityWithRoles, id.ID) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.CreateCommunity("Friends")
	bob.JoinCommunity(alice, c.ID)
	return env, alice, bob, c, alice.General(c.ID)
}

func blobCount(t *testing.T, env *apptest.Env) int {
	entries, err := os.ReadDir(filepath.Join(env.DataDir, "files"))
	require.NoError(t, err)
	n := 0
	for _, e := range entries {
		if files.ValidSum(e.Name()) {
			n++
		}
	}
	return n
}

func errorCode(t *testing.T, raw []byte) string {
	var e httpx.Error
	require.NoError(t, json.Unmarshal(raw, &e), string(raw))
	return e.Code
}

func TestUploadAndDownloadImage(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	img := pngImage(20, 10, false)
	a := alice.Upload(ch, "cat.png", img, http.StatusCreated)
	require.True(t, a.Inline)
	require.Equal(t, "image/png", a.ContentType)
	require.Equal(t, 20, *a.Width)
	require.Equal(t, 10, *a.Height)
	require.Equal(t, int64(len(img)), a.Size)
	require.Equal(t, "/api/attachments/"+a.ID.String(), a.URL)
	require.Empty(t, a.ThumbnailURL, "small images need no thumbnail")

	resp, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, img, body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "inline; filename=cat.png", resp.Header.Get("Content-Disposition"))
	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Equal(t, "default-src 'none'; sandbox", resp.Header.Get("Content-Security-Policy"))
}

func TestUnsentAttachmentIsPrivate(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	a := alice.Upload(ch, "notes.txt", []byte("draft"), http.StatusCreated)
	_, raw := bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	require.Equal(t, "NOT_FOUND", errorCode(t, raw))
}

func TestThumbnails(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "wide.png", pngImage(1000, 500, false), http.StatusCreated)
	require.Equal(t, a.URL+"/thumbnail", a.ThumbnailURL)
	resp, body := alice.Raw(http.MethodGet, a.ThumbnailURL, nil, "", http.StatusOK)
	require.Equal(t, "image/jpeg", resp.Header.Get("Content-Type"))
	img, err := jpeg.Decode(bytes.NewReader(body))
	require.NoError(t, err)
	require.Equal(t, 400, img.Bounds().Dx())
	require.Equal(t, 200, img.Bounds().Dy())

	b := alice.Upload(ch, "glass.png", pngImage(1000, 500, true), http.StatusCreated)
	resp, body = alice.Raw(http.MethodGet, b.ThumbnailURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	_, err = png.Decode(bytes.NewReader(body))
	require.NoError(t, err)

	small := alice.Upload(ch, "small.png", pngImage(10, 10, false), http.StatusCreated)
	_, raw := alice.Raw(http.MethodGet, small.URL+"/thumbnail", nil, "", http.StatusNotFound)
	require.Equal(t, "NOT_FOUND", errorCode(t, raw))
}

func TestMetadataIsStripped(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "photo.jpg", withSegments(jpegImage(40, 20), exifSegment(1, "SECRET-GPS")), http.StatusCreated)
	_, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.NotContains(t, string(body), "SECRET-GPS")
	require.Equal(t, 40, *a.Width)

	rotated := alice.Upload(ch, "phone.jpg", withSegments(jpegImage(40, 20), exifSegment(6, "SECRET-GPS")), http.StatusCreated)
	require.Equal(t, 20, *rotated.Width, "the EXIF rotation is applied")
	require.Equal(t, 40, *rotated.Height)
}

func TestNonImagesAreDownloadOnly(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "page.html", []byte("<html><script>alert(1)</script></html>"), http.StatusCreated)
	require.False(t, a.Inline)
	require.Nil(t, a.Width)
	resp, _ := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "application/octet-stream", resp.Header.Get("Content-Type"))
	require.Equal(t, "attachment; filename=page.html", resp.Header.Get("Content-Disposition"))

	broken := alice.Upload(ch, "broken.png", append(pngImage(4, 4, false)[:20], 0, 0, 0), http.StatusCreated)
	require.False(t, broken.Inline, "a corrupt image is kept as a plain file")
}

func TestFilenameIsSanitized(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "../../etc/passwd", []byte("x"), http.StatusCreated)
	require.Equal(t, "passwd", a.Filename)
}

func TestUploadPermissions(t *testing.T) {
	env, alice, bob, c, ch := setup(t)
	env.Register("eve").UploadFail(ch, "x.txt", []byte("x"), http.StatusNotFound, "NOT_FOUND")
	env.Anon().UploadFail(ch, "x.txt", []byte("x"), http.StatusUnauthorized, "UNAUTHORIZED")

	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	bob.UploadFail(ch, "x.txt", []byte("x"), http.StatusForbidden, "MISSING_PERMISSION")
}

func TestUploadLimit(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	_, err := env.Pool.Exec(context.Background(), `UPDATE instance_settings SET max_upload_bytes = 1048576`)
	require.NoError(t, err)
	alice.UploadFail(ch, "big.bin", make([]byte, 1048577), http.StatusRequestEntityTooLarge, "TOO_LARGE")
	alice.Upload(ch, "fits.bin", make([]byte, 1048576), http.StatusCreated)
}

func TestBadUploads(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	path := "/api/attachments?channel_id=" + ch.String()
	_, raw := alice.Raw(http.MethodPost, path, strings.NewReader("{}"), "application/json", http.StatusBadRequest)
	require.Equal(t, "VALIDATION_FAILED", errorCode(t, raw))

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("other", "value"))
	require.NoError(t, mw.Close())
	_, raw = alice.Raw(http.MethodPost, path, &buf, mw.FormDataContentType(), http.StatusBadRequest)
	require.Equal(t, "MISSING_FILE", errorCode(t, raw))
}

func TestIdenticalUploadsShareStorage(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "a.bin", []byte("same bytes"), http.StatusCreated)
	b := alice.Upload(ch, "b.bin", []byte("same bytes"), http.StatusCreated)
	require.NotEqual(t, a.ID, b.ID)
	require.Equal(t, 1, blobCount(t, env))
}

func TestSweepRemovesUnsentUploads(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "draft.png", pngImage(1000, 500, false), http.StatusCreated) // file + thumbnail
	require.Equal(t, 2, blobCount(t, env))

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK) // still fresh

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	require.Equal(t, 0, blobCount(t, env))
}
```

- [ ] **Step 4: Run it to verify it fails**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./internal/files/`
Expected: FAIL — build errors (`files.Attachment` undefined, `env.App.Files` undefined).

- [ ] **Step 5: Implement `server/internal/files/files.go`**

```go
package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

type Settings interface {
	Settings(ctx context.Context) (auth.Settings, error)
}

// Attachment is an uploaded file. URLs are relative to the server.
type Attachment struct {
	ID           id.ID  `json:"id"`
	ChannelID    id.ID  `json:"channel_id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type" doc:"Detected from the contents, not the name"`
	Size         int64  `json:"size"`
	Width        *int   `json:"width,omitempty"`
	Height       *int   `json:"height,omitempty"`
	Inline       bool   `json:"inline" doc:"An image the client may show in the message"`
	URL          string `json:"url"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`

	uploaderID id.ID
	messageID  *id.ID
	sum        string
	thumbSum   string
}

func (a *Attachment) setURLs() {
	a.URL = "/api/attachments/" + a.ID.String()
	if a.thumbSum != "" {
		a.ThumbnailURL = a.URL + "/thumbnail"
	}
}

const (
	unsentTTL     = 24 * time.Hour // unsent uploads and unreferenced blobs live this long
	maxImageBytes = 64 << 20       // larger images are stored as plain files
)

type Service struct {
	db       *pgxpool.Pool
	store    Store
	channels Channels
	settings Settings
	done     chan struct{}
	stop     sync.Once
}

func NewService(pool *pgxpool.Pool, store Store, ch Channels, st Settings) *Service {
	return &Service{db: pool, store: store, channels: ch, settings: st, done: make(chan struct{})}
}

// Start runs the hourly cleanup until Close.
func (s *Service) Start() {
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-s.done:
				return
			case now := <-t.C:
				if err := s.Sweep(context.Background(), now); err != nil {
					slog.Error("files: sweep", "err", err)
				}
			}
		}
	}()
}

func (s *Service) Close() { s.stop.Do(func() { close(s.done) }) }

const attachmentCols = `id, channel_id, uploader_id, message_id, filename, content_type, size, sha256, width, height, thumb_sha256, inline`

func scanAttachment(row pgx.Row) (*Attachment, error) {
	var a Attachment
	var msg *int64
	var thumb *string
	if err := row.Scan(&a.ID, &a.ChannelID, &a.uploaderID, &msg, &a.Filename, &a.ContentType, &a.Size,
		&a.sum, &a.Width, &a.Height, &thumb, &a.Inline); err != nil {
		return nil, err
	}
	a.messageID = id.FromNullable(msg)
	if thumb != nil {
		a.thumbSum = *thumb
	}
	a.setURLs()
	return &a, nil
}

func (s *Service) get(ctx context.Context, attachmentID id.ID) (*Attachment, error) {
	a, err := scanAttachment(s.db.QueryRow(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE id = $1`, attachmentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("attachment")
	}
	return a, err
}

// authorized loads an attachment the caller may download: their own unsent
// upload, or a sent one in a channel whose history they can read.
func (s *Service) authorized(ctx context.Context, raw string) (*Attachment, error) {
	aid, err := httpx.ParseID(raw, "attachment")
	if err != nil {
		return nil, err
	}
	a, err := s.get(ctx, aid)
	if err != nil {
		return nil, err
	}
	me := auth.Current(ctx).User.ID
	if a.messageID == nil {
		if a.uploaderID != me {
			return nil, httpx.NotFound("attachment")
		}
		return a, nil
	}
	if _, _, err := s.channels.Access(ctx, me, a.ChannelID, perms.ReadHistory); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil, httpx.NotFound("attachment") // don't reveal files in channels you can't read
		}
		return nil, err
	}
	return a, nil
}

// save processes a staged upload and records it. Images get their metadata
// stripped, their size measured, and a thumbnail when useful.
func (s *Service) save(ctx context.Context, channelID, uploaderID id.ID, filename string, staged *Staged) (*Attachment, error) {
	var thumb *Staged
	defer func() { // no-ops for files that were committed
		s.store.Discard(staged)
		s.store.Discard(thumb)
	}()

	f, err := staged.Open()
	if err != nil {
		return nil, err
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	_ = f.Close()
	ct, kind := Sniff(head[:n])
	a := &Attachment{ID: id.New(), ChannelID: channelID, Filename: filename, ContentType: ct, uploaderID: uploaderID}

	if kind != "" && staged.Size <= maxImageBytes {
		if err := s.processImage(kind, a, &staged, &thumb); err != nil {
			slog.InfoContext(ctx, "files: keeping image as a plain file", "attachment_id", a.ID, "err", err)
		}
	}
	a.Size, a.sum = staged.Size, staged.Sum
	var thumbArg *string
	if thumb != nil {
		a.thumbSum = thumb.Sum
		thumbArg = &a.thumbSum
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, a.sum, a.thumbSum); err != nil {
		return nil, err
	}
	if err := s.store.Commit(staged); err != nil {
		return nil, err
	}
	if thumb != nil {
		if err := s.store.Commit(thumb); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, sha256, width, height, thumb_sha256, inline)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		a.ID, a.ChannelID, uploaderID, a.Filename, a.ContentType, a.Size, a.sum, a.Width, a.Height, thumbArg, a.Inline); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	a.setURLs()
	return a, nil
}

// processImage swaps *staged for a metadata-free copy, records the image's
// size, and stages a thumbnail when one is useful. On error nothing changes
// and the upload is kept as a plain file.
func (s *Service) processImage(kind Kind, a *Attachment, staged, thumb **Staged) error {
	data, err := (*staged).Bytes()
	if err != nil {
		return err
	}
	clean, err := Clean(kind, data)
	if err != nil {
		return err
	}
	w, h, err := Info(clean)
	if err != nil {
		return err
	}
	tb, err := Thumbnail(kind, clean)
	if err != nil {
		slog.Info("files: no thumbnail", "err", err)
		tb = nil // the image is still shown, just without a smaller copy
	}
	cleaned, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return err
	}
	if tb != nil {
		t, err := s.store.Stage(bytes.NewReader(tb), int64(len(tb)))
		if err != nil {
			s.store.Discard(cleaned)
			return err
		}
		*thumb = t
	}
	s.store.Discard(*staged)
	*staged = cleaned
	a.Width, a.Height, a.Inline = &w, &h, true
	return nil
}

// lockBlobs serialises everyone saving or deleting these blobs until the
// transaction ends, so the collector never deletes a blob being saved.
func lockBlobs(ctx context.Context, tx pgx.Tx, sums ...string) error {
	sorted := slices.Sorted(slices.Values(sums))
	for _, sum := range slices.Compact(sorted) {
		if sum == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sum); err != nil {
			return err
		}
	}
	return nil
}

// Sweep deletes uploads not sent within 24 hours of now, then blob files
// nothing references (such as those left by deleting a channel) once they
// are 24 hours old, then abandoned staging files.
func (s *Service) Sweep(ctx context.Context, now time.Time) error {
	rows, err := s.db.Query(ctx, `
		DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1
		RETURNING sha256, thumb_sha256`, now.Add(-unsentTTL))
	if err != nil {
		return err
	}
	sums, err := collectSums(rows)
	if err != nil {
		return err
	}
	if err := s.store.Walk(func(sum string, mod time.Time) error {
		if now.Sub(mod) > unsentTTL {
			sums = append(sums, sum)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := s.removeUnreferenced(ctx, sums); err != nil {
		return err
	}
	return s.store.RemoveStaleTemp(now.Add(-time.Hour))
}

// collectSums reads (sha256, thumb_sha256) rows.
func collectSums(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sum string
		var thumb *string
		if err := rows.Scan(&sum, &thumb); err != nil {
			return nil, err
		}
		out = append(out, sum)
		if thumb != nil {
			out = append(out, *thumb)
		}
	}
	return out, rows.Err()
}

// removeUnreferenced deletes the blob files no attachment points at.
func (s *Service) removeUnreferenced(ctx context.Context, sums []string) error {
	slices.Sort(sums)
	for _, sum := range slices.Compact(sums) {
		if err := s.removeIfUnused(ctx, sum); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) removeIfUnused(ctx context.Context, sum string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, sum); err != nil {
		return err
	}
	var used bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 = $1 OR thumb_sha256 = $1)`, sum).Scan(&used); err != nil {
		return err
	}
	if !used {
		if err := s.store.Remove(sum); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
```

- [ ] **Step 6: Implement `server/internal/files/handlers.go`**

```go
package files

import (
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/perms"
)

// multipartOverhead is the room allowed for form headers around the file.
const multipartOverhead = 1 << 20

// UploadHandler serves POST /api/attachments?channel_id=<id> with the file
// in a multipart field named "file". It must run behind auth.RequireHTTP.
func (s *Service) UploadHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a, err := s.upload(w, r)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		httpx.WriteJSON(w, http.StatusCreated, a)
	})
}

func (s *Service) upload(w http.ResponseWriter, r *http.Request) (*Attachment, error) {
	ctx := r.Context()
	me := auth.Current(ctx).User.ID
	channelID, err := httpx.ParseID(r.URL.Query().Get("channel_id"), "channel")
	if err != nil {
		return nil, err
	}
	if _, _, err := s.channels.Access(ctx, me, channelID, perms.AttachFiles); err != nil {
		return nil, err
	}
	set, err := s.settings.Settings(ctx)
	if err != nil {
		return nil, err
	}
	limit := set.MaxUploadBytes
	r.Body = http.MaxBytesReader(w, r.Body, limit+multipartOverhead)
	mr, err := r.MultipartReader()
	if err != nil {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "expected a multipart/form-data body")
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return nil, httpx.BadRequest("MISSING_FILE", `the form has no "file" field`)
		}
		if err != nil {
			return nil, uploadError(err, limit)
		}
		if part.FormName() != "file" {
			_, _ = io.Copy(io.Discard, part)
			continue
		}
		staged, err := s.store.Stage(part, limit)
		if err != nil {
			return nil, uploadError(err, limit)
		}
		return s.save(ctx, channelID, me, cleanFilename(part.FileName()), staged)
	}
}

func uploadError(err error, limit int64) error {
	var tooBig *http.MaxBytesError
	if errors.Is(err, ErrTooLarge) || errors.As(err, &tooBig) {
		return httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", fmt.Sprintf("files can be at most %d bytes", limit))
	}
	return httpx.BadRequest("VALIDATION_FAILED", "could not read the upload: "+err.Error())
}

// cleanFilename keeps the last path element, drops control characters and
// quotes, and caps the length.
func cleanFilename(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '"' {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	if name == "" || name == "." || name == "/" {
		return "file"
	}
	if utf8.RuneCountInString(name) > 255 {
		name = string([]rune(name)[:255])
	}
	return name
}

// DownloadHandler serves GET /api/attachments/{id} or, with thumbnail set,
// GET /api/attachments/{id}/thumbnail. It must run behind auth.RequireHTTP.
func (s *Service) DownloadHandler(thumbnail bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.download(w, r, thumbnail); err != nil {
			httpx.WriteHTTPError(w, r, err)
		}
	})
}

func (s *Service) download(w http.ResponseWriter, r *http.Request, thumbnail bool) error {
	a, err := s.authorized(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	sum, ct, disposition := a.sum, "application/octet-stream", "attachment"
	if a.Inline {
		ct, disposition = a.ContentType, "inline"
	}
	if thumbnail {
		if a.thumbSum == "" {
			return httpx.NotFound("thumbnail")
		}
		sum = a.thumbSum
	}
	f, err := s.store.Open(sum)
	if errors.Is(err, os.ErrNotExist) {
		return httpx.NotFound("attachment")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if thumbnail { // thumbnails are JPEG or PNG; tell them apart by content
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		ct = http.DetectContentType(head[:n])
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	if cd := mime.FormatMediaType(disposition, map[string]string{"filename": a.Filename}); cd != "" {
		h.Set("Content-Disposition", cd)
	} else {
		h.Set("Content-Disposition", disposition)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cache-Control", "private, max-age=86400")
	h.Set("ETag", `"`+sum+`"`)
	http.ServeContent(w, r, "", time.Time{}, f)
	return nil
}
```

- [ ] **Step 7: Wire it into the app** — `server/internal/app/app.go`

Add `Files *files.Service` to the `App` struct (comment: `// nil when built without a database`). Add imports `fmt`, `path/filepath`, `".../internal/files"`. Right after the channels block (`channels.Register(api, chanSvc)`), add:

```go
	var filesSvc *files.Service
	if pool != nil { // nil only for `datrope openapi`
		store, err := files.NewLocalStore(filepath.Join(cfg.DataDir, "files"))
		if err != nil {
			panic(fmt.Errorf("files: cannot use %s: %w", cfg.DataDir, err)) // startup misconfiguration
		}
		filesSvc = files.NewService(pool, store, chanSvc, authSvc)
		mux.Handle("POST /api/attachments", authSvc.RequireHTTP(filesSvc.UploadHandler()))
		mux.Handle("GET /api/attachments/{id}", authSvc.RequireHTTP(filesSvc.DownloadHandler(false)))
		mux.Handle("GET /api/attachments/{id}/thumbnail", authSvc.RequireHTTP(filesSvc.DownloadHandler(true)))
		filesSvc.Start()
		a.closers = append(a.closers, filesSvc.Close)
		a.Files = filesSvc
	}
```

Also add `files.Attachment{}` to the type list in `registerEventSchemas` (`server/internal/app/realtime.go`) so the TypeScript client gets the type even before Task 6 embeds it in `Message`.

- [ ] **Step 8: Run the tests to verify they pass**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./... ; go vet ./...`
Expected: all `ok`, vet clean. Then check that no test containers are left: `docker ps -a --filter label=org.testcontainers=true` lists nothing after ~15 seconds.

- [ ] **Step 9: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): attachments upload, download, cleanup`

---

### Task 6: Messages carry attachments

**Files:**
- Create: `server/internal/files/claim.go`
- Modify: `server/internal/messages/messages.go` (`Message.Attachments`, `Attachments` interface, `NewService`, `scanMessage`, `list`, new `withAttachments`)
- Modify: `server/internal/messages/handlers.go` (`SendRequest`, `EditRequest`, send/edit/delete handlers)
- Modify: `server/internal/app/app.go` (pass the files service to messages)
- Modify: `server/internal/apptest/apptest.go` (`SendWith`)
- Test: `server/internal/messages/messages_test.go` (new tests)

**Interfaces:**
- Consumes: Task 5 `files.Attachment`, `attachmentCols`, `scanAttachment`, `collectSums`, `(*Service).removeUnreferenced`, `app.App.Files`, apptest `Upload`, `Raw`.
- Produces:
  - `(*files.Service).Claim(ctx, tx pgx.Tx, messageID, channelID, uploaderID id.ID, ids []id.ID) ([]files.Attachment, error)` — `ATTACHMENT_INVALID` (400) unless every ID is an unsent upload by that user to that channel.
  - `(*files.Service).ForMessages(ctx, messageIDs []id.ID) (map[id.ID][]files.Attachment, error)`.
  - `(*files.Service).DeleteForMessage(ctx, messageID id.ID) error`.
  - `messages.Message.Attachments []files.Attachment` (JSON `attachments`, never null); `messages.NewService(pool, bus, Channels, Users, Attachments)`.
  - `SendRequest{Content string (0-4000); Nonce string; AttachmentIDs []id.ID (≤10)}`; send requires `ATTACH_FILES` too when attachments are given. `EditRequest.Content` may be empty when the message has attachments.
  - Deleting a message deletes its attachments.
  - apptest: `(*Client).SendWith(channelID id.ID, content string, attachmentIDs ...id.ID) messages.Message`.

Error codes introduced: `ATTACHMENT_INVALID` 400.

- [ ] **Step 1: Write the failing tests** — append to `server/internal/messages/messages_test.go` (add imports `time`)

```go
func TestAttachments(t *testing.T) {
	env, alice, bob, communityID, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"
	a := alice.Upload(ch, "notes.txt", []byte("hello file"), http.StatusCreated)

	var m messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "", "attachment_ids": []string{a.ID.String()}}, http.StatusCreated, &m)
	require.Empty(t, m.Content, "a message may be attachment-only")
	require.Len(t, m.Attachments, 1)
	require.Equal(t, a.ID, m.Attachments[0].ID)

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, "notes.txt", page[0].Attachments[0].Filename)
	require.NotNil(t, page[0].Attachments)
	_, body := bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "hello file", string(body), "once sent, the channel can download it")

	alice.Fail(http.MethodPost, path, map[string]any{"content": "again", "attachment_ids": []string{a.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // already sent
	b := bob.Upload(ch, "b.txt", []byte("b"), http.StatusCreated)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": []string{b.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // someone else's upload
	var other channels.Channel
	alice.Do(http.MethodPost, "/api/communities/"+communityID.String()+"/channels",
		map[string]any{"name": "other", "type": "text"}, http.StatusCreated, &other)
	c := alice.Upload(other.ID, "c.txt", []byte("c"), http.StatusCreated)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": []string{c.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // uploaded to another channel
	alice.Fail(http.MethodPost, path, map[string]any{"content": "   "}, http.StatusBadRequest, "EMPTY_MESSAGE")

	ids := make([]string, 11)
	for i := range ids {
		ids[i] = alice.Upload(ch, "f.txt", []byte{byte(i)}, http.StatusCreated).ID.String()
	}
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": ids}, http.StatusBadRequest, "VALIDATION_FAILED")

	var edited messages.Message
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "now with text"}, http.StatusOK, &edited)
	require.Len(t, edited.Attachments, 1)
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": ""}, http.StatusOK, &edited)

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK) // sent files survive the cleanup

	alice.Do(http.MethodDelete, path+"/"+m.ID.String(), nil, http.StatusNoContent, nil)
	bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	for _, p := range page {
		if p.ID == m.ID {
			require.Empty(t, p.Attachments, "a deleted message has no files")
		}
	}
}

func TestAttachFilesCheckedAtSend(t *testing.T) {
	_, alice, bob, communityID, ch := setup(t)
	a := bob.Upload(ch, "x.txt", []byte("x"), http.StatusCreated)
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+communityID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, "/api/channels/"+ch.String()+"/messages",
		map[string]any{"content": "x", "attachment_ids": []string{a.ID.String()}}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Send(ch, "plain text still works")
}
```

- [ ] **Step 2: Run them to verify they fail**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./internal/messages/`
Expected: FAIL — build error `m.Attachments undefined`.

- [ ] **Step 3: Implement `server/internal/files/claim.go`**

```go
package files

import (
	"cmp"
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// Claim attaches uploads to a new message, inside the message's transaction.
// Every ID must be an unsent upload by uploaderID to channelID.
func (s *Service) Claim(ctx context.Context, tx pgx.Tx, messageID, channelID, uploaderID id.ID, ids []id.ID) ([]Attachment, error) {
	out := []Attachment{}
	if len(ids) == 0 {
		return out, nil
	}
	unique := slices.Compact(slices.Sorted(slices.Values(ids)))
	rows, err := tx.Query(ctx, `
		UPDATE attachments SET message_id = $1
		WHERE id = ANY($2) AND channel_id = $3 AND uploader_id = $4 AND message_id IS NULL
		RETURNING `+attachmentCols, messageID, id.Int64s(unique), channelID, uploaderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) != len(unique) {
		return nil, httpx.BadRequest("ATTACHMENT_INVALID", "an attachment is missing, already sent, or was uploaded elsewhere")
	}
	slices.SortFunc(out, func(a, b Attachment) int { return cmp.Compare(a.ID, b.ID) }) // upload order
	return out, nil
}

// ForMessages returns the attachments of the given messages, in upload order.
func (s *Service) ForMessages(ctx context.Context, messageIDs []id.ID) (map[id.ID][]Attachment, error) {
	out := map[id.ID][]Attachment{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE message_id = ANY($1) ORDER BY id`,
		id.Int64s(messageIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out[*a.messageID] = append(out[*a.messageID], *a)
	}
	return out, rows.Err()
}

// DeleteForMessage removes a deleted message's files.
func (s *Service) DeleteForMessage(ctx context.Context, messageID id.ID) error {
	rows, err := s.db.Query(ctx, `DELETE FROM attachments WHERE message_id = $1 RETURNING sha256, thumb_sha256`, messageID)
	if err != nil {
		return err
	}
	sums, err := collectSums(rows)
	if err != nil {
		return err
	}
	return s.removeUnreferenced(ctx, sums)
}
```

- [ ] **Step 4: Update `server/internal/messages/messages.go`**

Add the import `".../internal/files"` and `"github.com/jackc/pgx/v5"` (already imported). Add the interface after `Users`:

```go
// Attachments is what this package needs from files.
type Attachments interface {
	Claim(ctx context.Context, tx pgx.Tx, messageID, channelID, uploaderID id.ID, ids []id.ID) ([]files.Attachment, error)
	ForMessages(ctx context.Context, messageIDs []id.ID) (map[id.ID][]files.Attachment, error)
	DeleteForMessage(ctx context.Context, messageID id.ID) error
}
```

Add the field to `Message`, after `Content`:

```go
	Attachments []files.Attachment `json:"attachments"`
```

Replace `Service` and `NewService`:

```go
type Service struct {
	db          *pgxpool.Pool
	bus         *events.Bus
	channels    Channels
	users       Users
	attachments Attachments
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, c Channels, u Users, a Attachments) *Service {
	return &Service{db: pool, bus: bus, channels: c, users: u, attachments: a}
}
```

In `scanMessage`, before `return &m, nil`, add:

```go
	m.Attachments = []files.Attachment{}
```

In `list`, replace the final `return out, s.withAuthors(ctx, out)` with:

```go
	if err := s.withAuthors(ctx, out); err != nil {
		return nil, err
	}
	return out, s.withAttachments(ctx, out)
```

and add:

```go
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
```

- [ ] **Step 5: Update `server/internal/messages/handlers.go`**

Replace the request types:

```go
type SendRequest struct {
	Content       string  `json:"content" maxLength:"4000"`
	Nonce         string  `json:"nonce,omitempty" maxLength:"64" doc:"Client-chosen; echoed in MESSAGE_CREATE so the sender can match its pending message"`
	AttachmentIDs []id.ID `json:"attachment_ids,omitempty" maxItems:"10" doc:"Uploads (POST /api/attachments) to send with the message"`
}

type EditRequest struct {
	Content string `json:"content" maxLength:"4000"`
}
```

Replace the body of the `send-message` handler function with:

```go
			need := perms.SendMessages
			if len(in.Body.AttachmentIDs) > 0 {
				need |= perms.AttachFiles
			}
			ch, _, err := access(ctx, in.ID, need)
			if err != nil {
				return nil, err
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" && len(in.Body.AttachmentIDs) == 0 {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs text or an attachment")
			}
			u := auth.Current(ctx).User
			m := &Message{ID: id.New(), ChannelID: ch.ID, Author: u.Public(), Content: content, Nonce: in.Body.Nonce}
			m.CreatedAt = m.ID.Time()
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)`,
				m.ID, m.ChannelID, u.ID, m.Content); err != nil {
				return nil, err
			}
			if m.Attachments, err = s.attachments.Claim(ctx, tx, m.ID, ch.ID, u.ID, in.Body.AttachmentIDs); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publish("MESSAGE_CREATE", ch.ID, m)
			return &struct{ Body *Message }{m}, nil
```

In the `edit-message` handler, replace everything from `content := strings.TrimSpace(in.Body.Content)` to the `return` with:

```go
			current, err := s.attachments.ForMessages(ctx, []id.ID{m.ID})
			if err != nil {
				return nil, err
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" && len(current[m.ID]) == 0 {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs text or an attachment")
			}
			updated, err := scanMessage(s.db.QueryRow(ctx,
				`UPDATE messages SET content = $2, edited_at = now() WHERE id = $1 RETURNING `+messageCols, m.ID, content))
			if err != nil {
				return nil, err
			}
			updated.Author = auth.Current(ctx).User.Public()
			if a := current[m.ID]; a != nil {
				updated.Attachments = a
			}
			s.publish("MESSAGE_UPDATE", ch.ID, updated)
			return &struct{ Body *Message }{updated}, nil
```

In the `delete-message` handler, right after the `UPDATE messages SET content = '', deleted = TRUE` statement succeeds, add:

```go
			if err := s.attachments.DeleteForMessage(ctx, m.ID); err != nil {
				return nil, err
			}
```

- [ ] **Step 6: Wire and add the apptest helper**

In `server/internal/app/app.go`, move the files block (Task 5) above the messages block if it isn't already, and pass the service:

```go
	// filesSvc is nil when built without a database; messages never calls it then.
	msgSvc := messages.NewService(pool, a.Bus, chanSvc, authSvc, filesSvc)
```

In `server/internal/apptest/apptest.go` append:

```go
// SendWith sends a message with attachments.
func (c *Client) SendWith(channelID id.ID, content string, attachmentIDs ...id.ID) messages.Message {
	c.env.T.Helper()
	ids := make([]string, len(attachmentIDs))
	for i, a := range attachmentIDs {
		ids[i] = a.String()
	}
	var m messages.Message
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages",
		map[string]any{"content": content, "attachment_ids": ids}, http.StatusCreated, &m)
	return m
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run (PowerShell): `$env:GOTOOLCHAIN='local'; cd D:\code\datrope\server; go test ./... ; go vet ./...`
Expected: all `ok` (including the milestone-1 message tests), vet clean.

- [ ] **Step 8: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(server): messages carry attachments`

---

### Task 7: TypeScript client — upload and send attachments

**Files:**
- Regenerate: `clients/core/openapi.json`, `clients/core/src/schema.d.ts`
- Modify: `clients/core/src/types.ts` (`Attachment`)
- Modify: `clients/core/src/client.ts` (`upload`, `url`, `send(..., attachments)`)
- Modify: `clients/core/src/store.ts` (`addPending(..., attachments)`)
- Modify: `clients/core/src/store.test.ts` (fixtures gain `attachments: []`)
- Replace: `clients/core/src/client.test.ts`

**Interfaces:**
- Consumes: the server API from Tasks 3, 5, 6 (`max_upload_bytes`, `POST /api/attachments`, `Message.attachments`, `attachment_ids`).
- Produces: `type Attachment = Schemas["Attachment"]`; `(DatropeClient).upload(channelId: string, file: Blob, filename: string): Promise<Attachment>` (throws `ApiError`; sends the CSRF header or bearer token like the API client); `(DatropeClient).url(path: string): string` (prefixes `baseUrl`; native clients need absolute URLs); `(DatropeClient).send(channelId, content, attachments: Attachment[] = [])`; `addPending(s, channelId, nonce, content, attachments: Attachment[] = [])`.

- [ ] **Step 1: Regenerate the API types**

Run (in a shell with `GOTOOLCHAIN=local`): `pnpm --filter @datrope/core gen`
Expected: `schema.d.ts` now has `components.schemas.Attachment`, `Message.attachments`, `SendRequest.attachment_ids`, `InstanceInfo.max_upload_bytes`, `Settings.max_upload_bytes`.

- [ ] **Step 2: Write the failing tests**

In `clients/core/src/store.test.ts`, add `attachments: []` to the object returned by `msg()` (before `...extra`).

Replace `clients/core/src/client.test.ts` with:

```ts
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { ApiError } from "./api";
import { DatropeClient } from "./client";
import { applyReady, prependHistory } from "./store";
import type { Attachment, Message, Ready } from "./types";

const BASE = "http://test.local";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ready = {
  session_id: "s", communities: [], dms: [], presences: [], read_states: [],
  user: { id: "1", username: "alice", display_name: "Alice", is_admin: false, disabled: false, created_at: "2026-01-01T00:00:00Z" },
} satisfies Ready;

const attachment: Attachment = {
  id: "900", channel_id: "300", filename: "hi.txt", content_type: "text/plain; charset=utf-8",
  size: 2, inline: false, url: "/api/attachments/900",
};

function message(body: { content: string; nonce: string }, attachments: Attachment[] = []): Message {
  return {
    id: "77", channel_id: "300", author: { id: "1", username: "alice", display_name: "Alice" },
    content: body.content, created_at: "2026-01-01T00:00:00Z", deleted: false, nonce: body.nonce, attachments,
  };
}

function readyClient() {
  const client = new DatropeClient({ baseUrl: BASE, wsUrl: "ws://unused" });
  client.store.setState(prependHistory(applyReady(client.store.getState(), ready), "300", [], 50), true);
  return client;
}

it("sends optimistically and confirms with the server's message", async () => {
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string };
    return HttpResponse.json(message(body), { status: 201 });
  }));
  const client = readyClient();
  await client.send("300", "hi");
  const items = client.store.getState().messages["300"].items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ id: "77", content: "hi" });
  expect(items[0].pending).toBeUndefined();
});

it("uploads a file and sends it with a message", async () => {
  let csrf: string | null = null;
  let channel: string | null = null;
  let filename: string | undefined;
  let sent: unknown;
  server.use(
    http.post(`${BASE}/api/attachments`, async ({ request }) => {
      csrf = request.headers.get("X-Datrope-CSRF");
      channel = new URL(request.url).searchParams.get("channel_id");
      filename = ((await request.formData()).get("file") as File).name;
      return HttpResponse.json(attachment, { status: 201 });
    }),
    http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
      const body = (await request.json()) as { content: string; nonce: string };
      sent = body;
      return HttpResponse.json(message(body, [attachment]), { status: 201 });
    }),
  );
  const client = readyClient();
  const a = await client.upload("300", new Blob(["hi"]), "hi.txt");
  expect(a.id).toBe("900");
  expect(csrf).toBe("1");
  expect(channel).toBe("300");
  expect(filename).toBe("hi.txt");

  await client.send("300", "", [a]);
  expect(sent).toMatchObject({ content: "", attachment_ids: ["900"] });
  expect(client.store.getState().messages["300"].items[0].attachments).toEqual([attachment]);
  expect(client.url(a.url)).toBe(`${BASE}/api/attachments/900`);
});

it("reports upload errors with the server's code", async () => {
  server.use(http.post(`${BASE}/api/attachments`, () =>
    HttpResponse.json({ code: "TOO_LARGE", message: "files can be at most 1048576 bytes" }, { status: 413 })));
  const err = await readyClient().upload("300", new Blob(["x"]), "x.bin").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).code).toBe("TOO_LARGE");
  expect((err as ApiError).status).toBe(413);
});

it("shows attachments on the pending message", async () => {
  let release!: () => void;
  server.use(http.post(`${BASE}/api/channels/:id/messages`, async ({ request }) => {
    const body = (await request.json()) as { content: string; nonce: string };
    await new Promise<void>((r) => (release = r));
    return HttpResponse.json(message(body, [attachment]), { status: 201 });
  }));
  const client = readyClient();
  const sending = client.send("300", "look", [attachment]);
  await expect.poll(() => client.store.getState().messages["300"].items[0]?.attachments).toEqual([attachment]);
  expect(client.store.getState().messages["300"].items[0].pending).toBe(true);
  await expect.poll(() => typeof release).toBe("function"); // the request reached the server
  release();
  await sending;
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @datrope/core test`
Expected: FAIL — `client.upload is not a function` (and type errors on `attachments` until Step 4).

- [ ] **Step 4: Implement**

In `clients/core/src/types.ts` add:

```ts
export type Attachment = Schemas["Attachment"];
```

In `clients/core/src/store.ts`, change `addPending` to take attachments (import `Attachment` from `./types`):

```ts
export function addPending(s: State, channelId: string, nonce: string, content: string, attachments: Attachment[] = []): State {
  if (!s.me) return s;
  const pending: ClientMessage = {
    id: `pending:${nonce}`, channel_id: channelId, nonce, content, attachments, pending: true, deleted: false,
    author: { id: s.me.id, username: s.me.username, display_name: s.me.display_name },
    created_at: new Date().toISOString(),
  };
  const list = s.messages[channelId] ?? { items: [], hasMore: true };
  return { ...s, messages: { ...s.messages, [channelId]: { ...list, items: [...list.items, pending] } } };
}
```

In `clients/core/src/client.ts` (import `ApiError` from `./api` and `Attachment` from `./types`), replace `send` and add `upload` and `url`:

```ts
  async send(channelId: string, content: string, attachments: Attachment[] = []) {
    const nonce = crypto.randomUUID();
    this.set((s) => addPending(s, channelId, nonce, content, attachments));
    try {
      const m = await unwrap(this.api.POST("/api/channels/{id}/messages", {
        params: { path: { id: channelId } },
        body: { content, nonce, ...(attachments.length > 0 ? { attachment_ids: attachments.map((a) => a.id) } : {}) },
      }));
      // The gateway usually delivers this first; applying it twice is harmless.
      this.set((s) => applyEvent(s, "MESSAGE_CREATE", m));
    } catch (e) {
      this.set((s) => markFailed(s, channelId, nonce));
      throw e;
    }
  }

  /** Uploads a file for a message in channelId; pass the result to send(). */
  async upload(channelId: string, file: Blob, filename: string): Promise<Attachment> {
    const form = new FormData();
    form.append("file", file, filename);
    const headers = new Headers();
    const token = this.o.token?.();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    else headers.set("X-Datrope-CSRF", "1");
    const res = await fetch(`${this.o.baseUrl}/api/attachments?channel_id=${encodeURIComponent(channelId)}`, {
      method: "POST", body: form, headers, credentials: "include",
    });
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; details?: Record<string, unknown> };
    if (!res.ok) throw new ApiError(res.status, body.code ?? "UNKNOWN", body.message ?? res.statusText, body.details);
    return body as Attachment;
  }

  /** Absolute URL for a server path such as an attachment's url. */
  url(path: string): string {
    return `${this.o.baseUrl}${path}`;
  }
```

- [ ] **Step 5: Run the tests, typecheck, and lint**

Run: `pnpm --filter @datrope/core test && pnpm --filter @datrope/core typecheck && pnpm lint`
Expected: all pass. If a generated type differs from a fixture (optional vs required), fix the fixture to match `schema.d.ts`.

- [ ] **Step 6: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(clients): upload and send attachments`

---

### Task 8: Web — attach, show, and limit files

**Files:**
- Modify: `clients/web/src/session.ts` (`instanceInfo`, `formatBytes`)
- Replace: `clients/web/src/app/Composer.tsx`
- Modify: `clients/web/src/app/ChannelView.tsx` (pass `canAttach`)
- Modify: `clients/web/src/app/MessageList.tsx` (render attachments)
- Modify: `clients/web/src/app/settings/AdminSettings.tsx` (upload limit field)
- Modify: `clients/web/src/styles.css`

**Interfaces:**
- Consumes: Task 7 `client.upload`, `client.url`, `client.send(..., attachments)`, `Attachment`, `InstanceInfo.max_upload_bytes`, `Settings.max_upload_bytes`; `Perm.AttachFiles`.
- Produces: `instanceInfo(): Promise<InstanceInfo>` (fetched once per page load) and `formatBytes(n: number): string` in `session.ts`; `Composer` prop `canAttach: boolean`; the hidden file input in the composer is the only `input[type="file"]` on the channel page (the e2e test in Task 9 uses it).

- [ ] **Step 1: Add the session helpers** — append to `clients/web/src/session.ts` (add `unwrap` and `type InstanceInfo` to the `@datrope/core` import)

```ts
let instance: Promise<InstanceInfo> | undefined;

/** Server settings the UI needs (e.g. the upload limit), fetched once per page load. */
export function instanceInfo(): Promise<InstanceInfo> {
  instance ??= unwrap(client.api.GET("/api/instance")).catch((e: unknown) => {
    instance = undefined; // retry next time
    throw e;
  });
  return instance;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
```

- [ ] **Step 2: Replace `clients/web/src/app/Composer.tsx`**

```tsx
import type { Attachment } from "@datrope/core";
import { useRef, useState } from "react";
import { client, errorText, formatBytes, instanceInfo } from "../session";
import { Button, ErrorText } from "../ui";

interface PendingFile {
  key: string;
  name: string;
  size: number;
  attachment?: Attachment; // set once uploaded
  error?: string;
}

export function Composer({ channelId, canSend, canAttach, placeholder }:
  { channelId: string; canSend: boolean; canAttach: boolean; placeholder: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [error, setError] = useState<string>();
  const picker = useRef<HTMLInputElement>(null);
  if (!canSend) return <div className="composer muted">You can't send messages here.</div>;

  const uploading = files.some((f) => !f.attachment && !f.error);
  const ready = files.flatMap((f) => (f.attachment ? [f.attachment] : []));
  const update = (key: string, patch: Partial<PendingFile>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));

  const add = (list: Iterable<File>) => {
    if (!canAttach) return;
    for (const file of list) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: file.name, size: file.size }]);
      void (async () => {
        try {
          const { max_upload_bytes: max } = await instanceInfo();
          if (file.size > max) {
            update(key, { error: `Over the ${formatBytes(max)} limit` });
            return;
          }
          update(key, { attachment: await client.upload(channelId, file, file.name) });
        } catch (e) {
          update(key, { error: errorText(e) });
        }
      })();
    }
  };

  const submit = () => {
    const content = text.trim();
    if (uploading || (!content && ready.length === 0)) return;
    setText("");
    setFiles([]);
    setError(undefined);
    client.send(channelId, content, ready).catch((e) => setError(errorText(e)));
  };

  return (
    <form className="composer"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => {
        if (!canAttach || e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        add(Array.from(e.dataTransfer.files));
      }}>
      {files.length > 0 && (
        <ul className="chips" aria-label="Attachments">
          {files.map((f) => (
            <li key={f.key} className={`chip ${f.error ? "chip-error" : ""}`}>
              <span>{f.name}</span>
              <span className="muted">{f.error ?? (f.attachment ? formatBytes(f.size) : "Uploading…")}</span>
              <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {canAttach && (
        <>
          <input ref={picker} type="file" multiple hidden
            onChange={(e) => {
              if (e.target.files) add(Array.from(e.target.files));
              e.target.value = "";
            }} />
          <Button variant="ghost" aria-label="Attach files" title="Attach files" onClick={() => picker.current?.click()}>+</Button>
        </>
      )}
      <textarea value={text} placeholder={placeholder} aria-label="Message" maxLength={4000} rows={1}
        onChange={(e) => {
          setText(e.target.value);
          client.typing(channelId).catch(() => undefined);
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (canAttach && pasted.length > 0) {
            e.preventDefault();
            add(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }} />
      <Button type="submit" disabled={uploading || (!text.trim() && ready.length === 0)}>Send</Button>
      <ErrorText error={error} />
    </form>
  );
}
```

- [ ] **Step 3: Pass the permission** — in `clients/web/src/app/ChannelView.tsx`, replace the `<Composer ... />` element with:

```tsx
      <Composer channelId={channelId} canSend={hasPerm(perms, Perm.SendMessages)} canAttach={hasPerm(perms, Perm.AttachFiles)}
        placeholder={ch.type === "dm" ? `Message ${dmName(ch, me?.id)}` : `Message #${ch.name}`} />
```

- [ ] **Step 4: Show attachments** — in `clients/web/src/app/MessageList.tsx`

Add `type Attachment` to the `@datrope/core` import and `formatBytes` to the `../session` import. In `MessageRow`, replace the last branch of the deleted/editing/body conditional — the part that renders `<p className="msg-body">{m.content}...` — and add the attachments line right after the whole conditional:

```tsx
      ) : m.content || m.edited_at ? (
        <p className="msg-body">{m.content}{m.edited_at && <span className="muted"> (edited)</span>}</p>
      ) : null}
      {!m.deleted && <Attachments items={m.attachments ?? []} />}
```

Add at the bottom of the file:

```tsx
/** Fits an image into 400x300 without upscaling, keeping its shape. */
function fitBox(w: number, h: number) {
  const scale = Math.min(1, 400 / w, 300 / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function Attachments({ items }: { items: Attachment[] }) {
  if (items.length === 0) return null;
  return (
    <div className="attachments">
      {items.map((a) => (a.inline && a.width && a.height ? (
        <a key={a.id} href={client.url(a.url)} target="_blank" rel="noopener noreferrer">
          <img className="attachment-img" src={client.url(a.thumbnail_url || a.url)} alt={a.filename}
            loading="lazy" {...fitBox(a.width, a.height)} />
        </a>
      ) : (
        <a key={a.id} className="attachment-file" href={client.url(a.url)} download={a.filename}>
          <span aria-hidden="true">📎</span>
          <span>{a.filename}</span>
          <span className="muted">{formatBytes(a.size)}</span>
        </a>
      )))}
    </div>
  );
}
```

- [ ] **Step 5: Admin upload limit** — in `clients/web/src/app/settings/AdminSettings.tsx`, replace the `InstanceSettings` component with:

```tsx
const MB = 1024 * 1024;

function InstanceSettings({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const [mode, setMode] = useState(initial.registration_mode);
  const [allow, setAllow] = useState(initial.allow_community_creation);
  const [maxMb, setMaxMb] = useState(Math.round(initial.max_upload_bytes / MB));
  const { busy, error, run } = useSubmit();
  return (
    <form className="card" aria-label="Registration" onSubmit={(e) => {
      e.preventDefault();
      void run(async () => {
        onSaved(await unwrap(client.api.PATCH("/api/admin/settings", {
          body: { registration_mode: mode, allow_community_creation: allow, max_upload_bytes: maxMb * MB },
        })));
      });
    }}>
      <h3>Registration and uploads</h3>
      <label className="field">
        <span>Who can create an account</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as Settings["registration_mode"])}>
          <option value="invite_only">People with an invite</option>
          <option value="open">Anyone</option>
          <option value="admin_only">Only the admin</option>
        </select>
      </label>
      <label className="row">
        <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
        Everyone can create communities
      </label>
      <Field label="Largest upload (MB)" type="number" min={1} max={10240} required value={maxMb}
        onChange={(e) => setMaxMb(Number(e.target.value))} />
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>Save</Button>
    </form>
  );
}
```

- [ ] **Step 6: Styles** — append to `clients/web/src/styles.css`

```css
.attachments { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.3rem; }
.attachment-img { display: block; max-width: 100%; height: auto; border-radius: var(--radius); border: 1px solid var(--border); background: var(--panel); }
.attachment-file { display: inline-flex; gap: 0.45rem; align-items: center; padding: 0.45rem 0.7rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--panel); color: var(--text); text-decoration: none; }
.chips { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem; width: 100%; }
.chip { display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.2rem 0.3rem 0.2rem 0.6rem; border: 1px solid var(--border); border-radius: 999px; background: var(--panel); font-size: 0.85rem; }
.chip-error { border-color: var(--danger); }
```

- [ ] **Step 7: Typecheck, lint, and build**

Run: `pnpm --filter @datrope/web build && pnpm lint`
Expected: success.

- [ ] **Step 8: Manual check** (dev servers: Postgres in Docker on 55432, server on 8081 with `DATROPE_DATA_DIR` pointing at a local folder, Vite on 5173 with `DATROPE_DEV_SERVER=localhost:8081`)

1. Click **+** in the composer, pick a photo: a chip shows "Uploading…", then its size; **Send** stays disabled until the upload finishes.
2. Send with no text: the message shows the image (thumbnail for large photos); clicking it opens the full image in a new tab.
3. Paste a screenshot into the composer and drag a PDF onto it: both become chips; the PDF shows as a 📎 card that downloads.
4. In admin settings set the limit to 1 MB, reload, and pick a larger file: the chip says "Over the 1.0 MB limit" without uploading.
5. Deny "Attach files" for @everyone in a channel: the **+** button disappears there for normal members.

- [ ] **Step 9: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(web): attach and show files`

---

### Task 9: Deployment and end-to-end check

**Files:**
- Modify: `server/Dockerfile` (writable `/data` for the nonroot user)
- Modify: `deploy/docker-compose.yml` (files volume)
- Modify: `deploy/Caddyfile` (keep the web app's CSP off API responses)
- Modify: `deploy/README.md` (back up and restore the files volume)
- Modify: `.gitignore` (`.data/`)
- Modify: `clients/web/e2e/chat.spec.ts` (upload step)
- Modify (local, untracked): `.claude/launch.json` (dev server data dir)

**Interfaces:**
- Consumes: everything above.
- Produces: the Compose stack persists uploads in the `files` volume (`datrope_files`); the e2e test covers sending an image.

- [ ] **Step 1: Add the upload step to the e2e test (it fails first)**

In `clients/web/e2e/chat.spec.ts`, add at the top level:

```ts
// A 1x1 PNG.
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
```

and insert before `await admin.reload();`:

```ts
  // Files: the admin attaches an image; the friend sees it in the channel.
  await admin.locator('input[type="file"]').setInputFiles({
    name: "pixel.png", mimeType: "image/png", buffer: Buffer.from(PIXEL_PNG, "base64"),
  });
  await expect(admin.getByText("pixel.png")).toBeVisible();
  await admin.getByLabel("Message", { exact: true }).fill("a picture");
  await admin.getByRole("button", { name: "Send" }).click();
  await expect(friend.getByText("a picture")).toBeVisible();
  await expect(friend.getByRole("img", { name: "pixel.png" })).toBeVisible();
```

Try the stack with the current (unchanged) deployment files:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
```

Expected: FAIL — `up --wait` reports the `server` container unhealthy, and `docker compose -p datrope-e2e logs server` shows the startup panic `files: cannot use /data ...`: the distroless image has no writable data directory. That is what Step 2 fixes. Tear down with the `down -v` line.

- [ ] **Step 2: Give the server a persistent, writable data directory**

Replace `server/Dockerfile` with (keep the healthcheck as it is today):

```dockerfile
FROM golang:1.25-alpine AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/datrope ./cmd/datrope \
 && mkdir -p /out/data/files

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/datrope /datrope
# A new named volume mounted at /data copies this directory, owner included,
# so the nonroot user (65532) can write uploads.
COPY --from=build --chown=65532:65532 /out/data /data
ENV DATROPE_DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s CMD ["/datrope", "healthcheck"]
ENTRYPOINT ["/datrope"]
```

In `deploy/docker-compose.yml`, add to the `server` service:

```yaml
    volumes:
      - files:/data
```

and `DATROPE_DATA_DIR: /data` to its `environment`, and `files:` under the top-level `volumes:`.

- [ ] **Step 3: Scope the web app's CSP to the web app** — replace `deploy/Caddyfile` with

```
{$DATROPE_DOMAIN} {
	encode zstd gzip

	header {
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		X-Frame-Options "DENY"
	}

	@backend path /api/* /ws
	handle @backend {
		# The server sets its own headers, including the strict CSP on file downloads.
		reverse_proxy server:8080
	}

	handle {
		header Content-Security-Policy "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 4: Document file backups** — in `deploy/README.md`, under "Backups", after the database commands, add:

````markdown
Uploaded files live in the `datrope_files` volume. Back them up with:

```bash
docker run --rm -v datrope_files:/data:ro -v "$PWD":/backup alpine tar czf /backup/datrope-files-$(date +%F).tgz -C /data .
```

To restore, run this before starting the server (it keeps the files owned by the server's user):

```bash
docker run --rm -v datrope_files:/data -v "$PWD":/backup alpine sh -c 'tar xzf /backup/datrope-files-YYYY-MM-DD.tgz -C /data && chown -R 65532:65532 /data'
```
````

- [ ] **Step 5: Local dev data dir**

Add `.data/` to `.gitignore`. In the untracked `.claude/launch.json`, add `$env:DATROPE_DATA_DIR='D:\code\datrope\.data';` to the `datrope-server` command before `go -C server run`.

- [ ] **Step 6: Rebuild and run the end-to-end test**

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e up -d --build --wait
pnpm --filter @datrope/web e2e
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.e2e -p datrope-e2e down -v
```

Expected: `1 passed`. Only touch the `datrope-e2e` project; never stop other containers.

- [ ] **Step 7: Checkpoint**

Stop; the controller reviews and stages. Suggested message: `feat(deploy): persistent file storage, e2e upload`

---

## Spec coverage (§7 and milestone 2)

| Spec requirement | Task |
|---|---|
| `POST /api/attachments`, streamed multipart | 5 (`MultipartReader` + `Store.Stage`, no buffering of the whole body) |
| Size limit set by the admin, default 50 MB | 3 (setting, API, validation), 5 (enforced, 413), 8 (admin UI, client pre-check) |
| Server checks `ATTACH_FILES` on the target channel | 5 (upload), 6 (again at send) |
| Stored at `/data/files/<sha256>`, identical uploads share one copy | 1, 5, 9 (volume) |
| Upload returns an ID; the client includes it when sending | 5, 6, 7, 8 |
| Unlinked attachments deleted after 24 h | 5 (`Sweep`, hourly janitor) |
| Images: width/height, thumbnails, EXIF stripped, pure Go | 2, 5 |
| Download checks the user can still view the channel | 5 (`authorized`: `READ_HISTORY` on the channel) |
| `Content-Disposition`, `nosniff`, strict CSP on downloads | 5, 9 (Caddy no longer overrides them) |
| `Store` interface, local disk only | 1 |
| Backups: `pg_dump` plus the data volume (§11) | 9 |
| Tests on real Postgres, Playwright on the Compose stack (§10) | 3–6, 9 |
