package gifs_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/gifs"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

const klipyKey = "klipy-test-key-7c1d"

// fakeKlipy imitates Klipy's API and CDN in the shapes docs.klipy.com showed
// on 2026-10-10 (see the plan's "Klipy API facts").
type fakeKlipy struct {
	*httptest.Server
	mu        sync.Mutex
	customers []string // customer_id of each trending/search request
	queries   []string // q of each trending/search request
	slugs     []string // slugs of each items request
	media     []byte   // served for every .mp4 rendition
	down      bool     // answer API calls with 503
}

func newFakeKlipy(t *testing.T) *fakeKlipy {
	t.Helper()
	f := &fakeKlipy{media: mp4Video(4096)}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

// set changes the fake under its lock.
func (f *fakeKlipy) set(change func(f *fakeKlipy)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	change(f)
}

type klipyCalls struct{ customers, queries, slugs []string }

func (f *fakeKlipy) calls() klipyCalls {
	f.mu.Lock()
	defer f.mu.Unlock()
	return klipyCalls{slices.Clone(f.customers), slices.Clone(f.queries), slices.Clone(f.slugs)}
}

func (f *fakeKlipy) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.HasPrefix(r.URL.Path, "/media/") {
		if strings.HasSuffix(r.URL.Path, ".mp4") {
			_, _ = w.Write(f.media)
		} else {
			w.WriteHeader(http.StatusNotFound)
		}
		return
	}
	if f.down {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	endpoint, ok := strings.CutPrefix(r.URL.Path, "/api/v1/"+klipyKey+"/gifs/")
	if !ok { // a wrong key
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"result":false}`))
		return
	}
	q := r.URL.Query()
	w.Header().Set("Content-Type", "application/json")
	switch endpoint {
	case "trending", "search":
		f.customers = append(f.customers, q.Get("customer_id"))
		f.queries = append(f.queries, q.Get("q"))
		if q.Get("page") == "2" {
			writeList(w, []any{f.item("owl-3", "Owl")}, false)
			return
		}
		ad := map[string]any{"type": "ad", "content": "<div>Buy things</div>", "width": 300, "height": 250}
		writeList(w, []any{ad, f.item("cat-1", "Cat"), f.videoOnly("vid-4", "Vid"), f.item("dog-2", "Dog")}, true)
	case "items":
		f.slugs = append(f.slugs, q.Get("slugs"))
		data := []any{}
		if q.Get("slugs") == "cat-1" {
			data = append(data, f.item("cat-1", "Cat"))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": true, "data": map[string]any{"data": data}})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func writeList(w http.ResponseWriter, items []any, hasNext bool) {
	_ = json.NewEncoder(w).Encode(map[string]any{"result": true, "data": map[string]any{
		"data": items, "current_page": 1, "per_page": 24, "has_next": hasNext}})
}

// item is a GIF in Klipy's shape: four sizes with five formats each, every
// file claiming 1000 bytes.
func (f *fakeKlipy) item(slug, title string) map[string]any {
	file := map[string]any{}
	for size, px := range map[string]int{"hd": 498, "md": 360, "sm": 220, "xs": 90} {
		formats := map[string]any{}
		for _, format := range []string{"gif", "webp", "jpg", "mp4", "webm"} {
			formats[format] = map[string]any{"url": f.URL + "/media/" + slug + "-" + size + "." + format,
				"width": px, "height": px * 3 / 4, "size": 1000}
		}
		file[size] = formats
	}
	return map[string]any{"id": 8041071659142944, "slug": slug, "title": title, "file": file,
		"tags": "", "type": "gif", "blur_preview": "data:image/jpeg;base64,AA=="}
}

// videoOnly is a GIF with no image rendition to preview (only MP4 and WebM).
func (f *fakeKlipy) videoOnly(slug, title string) map[string]any {
	it := f.item(slug, title)
	for _, formats := range it["file"].(map[string]any) {
		for _, format := range []string{"gif", "webp", "jpg"} {
			delete(formats.(map[string]any), format)
		}
	}
	return it
}

// mp4Video is n bytes that sniff as video/mp4.
func mp4Video(n int) []byte {
	b := []byte{0, 0, 0, 24, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 2, 0, 'i', 's', 'o', 'm', 'm', 'p', '4', '1'}
	return append(b, make([]byte, n-len(b))...)
}

func setup(t *testing.T) (*fakeKlipy, *apptest.Env, *apptest.Client, *apptest.Client, id.ID) {
	t.Helper()
	f := newFakeKlipy(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.KlipyURL = f.URL })
	alice := env.Register("alice") // the owner and instance admin
	bob := env.Register("bob")
	return f, env, alice, bob, alice.General()
}

func setKey(t *testing.T, admin *apptest.Client, key string) {
	t.Helper()
	admin.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"klipy_api_key": key}, http.StatusOK, nil)
}

// get sends a GET and checks that the response never contains the API key.
func get(t *testing.T, c *apptest.Client, path string, want int, out any) []byte {
	t.Helper()
	_, raw := c.Raw(http.MethodGet, path, nil, "", want)
	require.NotContains(t, string(raw), klipyKey)
	if out != nil {
		require.NoError(t, json.Unmarshal(raw, out), string(raw))
	}
	return raw
}

func attach(t *testing.T, c *apptest.Client, slug string, channelID id.ID, want int) []byte {
	t.Helper()
	_, raw := c.Raw(http.MethodPost, "/api/gifs/"+slug+"/attach?channel_id="+channelID.String(), nil, "", want)
	require.NotContains(t, string(raw), klipyKey)
	return raw
}

func code(t *testing.T, raw []byte) string {
	t.Helper()
	var e httpx.Error
	require.NoError(t, json.Unmarshal(raw, &e), string(raw))
	return e.Code
}

func ids(items []gifs.GIF) []string {
	out := []string{}
	for _, g := range items {
		out = append(out, g.ID)
	}
	return out
}

func TestGIFsAreOffWithoutAKey(t *testing.T) {
	f, env, alice, _, ch := setup(t)
	require.Equal(t, "NOT_FOUND", code(t, get(t, alice, "/api/gifs/trending", http.StatusNotFound, nil)))
	require.Equal(t, "NOT_FOUND", code(t, get(t, alice, "/api/gifs/search?q=cat", http.StatusNotFound, nil)))
	require.Equal(t, "NOT_FOUND", code(t, attach(t, alice, "cat-1", ch, http.StatusNotFound)))
	var info auth.InstanceInfo
	env.Anon().Do(http.MethodGet, "/api/instance", nil, http.StatusOK, &info)
	require.False(t, info.GIFsEnabled)
	require.Equal(t, klipyCalls{}, f.calls(), "Klipy is never called")
}

func TestTrendingAndSearch(t *testing.T) {
	f, env, alice, bob, _ := setup(t)
	setKey(t, alice, klipyKey)
	env.Anon().Raw(http.MethodGet, "/api/gifs/trending", nil, "", http.StatusUnauthorized)

	var page gifs.GIFPage
	get(t, alice, "/api/gifs/trending", http.StatusOK, &page)
	require.Equal(t, []gifs.GIF{
		{ID: "cat-1", Title: "Cat", PreviewURL: f.URL + "/media/cat-1-sm.webp", Width: 220, Height: 165},
		{ID: "dog-2", Title: "Dog", PreviewURL: f.URL + "/media/dog-2-sm.webp", Width: 220, Height: 165},
	}, page.Items, "the ad slot and the GIF with no preview are dropped")
	require.Equal(t, "2", page.Next)

	page = gifs.GIFPage{}
	get(t, alice, "/api/gifs/trending?pos=2", http.StatusOK, &page)
	require.Equal(t, []string{"owl-3"}, ids(page.Items))
	require.Empty(t, page.Next, "the last page has no next")

	get(t, alice, "/api/gifs/search?q=happy+cat", http.StatusOK, &page)
	require.Equal(t, []string{"cat-1", "dog-2"}, ids(page.Items))
	get(t, bob, "/api/gifs/search?q=cat", http.StatusOK, nil)

	calls := f.calls()
	require.Equal(t, []string{"", "", "happy cat", "cat"}, calls.queries)
	for _, c := range calls.customers {
		require.Regexp(t, `^[0-9a-f]{64}$`, c)
	}
	require.Equal(t, calls.customers[0], calls.customers[2], "stable per user")
	require.NotEqual(t, calls.customers[0], calls.customers[3], "different per user")
	require.NotContains(t, calls.customers[0], alice.User.ID.String(), "the real ID never leaves")

	require.Equal(t, "VALIDATION_FAILED", code(t, get(t, alice, "/api/gifs/search", http.StatusBadRequest, nil)))
	require.Equal(t, "VALIDATION_FAILED", code(t, get(t, alice, "/api/gifs/search?q=%20%20", http.StatusBadRequest, nil)))
	require.Equal(t, "VALIDATION_FAILED", code(t, get(t, alice, "/api/gifs/trending?pos=abc", http.StatusBadRequest, nil)))
	require.Equal(t, "VALIDATION_FAILED", code(t, get(t, alice, "/api/gifs/trending?pos=0", http.StatusBadRequest, nil)))
}

func TestCustomerIDIsAnHMACOfTheUserID(t *testing.T) {
	f, env, alice, _, _ := setup(t)
	setKey(t, alice, klipyKey)
	get(t, alice, "/api/gifs/trending", http.StatusOK, nil)

	var secret []byte
	require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT instance_secret FROM instance_settings`).Scan(&secret))
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(alice.User.ID.String()))
	require.Equal(t, []string{hex.EncodeToString(m.Sum(nil))}, f.calls().customers)
}

func TestKlipyFailuresAreBadGateway(t *testing.T) {
	f, _, alice, _, ch := setup(t)
	setKey(t, alice, "wrong-key-55")
	raw := get(t, alice, "/api/gifs/trending", http.StatusBadGateway, nil)
	require.Equal(t, "GIF_PROVIDER_ERROR", code(t, raw))
	require.NotContains(t, string(raw), "wrong-key-55")

	setKey(t, alice, klipyKey)
	f.set(func(f *fakeKlipy) { f.down = true })
	require.Equal(t, "GIF_PROVIDER_ERROR", code(t, get(t, alice, "/api/gifs/search?q=cat", http.StatusBadGateway, nil)))
	require.Equal(t, "GIF_PROVIDER_ERROR", code(t, attach(t, alice, "cat-1", ch, http.StatusBadGateway)))
}

func TestAttachGIF(t *testing.T) {
	f, env, alice, bob, ch := setup(t)
	setKey(t, alice, klipyKey)

	var a files.Attachment
	require.NoError(t, json.Unmarshal(attach(t, alice, "cat-1", ch, http.StatusCreated), &a))
	require.True(t, a.GIF)
	require.Equal(t, "video/mp4", a.ContentType, "the MP4 rendition is preferred")
	require.Equal(t, "Cat.mp4", a.Filename)
	require.Equal(t, 498, *a.Width, "hd fits under 8 MB")
	require.Equal(t, 373, *a.Height)
	_, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, mp4Video(4096), body)
	require.Equal(t, []string{"cat-1"}, f.calls().slugs, "looked up by id with Klipy")

	m := alice.SendWith(ch, "look", a.ID)
	require.Len(t, m.Attachments, 1)
	require.True(t, m.Attachments[0].GIF)

	// Refused before Klipy is asked.
	eve := env.Outsider("eve")
	require.Equal(t, "NOT_FOUND", code(t, attach(t, eve, "cat-1", ch, http.StatusNotFound)))
	srv := alice.Server()
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	require.Equal(t, "MISSING_PERMISSION", code(t, attach(t, bob, "cat-1", ch, http.StatusForbidden)))
	require.Equal(t, "NOT_FOUND", code(t, attach(t, alice, "cat-1,dog-2", ch, http.StatusNotFound)))
	require.Equal(t, "NOT_FOUND", code(t, attach(t, alice, "cat-1", id.ID(12345), http.StatusNotFound)))
	require.Equal(t, []string{"cat-1"}, f.calls().slugs, "refused requests never reach Klipy")

	// An id Klipy does not know.
	require.Equal(t, "NOT_FOUND", code(t, attach(t, alice, "nope-9", ch, http.StatusNotFound)))
	require.Equal(t, []string{"cat-1", "nope-9"}, f.calls().slugs)
}

func TestAttachSizeCap(t *testing.T) {
	f, env, alice, _, ch := setup(t)
	setKey(t, alice, klipyKey)
	ctx := context.Background()

	f.set(func(f *fakeKlipy) { f.media = mp4Video(8<<20 + 1) }) // Klipy claims 1000 bytes
	require.Equal(t, "TOO_LARGE", code(t, attach(t, alice, "cat-1", ch, http.StatusRequestEntityTooLarge)))

	// A smaller instance upload limit applies too.
	_, err := env.Pool.Exec(ctx, `UPDATE instance_settings SET max_upload_bytes = 1048576`)
	require.NoError(t, err)
	f.set(func(f *fakeKlipy) { f.media = mp4Video(1048577) })
	require.Equal(t, "TOO_LARGE", code(t, attach(t, alice, "cat-1", ch, http.StatusRequestEntityTooLarge)))
	var n int
	require.NoError(t, env.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments`).Scan(&n))
	require.Zero(t, n, "refused GIFs leave nothing behind")

	f.set(func(f *fakeKlipy) { f.media = mp4Video(1048576) })
	attach(t, alice, "cat-1", ch, http.StatusCreated)
}
