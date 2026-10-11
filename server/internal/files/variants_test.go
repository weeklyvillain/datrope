package files_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/color"
	"image/gif"
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

	"github.com/stretchr/testify/assert"
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

func TestSweepWithoutVariantTemp(t *testing.T) {
	f := newFakeImgproxy(t)
	env, _ := variantEnv(t, f)
	require.NoError(t, os.RemoveAll(filepath.Join(env.DataDir, "variants")))
	stale := filepath.Join(env.DataDir, "files", "tmp", "upload-123")
	require.NoError(t, os.WriteFile(stale, []byte("partial"), 0o600))
	old := time.Now().Add(-2 * time.Hour)
	require.NoError(t, os.Chtimes(stale, old, old))
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	require.NoFileExists(t, stale, "the blob store's temp files are still cleaned up")
}

func TestVariantDeadlineCoversSlotWait(t *testing.T) {
	defer files.SetVariantTimeout(300 * time.Millisecond)()
	defer files.SetVariantSlots(1)()
	f := newFakeImgproxy(t)
	f.delay.Store(int64(2 * time.Second))
	env, alice := variantEnv(t, f)
	urls := make([]string, 6)
	imgs := make([][]byte, len(urls))
	for i := range urls {
		imgs[i] = pngImage(300+i, 200, false)
		urls[i], _ = pageImage(t, alice, imgs[i])
	}

	start := time.Now()
	var wg sync.WaitGroup
	for i := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			resp, body := get(t, env, urls[i]+"?w=64", browserAccept)
			assert.Equal(t, imgs[i], body)
			assert.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
			assert.Less(t, time.Since(start), time.Second, "waiting for a slot counts against the deadline")
		}()
	}
	wg.Wait()
}

// animatedGIF is a 2x2 GIF with n frames.
func animatedGIF(t *testing.T, n int) []byte {
	g := &gif.GIF{}
	for range n {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White}))
		g.Delay = append(g.Delay, 2)
	}
	var buf bytes.Buffer
	require.NoError(t, gif.EncodeAll(&buf, g))
	return buf.Bytes()
}

func TestLongGIFsAreNotResized(t *testing.T) {
	f := newFakeImgproxy(t)
	_, alice := variantEnv(t, f)
	ch := alice.General()
	alice.Header = http.Header{"Accept": {browserAccept}}

	short := alice.Upload(ch, "short.gif", animatedGIF(t, 256), http.StatusCreated)
	_, body := alice.Raw(http.MethodGet, short.URL+"?w=64", nil, "", http.StatusOK)
	require.Contains(t, string(body), "variant ")

	long := animatedGIF(t, 257)
	a := alice.Upload(ch, "long.gif", long, http.StatusCreated)
	resp, body := alice.Raw(http.MethodGet, a.URL+"?w=64", nil, "", http.StatusOK)
	require.Equal(t, long, body, "imgproxy would drop frames past its limit")
	require.Equal(t, "no-cache", resp.Header.Get("Cache-Control"))
	require.Len(t, f.calls(), 1)
}

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
	require.Equal(t, "inline; filename=wide.webp", resp.Header.Get("Content-Disposition"), "saved variants get a matching extension")
	require.Equal(t, "private, max-age=86400", resp.Header.Get("Cache-Control"))
	require.Equal(t, "Accept", resp.Header.Get("Vary"))
	resp, _ = alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "inline; filename=wide.png", resp.Header.Get("Content-Disposition"), "the original keeps its name")

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
