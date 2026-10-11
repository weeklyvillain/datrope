package expressions_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/httpx"
)

const (
	pepeID = "01HV26WS98000E3Y75DEQDYCGH"
	hugeID = "01F6MZGCNG000255K4X1K7NTHR"
	setID  = "01J9MMS2R800036CR40E1041ED"
)

// fake7TV answers the v4 GraphQL queries the server sends and serves the
// emote images from /cdn/.
type fake7TV struct {
	*httptest.Server
	png  []byte
	down atomic.Bool

	mu      sync.Mutex
	vars    []map[string]any
	fetched []string
}

func newFake7TV(t *testing.T) *fake7TV {
	f := &fake7TV{png: pngBytes(t, 64)}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.Close)
	return f
}

func (f *fake7TV) emote(id, name string) map[string]any {
	img := func(file, mime string, scale, size, frames int) map[string]any {
		return map[string]any{"url": f.URL + "/cdn/" + id + "/" + file, "mime": mime, "scale": scale, "size": size, "frameCount": frames}
	}
	images := []any{img("1x.webp", "image/webp", 1, 400, 1), img("4x.png", "image/png", 4, 2000, 1), img("4x.webp", "image/webp", 4, 300<<10, 1)}
	if id == hugeID {
		images = []any{img("1x.webp", "image/webp", 1, 300<<10, 1), img("4x.png", "image/png", 4, 300<<10, 1)}
	}
	return map[string]any{"id": id, "defaultName": name, "flags": map[string]any{"animated": false}, "images": images}
}

func (f *fake7TV) serve(w http.ResponseWriter, r *http.Request) {
	if f.down.Load() {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/cdn/") {
		f.mu.Lock()
		f.fetched = append(f.fetched, r.URL.Path)
		f.mu.Unlock()
		if strings.HasSuffix(r.URL.Path, "/4x.png") {
			_, _ = w.Write(f.png)
			return
		}
		w.WriteHeader(http.StatusNotFound)
		return
	}
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if r.URL.Path != "/v4/gql" || r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&req) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.vars = append(f.vars, req.Variables)
	f.mu.Unlock()
	var data any
	switch {
	case strings.Contains(req.Query, "emoteSet("):
		var set any
		if req.Variables["id"] == setID {
			set = map[string]any{"id": setID, "name": "Streamer set", "emotes": map[string]any{"items": []any{
				map[string]any{"alias": "pepeAlias", "emote": f.emote(pepeID, "pepe")},
				map[string]any{"alias": "pepeAgain", "emote": f.emote(pepeID, "pepe")},
			}}}
		}
		data = map[string]any{"emoteSets": map[string]any{"emoteSet": set}}
	case strings.Contains(req.Query, "search("):
		data = map[string]any{"emotes": map[string]any{"search": map[string]any{"pageCount": 3,
			"items": []any{f.emote(pepeID, "pepe"), map[string]any{"id": "01HV26WS98000E3Y75DEQDYCGJ", "defaultName": "pending",
				"flags": map[string]any{"animated": false}, "images": []any{}}}}}}
	case strings.Contains(req.Query, "emote("):
		var e any
		switch req.Variables["id"] {
		case pepeID:
			e = f.emote(pepeID, "pepe")
		case hugeID:
			e = f.emote(hugeID, "huge")
		}
		data = map[string]any{"emotes": map[string]any{"emote": e}}
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
}

func errCode(t *testing.T, raw []byte) string {
	t.Helper()
	var e httpx.Error
	require.NoError(t, json.Unmarshal(raw, &e), string(raw))
	return e.Code
}

func TestSevenTV(t *testing.T) {
	f := newFake7TV(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.SevenTVURL = f.URL })
	alice := env.Register("alice") // the owner
	bob := env.Register("bob")
	ws, _ := bob.Connect()

	// Only MANAGE_EXPRESSIONS may look.
	bob.Do(http.MethodGet, "/api/server/emoji/7tv/search?q=pepe", nil, http.StatusForbidden, nil)
	bob.Do(http.MethodPost, "/api/server/emoji/7tv", map[string]any{"emote_id": pepeID, "name": "pepe"}, http.StatusForbidden, nil)

	// Search: emotes without a preview (still processing) are left out.
	var page expressions.SevenTVPage
	alice.Do(http.MethodGet, "/api/server/emoji/7tv/search?q=pepe&page=2", nil, http.StatusOK, &page)
	require.Equal(t, []expressions.SevenTVEmote{{ID: pepeID, Name: "pepe", PreviewURL: f.URL + "/cdn/" + pepeID + "/1x.webp"}}, page.Items)
	require.Equal(t, 3, page.NextPage)
	require.Equal(t, "pepe", f.vars[len(f.vars)-1]["q"])
	require.EqualValues(t, 2, f.vars[len(f.vars)-1]["page"])
	page = expressions.SevenTVPage{}
	alice.Do(http.MethodGet, "/api/server/emoji/7tv/search?q=pepe&page=3", nil, http.StatusOK, &page)
	require.Zero(t, page.NextPage)

	// Sets: emotes go by their alias, each listed once.
	var set expressions.SevenTVSet
	alice.Do(http.MethodGet, "/api/server/emoji/7tv/sets/"+setID, nil, http.StatusOK, &set)
	require.Equal(t, "Streamer set", set.Name)
	require.Len(t, set.Items, 1)
	require.Equal(t, "pepeAlias", set.Items[0].Name)
	alice.Do(http.MethodGet, "/api/server/emoji/7tv/sets/01J9MMS2R800036CR40E1041EE", nil, http.StatusNotFound, nil)
	n := len(f.vars)
	alice.Do(http.MethodGet, "/api/server/emoji/7tv/sets/not-an-id", nil, http.StatusNotFound, nil)
	require.Len(t, f.vars, n, "a malformed ID never reaches 7TV")

	// Import: the largest image that fits, looked up by ID on the server.
	var e expressions.Emoji
	_, raw := alice.Raw(http.MethodPost, "/api/server/emoji/7tv", strings.NewReader(`{"emote_id":"`+pepeID+`","name":"pepe"}`), "application/json", http.StatusCreated)
	require.NoError(t, json.Unmarshal(raw, &e))
	require.Equal(t, "pepe", e.Name)
	require.Equal(t, []string{"/cdn/" + pepeID + "/4x.png"}, f.fetched)
	var ev expressions.EmojiUpdate
	ws.ExpectDispatch("EMOJI_UPDATE", &ev)
	require.Len(t, ev.Emoji, 1)
	res, img := env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", res.Header.Get("Content-Type"))
	require.Equal(t, f.png, img)

	alice.Do(http.MethodPost, "/api/server/emoji/7tv", map[string]any{"emote_id": pepeID, "name": "PEPE"}, http.StatusConflict, nil)
	alice.Do(http.MethodPost, "/api/server/emoji/7tv", map[string]any{"emote_id": pepeID, "name": "bad name"}, http.StatusBadRequest, nil)
	_, raw = alice.Raw(http.MethodPost, "/api/server/emoji/7tv", strings.NewReader(`{"emote_id":"`+hugeID+`","name":"huge"}`), "application/json", http.StatusBadRequest)
	require.Equal(t, "NO_SUITABLE_IMAGE", errCode(t, raw))
	alice.Do(http.MethodPost, "/api/server/emoji/7tv", map[string]any{"emote_id": "01HV26WS98000E3Y75DEQDYCGK", "name": "gone"}, http.StatusNotFound, nil)
	alice.Do(http.MethodPost, "/api/server/emoji/7tv", map[string]any{"emote_id": "../../x", "name": "evil"}, http.StatusNotFound, nil)

	// 7TV down.
	f.down.Store(true)
	_, raw = alice.Raw(http.MethodGet, "/api/server/emoji/7tv/search?q=pepe", nil, "", http.StatusBadGateway)
	require.Equal(t, "EMOTE_PROVIDER_ERROR", errCode(t, raw))
}
