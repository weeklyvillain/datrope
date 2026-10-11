# Image Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve every stored image at its display size, as WebP when the browser accepts it. A bundled imgproxy does the resizing, and the Go server caches the results on disk.

**Architecture:** `files.Service` gains a `variants` cache (`server/internal/files/variants.go`). Every image route that ends in `serveBlob`, and attachment downloads, accept `?w=N`. N snaps to a bucket. The server serves `DataDir/variants/<sum>/<bucket>.<webp|orig>`, or asks imgproxy for it (`local://` source on the read-only files volume). Uploads stop making thumbnails. The web client asks for 1x/2x sizes through a `sizedImage` helper.

**Tech Stack:** Go 1.25 (`net/http`, `golang.org/x/sync/singleflight`), imgproxy v4.0.17 (Docker), React 18 + Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-image-proxy-design.md`

## Global Constraints

- Never commit: stage each finished task with `git add` (AGENTS.md section 5; memory "Stage, don't commit").
- Write project files with Bash heredocs or python: the Write and Edit tools are blocked for project files on this machine.
- Run Go tests from PowerShell with `$env:GOTOOLCHAIN='local'` (under Git Bash, testcontainers breaks). Docker Desktop must be running.
- Buckets: `32, 64, 128, 256, 512, 1024, 1600`. Anything above 1600 uses 1600.
- Variant path: `DataDir/variants/<sum>/<bucket>.<webp|orig>`. Temp files go in `DataDir/variants/tmp`.
- imgproxy request: `GET {base}/insecure/rs:fit:B:B:0/plain/local:///<sum>[@webp]`, 30 s timeout.
- Variant ETag: `"<sum>-<bucket>-<fmt>"`. Every response that honoured `w` sets `Vary: Accept`.
- Failed variant: serve the original with `Cache-Control: no-cache`, and never cache the failure.
- Variants exist only for `image/jpeg`, `image/png`, `image/webp`, `image/gif`, and for attachments only when `Inline` is set.
- `thumbnail_url`:
  - imgproxy on: `<url>?w=512` for inline image attachments that are not `/gif` posts.
  - otherwise: `<url>/thumbnail` when the row has a legacy `thumb_sha256`.
  - otherwise omitted.
- Config: `DATROPE_IMGPROXY_URL`. Empty means off, which is the default in dev and in Go tests.
- imgproxy service:
  - image `ghcr.io/imgproxy/imgproxy:v4.0.17`, `user: "65532:65532"`
  - files volume mounted at `/data:ro`, no published ports
  - `IMGPROXY_LOCAL_FILESYSTEM_ROOT=/data/files`, `IMGPROXY_ALLOWED_SOURCES=local://`
  - `IMGPROXY_MAX_SRC_RESOLUTION=40`, `IMGPROXY_MAX_ANIMATION_FRAMES=256`
- Web: the shadcn and token rules still apply. Don't change alt text, labels or other accessible names.

## Review Focus

1. **An imgproxy blip poisons browser caches.** If a failed variant were served as the original under an `immutable` header, the browser would keep the full-size image for a year. The fallback must send `Cache-Control: no-cache` (asserted in Task 1 `TestVariantFallsBackToOriginal`).
2. **A viewer disconnects mid-miss.** When the first requester closes its connection, the shared singleflight request must still finish for the others. This needs `context.WithoutCancel` (Task 1 `TestVariantsShareOneRequest` cancels its first waiter).
3. **imgproxy cannot read the blobs.** Blobs are mode 0600 and owned by uid 65532, so imgproxy must run as 65532. Otherwise every variant fails and quietly falls back to the original. Covered by the compose `user:` line and the manual check in Task 4.
4. **Unauthorised `?w=` on attachments.** A variant must pass the same `authorized` check as the original (Task 2 changes `TestDownloadNeedsChannelAccess` to request `?w=64`).
5. **Off switch.** With `DATROPE_IMGPROXY_URL` unset, `?w=` is ignored and old rows keep `/thumbnail` (Task 1 `TestVariantsOff`, Task 2 `TestLegacyThumbnailStillServed`).

---

### Task 1: Variant cache behind `serveBlob`

**Files:**
- Create: `server/internal/files/variants.go`
- Create: `server/internal/files/export_test.go`
- Create: `server/internal/files/variants_test.go`
- Modify: `server/internal/files/files.go` (Service field, `Sweep`, `removeIfUnused`)
- Modify: `server/internal/files/blobs.go` (`serveBlob`)
- Modify: `server/internal/app/config.go` (Config field + env)
- Modify: `server/internal/app/app.go` (call `SetVariants` right after `files.NewService`)
- Modify: `server/go.mod`/`go.sum` (`go mod tidy` makes `golang.org/x/sync` direct)

**Interfaces:**
- Produces:
  - `func (s *Service) SetVariants(dir, imgproxyURL string) error`
  - `func (s *Service) variantsOn() bool`
  - `func (s *Service) openImage(w http.ResponseWriter, r *http.Request, sum, contentType string) (f io.ReadSeekCloser, ct, etag string, failed bool, err error)`
  - `var variantTypes map[string]bool`
  - `app.Config.ImgproxyURL string`
  - test hook `files.SetVariantTimeout(d time.Duration) (restore func())`

- [ ] **Step 1: Write the failing tests**

`server/internal/files/export_test.go`:

```go
package files

import "time"

// SetVariantTimeout changes the imgproxy timeout for services set up after
// the call; call restore when done. Tests in this package do not run in parallel.
func SetVariantTimeout(d time.Duration) (restore func()) {
	old := variantTimeout
	variantTimeout = d
	return func() { variantTimeout = old }
}
```

`server/internal/files/variants_test.go`:

```go
package files_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/files"
)

// fakeImgproxy answers every request with "variant <path>" as WebP, or 500 while failing.
type fakeImgproxy struct {
	*httptest.Server
	mu    sync.Mutex
	paths []string
	fail  atomic.Bool
	delay atomic.Int64 // nanoseconds
}

func newFakeImgproxy(t *testing.T) *fakeImgproxy {
	f := &fakeImgproxy{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.mu.Unlock()
		time.Sleep(time.Duration(f.delay.Load()))
		if f.fail.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/webp")
		_, _ = io.WriteString(w, "variant "+r.URL.Path)
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *fakeImgproxy) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.paths)
}

func variantEnv(t *testing.T, f *fakeImgproxy) (*apptest.Env, *apptest.Client) {
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.ImgproxyURL = f.URL })
	return env, env.Register("alice")
}

// pageImage uploads a server page image (public, served by serveBlob) and
// returns its URL and content hash. Encoder-made PNGs carry no metadata, so
// cleaning keeps their bytes.
func pageImage(t *testing.T, alice *apptest.Client, img []byte) (url, sum string) {
	raw := alice.UploadTo(http.MethodPost, "/api/server/images", "pic.png", img, http.StatusCreated)
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(raw, &out))
	h := sha256.Sum256(img)
	return out.URL, hex.EncodeToString(h[:])
}

func get(t *testing.T, env *apptest.Env, path, accept string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, env.Server.URL+path, nil)
	require.NoError(t, err)
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return resp, body
}

const browserAccept = "image/avif,image/webp,image/apng,*/*;q=0.8"

func TestVariantsResizeAndCache(t *testing.T) {
	f := newFakeImgproxy(t)
	env, alice := variantEnv(t, f)
	img := pngImage(300, 200, false)
	url, sum := pageImage(t, alice, img)

	resp, body := get(t, env, url+"?w=100", browserAccept)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "variant /insecure/rs:fit:128:128:0/plain/local:///"+sum+"@webp", string(body))
	require.Equal(t, "image/webp", resp.Header.Get("Content-Type"))
	require.Equal(t, "Accept", resp.Header.Get("Vary"))
	require.Equal(t, `"`+sum+`-128-webp"`, resp.Header.Get("ETag"))
	require.Equal(t, "public, max-age=31536000, immutable", resp.Header.Get("Cache-Control"))
	require.FileExists(t, filepath.Join(env.DataDir, "variants", sum, "128.webp"))

	_, again := get(t, env, url+"?w=128", browserAccept)
	require.Equal(t, body, again)
	require.Len(t, f.calls(), 1, "a cached variant makes no imgproxy request")

	resp, body = get(t, env, url+"?w=100", "image/png,*/*")
	require.Equal(t, "variant /insecure/rs:fit:128:128:0/plain/local:///"+sum, string(body), "no WebP unless accepted")
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, `"`+sum+`-128-orig"`, resp.Header.Get("ETag"))

	_, body = get(t, env, url+"?w=5000", browserAccept)
	require.Contains(t, string(body), "rs:fit:1600:1600:0", "widths above the largest bucket use it")

	for _, w := range []string{"abc", "0", "-5", ""} {
		resp, body = get(t, env, url+"?w="+w, browserAccept)
		require.Equal(t, img, body, "w=%q is the original", w)
		require.Empty(t, resp.Header.Get("Vary"))
	}
	require.Len(t, f.calls(), 3)
}

func TestVariantsShareOneRequest(t *testing.T) {
	f := newFakeImgproxy(t)
	f.delay.Store(int64(300 * time.Millisecond))
	env, alice := variantEnv(t, f)
	url, _ := pageImage(t, alice, pngImage(300, 200, false))

	var wg sync.WaitGroup
	bodies := make([]string, 8)
	errs := make([]error, 8)
	for i := range bodies {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if i == 0 { // the first viewer gives up; the others still get the variant
				time.AfterFunc(50*time.Millisecond, cancel)
			}
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, env.Server.URL+url+"?w=64", nil)
			req.Header.Set("Accept", browserAccept)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				errs[i] = err
				return
			}
			defer resp.Body.Close()
			b, err := io.ReadAll(resp.Body)
			bodies[i], errs[i] = string(b), err
		}()
	}
	wg.Wait()
	for i := 1; i < len(bodies); i++ {
		require.NoError(t, errs[i])
		require.Contains(t, bodies[i], "rs:fit:64:64:0")
	}
	require.Len(t, f.calls(), 1, "concurrent misses share one imgproxy request")
}

func TestVariantFallsBackToOriginal(t *testing.T) {
	f := newFakeImgproxy(t)
	f.fail.Store(true)
	env, alice := variantEnv(t, f)
	img := pngImage(300, 200, false)
	url, sum := pageImage(t, alice, img)

	resp, body := get(t, env, url+"?w=64", browserAccept)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, img, body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "no-cache", resp.Header.Get("Cache-Control"), "browsers must not keep the original under this URL")
	require.Equal(t, "Accept", resp.Header.Get("Vary"))
	require.NoFileExists(t, filepath.Join(env.DataDir, "variants", sum, "64.webp"))

	f.fail.Store(false)
	_, body = get(t, env, url+"?w=64", browserAccept)
	require.Contains(t, string(body), "variant ", "failures are not cached")
}

func TestVariantTimeout(t *testing.T) {
	defer files.SetVariantTimeout(100 * time.Millisecond)()
	f := newFakeImgproxy(t)
	f.delay.Store(int64(time.Second))
	env, alice := variantEnv(t, f)
	img := pngImage(300, 200, false)
	url, _ := pageImage(t, alice, img)

	resp, body := get(t, env, url+"?w=64", browserAccept)
	require.Equal(t, img, body)
	require.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
}

func TestVariantsOff(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	img := pngImage(300, 200, false)
	url, _ := pageImage(t, alice, img)
	resp, body := get(t, env, url+"?w=64", browserAccept)
	require.Equal(t, img, body)
	require.Empty(t, resp.Header.Get("Vary"))
}

func TestVariantsRemovedWithBlob(t *testing.T) {
	f := newFakeImgproxy(t)
	env, alice := variantEnv(t, f)
	url, sum := pageImage(t, alice, pngImage(300, 200, false))
	get(t, env, url+"?w=64", browserAccept)
	require.DirExists(t, filepath.Join(env.DataDir, "variants", sum))

	_, err := env.Pool.Exec(context.Background(), `DELETE FROM server_images`)
	require.NoError(t, err)
	backdateBlobs(t, env)
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	_, err = os.Stat(filepath.Join(env.DataDir, "variants", sum))
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestSweepRemovesStaleVariantTemp(t *testing.T) {
	f := newFakeImgproxy(t)
	env, _ := variantEnv(t, f)
	stale := filepath.Join(env.DataDir, "variants", "tmp", "variant-123")
	require.NoError(t, os.WriteFile(stale, []byte("partial"), 0o600))
	old := time.Now().Add(-2 * time.Hour)
	require.NoError(t, os.Chtimes(stale, old, old))
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	require.NoFileExists(t, stale)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run (PowerShell, from `server/`): `$env:GOTOOLCHAIN='local'; go test ./internal/files/ -run 'Variant'`
Expected: build failure: `c.ImgproxyURL undefined`, `variantTimeout undefined`.

- [ ] **Step 3: Implement**

`server/internal/app/config.go`: in `Config`, after `SevenTVURL`:

```go
	ImgproxyURL string // imgproxy's base URL for resized images; "" serves originals only
```

In `ConfigFromEnv`'s literal, after `DataDir`:

```go
		ImgproxyURL: strings.TrimSuffix(os.Getenv("DATROPE_IMGPROXY_URL"), "/"),
```

`server/internal/app/app.go`, directly after `filesSvc = files.NewService(pool, store, chanSvc, authSvc)`:

```go
		if err := filesSvc.SetVariants(filepath.Join(cfg.DataDir, "variants"), cfg.ImgproxyURL); err != nil {
			panic(fmt.Errorf("files: cannot use %s: %w", cfg.DataDir, err)) // startup misconfiguration
		}
```

`server/internal/files/files.go`: in `Service`, after `imageSlots`:

```go
	variants   *variants // resized copies of images; nil until SetVariants
```

In `removeIfUnused`, inside `if !used { ... }`, after the `s.store.Remove(sum)` error check, add:

```go
		if err := s.variants.remove(sum); err != nil {
			return err
		}
```

In `Sweep`, replace the final `return s.store.RemoveStaleTemp(now.Add(-time.Hour))` with:

```go
	if err := s.variants.removeStaleTemp(now.Add(-time.Hour)); err != nil {
		return err
	}
	return s.store.RemoveStaleTemp(now.Add(-time.Hour))
```

`server/internal/files/variants.go`:

```go
package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

// variantBuckets are the sizes clients may ask for with ?w=. A variant fits
// in bucket x bucket; fixed sizes keep the cache small and stop anyone
// requesting every width.
var variantBuckets = []int{32, 64, 128, 256, 512, 1024, 1600}

// variantTimeout bounds one imgproxy request (a variable for tests).
var variantTimeout = 30 * time.Second

// variantTypes are the stored image types imgproxy resizes.
var variantTypes = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true}

// bucket snaps a requested width up to a bucket; ok is false for a missing or invalid one.
func bucket(raw string) (int, bool) {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, false
	}
	for _, b := range variantBuckets {
		if n <= b {
			return b, true
		}
	}
	return variantBuckets[len(variantBuckets)-1], true
}

// variants makes resized copies of stored images with imgproxy and keeps
// them in dir/<sum>/<bucket>.<webp|orig>.
type variants struct {
	dir      string
	upstream string // imgproxy's base URL; "" turns variants off
	client   *http.Client
	slots    chan struct{} // bounds concurrent imgproxy requests
	group    singleflight.Group
}

// variant is a cached resized copy, ready to serve.
type variant struct{ path, contentType, etag string }

// SetVariants keeps resized images under dir, made by the imgproxy at
// imgproxyURL. With "" originals are served, but dir is still cleaned up.
func (s *Service) SetVariants(dir, imgproxyURL string) error {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return err
	}
	s.variants = &variants{
		dir:      dir,
		upstream: strings.TrimSuffix(imgproxyURL, "/"),
		client:   &http.Client{Timeout: variantTimeout},
		slots:    make(chan struct{}, runtime.GOMAXPROCS(0)),
	}
	return nil
}

func (s *Service) variantsOn() bool { return s.variants != nil && s.variants.upstream != "" }

// variantFor returns the variant of a stored image that r asks for with ?w=.
// asked is false when r asks for none (or variants are off); v is nil when
// one was asked for but could not be made.
func (s *Service) variantFor(r *http.Request, sum, contentType string) (v *variant, asked bool) {
	if !s.variantsOn() || !variantTypes[contentType] || !ValidSum(sum) {
		return nil, false
	}
	b, ok := bucket(r.URL.Query().Get("w"))
	if !ok {
		return nil, false
	}
	format, ct := "orig", contentType
	if strings.Contains(r.Header.Get("Accept"), "image/webp") {
		format, ct = "webp", "image/webp"
	}
	vs := s.variants
	out := &variant{
		path:        filepath.Join(vs.dir, sum, strconv.Itoa(b)+"."+format),
		contentType: ct,
		etag:        fmt.Sprintf(`"%s-%d-%s"`, sum, b, format),
	}
	if _, err := os.Stat(out.path); err == nil {
		return out, true
	}
	// Shared by everyone waiting on this variant, so one viewer leaving does not cancel it.
	ctx := context.WithoutCancel(r.Context())
	_, err, _ := vs.group.Do(out.path, func() (any, error) { return nil, vs.make(ctx, sum, b, format, out.path) })
	if err != nil {
		slog.InfoContext(ctx, "files: serving the original image", "sum", sum, "w", b, "err", err)
		return nil, true
	}
	return out, true
}

// make asks imgproxy for a variant and stores it at dst.
func (vs *variants) make(ctx context.Context, sum string, b int, format, dst string) error {
	if _, err := os.Stat(dst); err == nil {
		return nil // made while this request waited
	}
	vs.slots <- struct{}{}
	defer func() { <-vs.slots }()
	src := "local:///" + sum
	if format == "webp" {
		src += "@webp"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/insecure/rs:fit:%d:%d:0/plain/%s", vs.upstream, b, b, src), nil)
	if err != nil {
		return err
	}
	resp, err := vs.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("imgproxy: %s", resp.Status)
	}
	f, err := os.CreateTemp(filepath.Join(vs.dir, "tmp"), "variant-*")
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, maxImageBytes+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	switch {
	case err != nil:
	case n == 0:
		err = errors.New("imgproxy: empty response")
	case n > maxImageBytes:
		err = ErrTooLarge
	default:
		if err = os.MkdirAll(filepath.Dir(dst), 0o750); err == nil {
			err = os.Rename(f.Name(), dst)
		}
	}
	if err != nil {
		_ = os.Remove(f.Name())
	}
	return err
}

// remove deletes a blob's variants. It is safe on a nil receiver.
func (vs *variants) remove(sum string) error {
	if vs == nil || !ValidSum(sum) {
		return nil
	}
	return os.RemoveAll(filepath.Join(vs.dir, sum))
}

// removeStaleTemp deletes partial variants left by crashes. It is safe on a nil receiver.
func (vs *variants) removeStaleTemp(before time.Time) error {
	if vs == nil {
		return nil
	}
	tmp := filepath.Join(vs.dir, "tmp")
	entries, err := os.ReadDir(tmp)
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(before) {
			continue // removed meanwhile, or still being written
		}
		if err := os.Remove(filepath.Join(tmp, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// openImage opens a stored image, or the variant of it that r asks for with
// ?w=, and sets Vary when the response depends on Accept. It returns the
// Content-Type and ETag to serve; failed means a variant was asked for but
// the original is served instead.
func (s *Service) openImage(w http.ResponseWriter, r *http.Request, sum, contentType string) (f io.ReadSeekCloser, ct, etag string, failed bool, err error) {
	v, asked := s.variantFor(r, sum, contentType)
	if asked {
		w.Header().Set("Vary", "Accept")
	}
	if v != nil {
		if vf, err := os.Open(v.path); err == nil {
			return vf, v.contentType, v.etag, false, nil
		} // removed meanwhile: serve the original
	}
	f, err = s.store.Open(sum)
	return f, contentType, `"` + sum + `"`, asked, err
}
```

`server/internal/files/blobs.go`: replace `serveBlob` with:

```go
func (s *Service) serveBlob(w http.ResponseWriter, r *http.Request, sum, contentType, cacheControl string) {
	f, ct, etag, failed, err := s.openImage(w, r, sum, contentType)
	if errors.Is(err, os.ErrNotExist) {
		httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
		return
	}
	if err != nil {
		httpx.WriteHTTPError(w, r, err)
		return
	}
	defer f.Close()
	if failed {
		cacheControl = "no-cache" // a later request may get the small copy
	}
	h := w.Header()
	h.Set("Content-Type", ct)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", cacheControl)
	h.Set("ETag", etag)
	http.ServeContent(w, r, "", time.Time{}, f)
}
```

Then, from `server/`: `go mod tidy`. This moves `golang.org/x/sync` into the direct `require` block.

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:GOTOOLCHAIN='local'; go vet ./... ; go test ./internal/files/ ./internal/app/ ./internal/auth/ ./internal/expressions/ ./internal/communities/`
Expected: PASS. Existing avatar, emoji and server-image tests behave as before, because `apptest.New` leaves variants off.

- [ ] **Step 5: Stage**

```bash
git add server/internal/files/variants.go server/internal/files/variants_test.go server/internal/files/export_test.go server/internal/files/files.go server/internal/files/blobs.go server/internal/app/config.go server/internal/app/app.go server/go.mod server/go.sum
```

---

### Task 2: Attachments: variants, and no more upload-time thumbnails

**Files:**
- Modify: `server/internal/files/files.go` (`setURLs`, `scanAttachment`, `get`, `save`, `processImage`)
- Modify: `server/internal/files/claim.go` (two `scanAttachment` calls)
- Modify: `server/internal/files/handlers.go` (`download`)
- Modify: `server/internal/files/imageproc.go` (delete `ThumbMax`, `Thumbnail`, `fit`)
- Modify tests: `server/internal/files/files_test.go`, `imageproc_test.go`, `strip_test.go`, `variants_test.go`

**Interfaces:**
- Consumes: `s.variantsOn()`, `s.openImage(...)` and `variantTypes` from Task 1.
- Produces:
  - `func (a *Attachment) setURLs(variants bool)`
  - `func scanAttachment(row pgx.Row, variants bool) (*Attachment, error)`
  - `func (s *Service) processImage(kind Kind, a *Attachment, staged **Staged) error`

- [ ] **Step 1: Write the failing tests**

Append to `server/internal/files/variants_test.go`:

```go
func TestAttachmentVariants(t *testing.T) {
	f := newFakeImgproxy(t)
	env, alice := variantEnv(t, f)
	ch := alice.General()
	alice.Header = http.Header{"Accept": {browserAccept}}

	img := pngImage(1000, 500, false)
	a := alice.Upload(ch, "wide.png", img, http.StatusCreated)
	require.Equal(t, a.URL+"?w=512", a.ThumbnailURL)
	h := sha256.Sum256(img)
	resp, body := alice.Raw(http.MethodGet, a.ThumbnailURL, nil, "", http.StatusOK)
	require.Equal(t, "variant /insecure/rs:fit:512:512:0/plain/local:///"+hex.EncodeToString(h[:])+"@webp", string(body))
	require.Equal(t, "image/webp", resp.Header.Get("Content-Type"))
	require.Equal(t, "inline; filename=wide.png", resp.Header.Get("Content-Disposition"))
	require.Equal(t, "private, max-age=86400", resp.Header.Get("Cache-Control"))
	require.Equal(t, "Accept", resp.Header.Get("Vary"))

	small := alice.Upload(ch, "small.png", pngImage(10, 10, false), http.StatusCreated)
	require.Equal(t, small.URL+"?w=512", small.ThumbnailURL, "imgproxy never enlarges, so small images get one too")

	txt := alice.Upload(ch, "notes.txt", []byte("draft"), http.StatusCreated)
	require.Empty(t, txt.ThumbnailURL)
	_, body = alice.Raw(http.MethodGet, txt.URL+"?w=64", nil, "", http.StatusOK)
	require.Equal(t, "draft", string(body), "non-images ignore w")

	huge := alice.Upload(ch, "huge.png", pngClaiming(7000, 6000), http.StatusCreated)
	require.Empty(t, huge.ThumbnailURL)
	resp, _ = alice.Raw(http.MethodGet, huge.URL+"?w=64", nil, "", http.StatusOK)
	require.Equal(t, "application/octet-stream", resp.Header.Get("Content-Type"), "downloads are never resized")

	require.Len(t, f.calls(), 1)
	require.Equal(t, 4, blobCount(t, env), "four uploads, no thumbnail blobs")
}
```

In `server/internal/files/files_test.go`, replace `TestThumbnails` with:

```go
func TestNoThumbnailsWithoutImgproxy(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "wide.png", pngImage(1000, 500, false), http.StatusCreated)
	require.Empty(t, a.ThumbnailURL, "uploads no longer get thumbnails; clients show the original")
	require.Equal(t, 1, blobCount(t, env))
	_, raw := alice.Raw(http.MethodGet, a.URL+"/thumbnail", nil, "", http.StatusNotFound)
	require.Equal(t, "NOT_FOUND", errorCode(t, raw))
}

func TestLegacyThumbnailStillServed(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	img := pngImage(1000, 500, false)
	a := alice.Upload(ch, "wide.png", img, http.StatusCreated)
	// Rows from before on-demand variants have a thumbnail blob; point this one at its own file.
	_, err := env.Pool.Exec(context.Background(), `UPDATE attachments SET thumb_sha256 = sha256 WHERE id = $1`, a.ID)
	require.NoError(t, err)
	resp, body := alice.Raw(http.MethodGet, a.URL+"/thumbnail", nil, "", http.StatusOK)
	require.Equal(t, img, body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
}
```

Also in `files_test.go`:
- `TestUploadAndDownloadImage`: change the message `"small images need no thumbnail"` to `"no thumbnails without imgproxy"`.
- `TestSweepKeepsAgedBlobsStillReferenced`:
  - change the comment `// file + thumbnail` to `// one blob`;
  - change `require.Equal(t, 2, blobCount(t, env))` to `1`;
  - delete the line `alice.Raw(http.MethodGet, a.ThumbnailURL, nil, "", http.StatusOK)`.
- `TestSweepRemovesAgedOrphanBlobs`: change both `2` counts to `1`.
- `TestDownloadNeedsChannelAccess`:
  - delete `require.NotEmpty(t, a.ThumbnailURL)`;
  - in `can`, replace `u.Raw(http.MethodGet, a.ThumbnailURL, nil, "", want)` with `u.Raw(http.MethodGet, a.URL+"?w=64", nil, "", want)`.
- Remove any imports `go vet` reports unused (likely `bytes`, `image/jpeg`, `image/png`).

In `imageproc_test.go`, delete `TestThumbnail`. In `strip_test.go`, delete `TestThumbnailRejectsDecompressionBomb`, and delete the line `_, _ = files.Thumbnail(kind, data[:n])` in `TestHostileInputsDoNotPanic`. In both files, drop the imports `go vet` reports unused.

- [ ] **Step 2: Run tests to verify they fail**

Run (PowerShell, `server/`): `$env:GOTOOLCHAIN='local'; go test ./internal/files/`
Expected: FAIL. `TestAttachmentVariants` gets an empty `ThumbnailURL`, `TestNoThumbnailsWithoutImgproxy` gets `.../thumbnail`, and the blob counts are off by the thumbnail.

- [ ] **Step 3: Implement**

`files.go`, replace `setURLs`:

```go
// setURLs fills the URLs. With variants on, inline images get a resized
// thumbnail; otherwise only rows from before that keep their stored one.
func (a *Attachment) setURLs(variants bool) {
	a.URL = "/api/attachments/" + a.ID.String()
	switch {
	case variants && a.Inline && !a.GIF && variantTypes[a.ContentType]:
		a.ThumbnailURL = a.URL + "?w=512"
	case a.thumbSum != "":
		a.ThumbnailURL = a.URL + "/thumbnail"
	}
}
```

Change `func scanAttachment(row pgx.Row) (*Attachment, error)` to `func scanAttachment(row pgx.Row, variants bool) (*Attachment, error)`, and its `a.setURLs()` call to `a.setURLs(variants)`. Update the callers: `get` passes `s.variantsOn()`, and both calls in `claim.go` become `scanAttachment(rows, s.variantsOn())`.

Replace `save` with:

```go
// save processes a staged upload and records it. Images get their metadata
// stripped and their size measured.
func (s *Service) save(ctx context.Context, channelID, uploaderID id.ID, filename string, staged *Staged, gif *gifSize) (*Attachment, error) {
	defer func() { s.store.Discard(staged) }() // reads staged at return: processImage swaps it; a no-op once committed

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
		select {
		case s.imageSlots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		err := func() error {
			defer func() { <-s.imageSlots }() // released even if a decoder panics
			return s.processImage(kind, a, &staged)
		}()
		if err != nil {
			slog.InfoContext(ctx, "files: keeping image as a plain file", "attachment_id", a.ID, "err", err)
		}
	}
	if gif != nil {
		a.GIF = true
		if a.Width == nil && gif.width > 0 && gif.height > 0 {
			a.Width, a.Height = &gif.width, &gif.height
		}
	}
	a.Size, a.sum = staged.Size, staged.Sum

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, a.sum); err != nil {
		return nil, err
	}
	if err := s.store.Commit(staged); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, sha256, width, height, inline, gif)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		a.ID, a.ChannelID, uploaderID, a.Filename, a.ContentType, a.Size, a.sum, a.Width, a.Height, a.Inline, a.GIF); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	a.setURLs(s.variantsOn())
	return a, nil
}
```

Replace `processImage` with:

```go
// processImage swaps *staged for a metadata-free copy and records the
// image's size. On error nothing changes and the upload is kept as a plain file.
func (s *Service) processImage(kind Kind, a *Attachment, staged **Staged) error {
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
	cleaned, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return err
	}
	s.store.Discard(*staged)
	*staged = cleaned
	a.Width, a.Height, a.Inline = &w, &h, showable(kind, w, h)
	return nil
}
```

`handlers.go` `download`: replace everything from `f, err := s.store.Open(sum)` to the end of the function with:

```go
	var f io.ReadSeekCloser
	etag, failed := `"`+sum+`"`, false
	if thumbnail || !a.Inline {
		f, err = s.store.Open(sum)
	} else {
		f, ct, etag, failed, err = s.openImage(w, r, sum, ct)
	}
	if errors.Is(err, os.ErrNotExist) {
		return httpx.NotFound("attachment")
	}
	if err != nil {
		return err
	}
	defer f.Close()
	if thumbnail { // legacy thumbnails are JPEG or PNG; tell them apart by content
		head := make([]byte, 512)
		n, _ := io.ReadFull(f, head)
		ct = http.DetectContentType(head[:n])
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
	}
	cache := "private, max-age=86400"
	if failed {
		cache = "no-cache" // a later request may get the small copy
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
	h.Set("Cache-Control", cache)
	h.Set("ETag", etag)
	http.ServeContent(w, r, "", time.Time{}, f)
	return nil
}
```

`imageproc.go`: delete the `ThumbMax` constant, `Thumbnail` and `fit`. Change the `"image/png"` import to `_ "image/png" // registers the PNG decoder`, because `Info` needs it. Drop the `golang.org/x/image/draw` import (`gifcrop.go` imports its own).

- [ ] **Step 4: Run tests to verify they pass**

Run: `$env:GOTOOLCHAIN='local'; go vet ./... ; go test ./...`
Expected: PASS in every package. The messages, gifs and webhooks tests also use attachments.

- [ ] **Step 5: Stage**

```bash
git add server/internal/files
```

---

### Task 3: Web client asks for sized images

All paths are under `clients/web/src/`.

**Files:**
- Create: `lib/sized-image.ts`, `lib/sized-image.test.ts`
- Modify: `components/user-avatar.tsx`, `components/webhook-avatar.tsx`, `components/role-icon.tsx`, `components/logo.tsx`
- Modify: `app/MessageList.tsx` (`ImageLink`), `app/attachments/ImageViewer.tsx`, `app/gallery/GalleryView.tsx`, `app/gallery/GalleryItemPanel.tsx`, `app/gallery/UploadDialog.tsx`
- Modify: `chat/Markdown.tsx`, `chat/remarkChat.ts`, `chat/EmojiText.tsx`, `chat/EmojiPicker.tsx`, `chat/AutocompleteList.tsx`, `chat/Reactions.tsx`, `chat/PollCard.tsx`, `app/server-settings/Emoji.tsx`
- Modify: `app/people/ProfileCard.tsx`, `app/settings/ProfileSettings.tsx`, `app/server-settings/Look.tsx`, `app/welcome/WelcomeView.tsx`
- Modify: `app/voice/MusicBits.tsx` (`Cover`), `app/voice/MusicTile.tsx`, `app/WebhookEmbed.tsx`

**Interfaces:**
- Consumes: the server's `?w=` and a `thumbnail_url` containing `?w=` (Tasks 1–2).
- Produces:
  - `sizedImage(path: string, cssPx: number): { src: string; srcSet?: string }`
  - `attachmentImage(a: Pick<Attachment, "url" | "thumbnail_url">, cssPx: number): { src: string; srcSet?: string }`

- [ ] **Step 1: Write the failing test**

`clients/web/src/lib/sized-image.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/session", () => ({ client: { url: (p: string) => `https://chat.test${p}` } }));

import { attachmentImage, sizedImage } from "./sized-image";

describe("sizedImage", () => {
  it("asks for the 1x and 2x buckets", () => {
    expect(sizedImage("/api/avatars/1", 40)).toEqual({
      src: "https://chat.test/api/avatars/1?w=64",
      srcSet: "https://chat.test/api/avatars/1?w=64 1x, https://chat.test/api/avatars/1?w=128 2x",
    });
  });

  it("appends to an existing query", () => {
    expect(sizedImage("/api/avatars/1?v=abc", 32).src).toBe("https://chat.test/api/avatars/1?v=abc&w=32");
  });

  it("drops the 2x candidate when both hit the largest bucket", () => {
    expect(sizedImage("/api/server/banner", 2000)).toEqual({ src: "https://chat.test/api/server/banner?w=1600" });
  });

  it("passes other URLs through", () => {
    expect(sizedImage("https://i.scdn.co/image/x", 40)).toEqual({ src: "https://i.scdn.co/image/x" });
    expect(sizedImage("blob:abc", 40)).toEqual({ src: "blob:abc" });
  });
});

describe("attachmentImage", () => {
  it("resizes when the server makes variants", () => {
    expect(attachmentImage({ url: "/api/attachments/9", thumbnail_url: "/api/attachments/9?w=512" }, 56).src)
      .toBe("https://chat.test/api/attachments/9?w=64");
  });

  it("uses a legacy thumbnail or the original otherwise", () => {
    expect(attachmentImage({ url: "/api/attachments/9", thumbnail_url: "/api/attachments/9/thumbnail" }, 56))
      .toEqual({ src: "https://chat.test/api/attachments/9/thumbnail" });
    expect(attachmentImage({ url: "/api/attachments/9" }, 56)).toEqual({ src: "https://chat.test/api/attachments/9" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `clients/web`): `pnpm vitest run src/lib/sized-image.test.ts`
Expected: FAIL: cannot resolve `./sized-image`.

- [ ] **Step 3: Implement the helper**

`clients/web/src/lib/sized-image.ts`:

```ts
import type { Attachment } from "@datrope/core";
import { client } from "@/session";

/** Sizes the server resizes images to with ?w= (variantBuckets in server/internal/files/variants.go). */
const BUCKETS = [32, 64, 128, 256, 512, 1024, 1600];

const bucket = (px: number) => BUCKETS.find((b) => b >= px) ?? BUCKETS[BUCKETS.length - 1];
const withWidth = (path: string, px: number) => `${path}${path.includes("?") ? "&" : "?"}w=${bucket(px)}`;

/** `src` and `srcSet` for a server image shown at most `cssPx` wide and tall: the server sends a
 *  copy that size, and twice that for HiDPI screens. Other URLs pass through unchanged. */
export function sizedImage(path: string, cssPx: number): { src: string; srcSet?: string } {
  if (!path.startsWith("/api/")) return { src: path };
  const one = client.url(withWidth(path, cssPx));
  const two = client.url(withWidth(path, cssPx * 2));
  return one === two ? { src: one } : { src: one, srcSet: `${one} 1x, ${two} 2x` };
}

/** sizedImage for an image attachment when the server makes resized copies (its thumbnail_url
 *  asks for a width); otherwise its stored thumbnail or the original. */
export function attachmentImage(a: Pick<Attachment, "url" | "thumbnail_url">, cssPx: number): { src: string; srcSet?: string } {
  if (a.thumbnail_url?.includes("?w=")) return sizedImage(a.url, cssPx);
  return { src: client.url(a.thumbnail_url || a.url) };
}
```

Run the test again. Expected: PASS.

- [ ] **Step 4: Use it at the call sites**

At each site, replace the `src` prop with the helper's result spread into the element (`<img {...sizedImage(path, px)} …/>`). Leave the other props as they are. Call `sizedImage` only inside the guards that already check the path is set. Remove `client` imports that become unused.

| File | Change |
|---|---|
| `components/user-avatar.tsx` | add `const px: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 32, lg: 40, xl: 80 };` and render `<AvatarImage {...sizedImage(user.avatar_url, px[size])} alt="" />` |
| `components/webhook-avatar.tsx` | same local `px` map; `<AvatarImage {...sizedImage(avatarUrl, px[size])} alt="" />` |
| `components/role-icon.tsx` | `{...sizedImage(role.icon_url, 24)}` and `{...sizedImage(custom.url, 24)}` |
| `components/logo.tsx` | `ServerIconImage` gets an optional `srcSet?: string` prop and passes it to its `<img>`; `ServerIcon` computes `const img = icon ? sizedImage(icon, size) : undefined;` and passes `src={img?.src} srcSet={img?.srcSet}` |
| `app/MessageList.tsx` `ImageLink` | replace `src={client.url(a.thumbnail_url \|\| a.url)}` with `{...attachmentImage(a, Math.max(width ?? 240, height ?? 240))}`. Single images get width/height from `fitBox`; grid tiles are about 240 px in the 480 px row. Keep the `<a href={client.url(a.url)}>` |
| `app/attachments/ImageViewer.tsx` filmstrip `<img>` (line ~125) | `{...attachmentImage(img, 56)}`; the full view at line ~103 is unchanged |
| `app/gallery/GalleryView.tsx` tile `<img>` | `{...attachmentImage(a, 240)}` |
| `app/gallery/GalleryItemPanel.tsx` `<img>` | `{...attachmentImage(attachment, 512)}` |
| `app/gallery/UploadDialog.tsx` image branch (line ~81) | `{...attachmentImage(a, 48)}`; the video thumbnail branch is unchanged |
| `chat/Markdown.tsx` (`custom: new Map(...)`, line ~106) | map each emoji to `[e.name.toLowerCase(), { id: e.id, url: img.src, srcSet: img.srcSet }]` with `const img = sizedImage(e.url, 32)` |
| `chat/remarkChat.ts` | the `custom` value type becomes `{ id: string; url: string; srcSet?: string }`; the emoji `hProperties` gains `...(custom.srcSet && { srcSet: custom.srcSet })` |
| `chat/EmojiText.tsx` | `{...sizedImage(custom.url, 32)}` |
| `chat/EmojiPicker.tsx` | category icon `{...sizedImage(server[0].url, 20)}`, grid `{...sizedImage(e.url, 28)}` |
| `chat/AutocompleteList.tsx` | `{...sizedImage(e.url, 24)}` |
| `chat/Reactions.tsx` | `{...sizedImage(emoji.url, 16)}` |
| `chat/PollCard.tsx` | `{...sizedImage(custom.url, 20)}` |
| `app/server-settings/Emoji.tsx` table `<img>` (line ~166) | `{...sizedImage(e.url, 32)}`; the upload preview tiles (line ~119) show local files and are unchanged |
| `app/people/ProfileCard.tsx`, `app/settings/ProfileSettings.tsx` banner | `{...sizedImage(user.banner_url, 512)}` / `{...sizedImage(me.banner_url, 512)}` |
| `app/server-settings/Look.tsx` banner preview | `{...sizedImage(url, 512)}` |
| `app/welcome/WelcomeView.tsx` banner | `{...sizedImage(banner, 1024)}` |
| `app/voice/MusicBits.tsx` `Cover` | `{...sizedImage(src, 48)}` |
| `app/voice/MusicTile.tsx` (both cover `<img>`s) | `{...sizedImage(cur.cover, 80)}` |
| `app/WebhookEmbed.tsx` | author icon `24`, thumbnail `80`, image `512`, footer icon `20` |

- [ ] **Step 5: Verify**

Run from `clients/web`: `pnpm vitest run`, then `pnpm exec tsc --noEmit -p .`. Run `pnpm lint` from the repo root.
Expected: all pass. A remarkChat or Markdown test that compares `hProperties` exactly should still pass, because `srcSet` is added only when it is set. If one fails anyway, add `srcSet` to its expected object.

- [ ] **Step 6: Stage**

```bash
git add clients/web/src
```

---

### Task 4: Bundle imgproxy in the deploy stack

**Files:**
- Modify: `deploy/docker-compose.yml`
- Modify: `deploy/README.md` (new "Images" section; backup note)
- Modify: `README.md` ("Easy to run" bullet)

- [ ] **Step 1: Add the service and server env**

In `deploy/docker-compose.yml`, add this to `server.environment`:

```yaml
      DATROPE_IMGPROXY_URL: http://imgproxy:8080
```

Add a new service after `server`:

```yaml
  # Resizes stored images for the server (avatars, emoji, attachments, ...). Not reachable from outside.
  imgproxy:
    image: ghcr.io/imgproxy/imgproxy:v4.0.17
    restart: unless-stopped
    user: "65532:65532" # the server's user: stored files are readable by it only
    environment:
      IMGPROXY_LOCAL_FILESYSTEM_ROOT: /data/files
      IMGPROXY_ALLOWED_SOURCES: local://
      IMGPROXY_MAX_SRC_RESOLUTION: "40"
      IMGPROXY_MAX_ANIMATION_FRAMES: "256"
    volumes:
      - files:/data:ro
```

Don't add `depends_on`: the server serves originals while imgproxy is down.

- [ ] **Step 2: Document**

In `deploy/README.md`, add this section before the backup section:

```markdown
## Images

The `imgproxy` container resizes stored images (avatars, emoji, banners, attachments) to the size
clients show them, as WebP when the browser supports it. The server keeps each resized copy in
`/data/variants` on the files volume and deletes it along with the original. The copies can always
be made again, so backups may skip `variants/`. While imgproxy is down, the server serves the
originals. To turn resizing off, remove `DATROPE_IMGPROXY_URL` from the server's environment.
```

After the backup `tar czf` command, add the line: ``Add `--exclude=./variants` to skip the resized copies.``

In `README.md`, change "the Go server, Postgres, [LiveKit](https://livekit.io) for calls, and Caddy for HTTPS" to "the Go server, Postgres, [LiveKit](https://livekit.io) for calls, imgproxy for resizing images, and Caddy for HTTPS".

- [ ] **Step 3: Validate the compose file**

Run (Git Bash, repo root): `POSTGRES_PASSWORD=x DATROPE_DOMAIN=localhost LIVEKIT_API_SECRET=x docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.e2e.yml config --quiet && echo ok`
Expected: `ok`.

- [ ] **Step 4: Manual end-to-end check**

This needs Docker. Follow the e2e notes in memory "Local dev environment": the port override files, `down -v` first, then `up -d --build --wait`.

1. Start the stack as project `datrope-e2e`. Register a user, then upload an avatar and a large PNG attachment.
2. Run `docker compose -p datrope-e2e logs imgproxy` and confirm there are no permission or "can't read" errors.
3. Use a throwaway Playwright script (`ignoreHTTPSErrors`, `NODE_PATH=D:/code/datrope/node_modules`) to check two things:
   - the avatar request has `?w=`, and its response is `image/webp` and smaller than the original;
   - the attachment thumbnail is `image/webp` and at most 512 px wide.
4. Upload an animated GIF as a plain file. Its `?w=512` response must be an animated WebP (the bytes contain an `ANIM` chunk).
5. Run `docker compose -p datrope-e2e exec server ls /data/variants`: expect one directory per resized blob, plus `tmp`.
6. Run `docker compose -p datrope-e2e stop imgproxy`, then request a width not cached yet. Expect the original, with `Cache-Control: no-cache`.
7. Run `down -v`.

- [ ] **Step 5: Stage**

```bash
git add deploy/docker-compose.yml deploy/README.md README.md
```
