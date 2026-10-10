package webhooks_test

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestExecuteFetchesImages(t *testing.T) {
	ctx := context.Background()
	env := apptest.New(t)
	env.App.Webhooks.SetImageAllow(func(net.IP) bool { return true }) // the image server is on 127.0.0.1
	alice := env.Register("alice")
	bob := env.Register("bob")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	avatarPNG, shotPNG := pngOf(t, 32, 32), pngOf(t, 48, 48)
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/avatar.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(avatarPNG)
		case "/shot.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(shotPNG)
		case "/notes.txt":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("not an image"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer images.Close()

	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "screenshots", "avatar_url": images.URL + "/avatar.png",
		"embeds": []any{map[string]any{
			"title":     "Nightly",
			"image":     map[string]any{"url": images.URL + "/shot.png"},
			"thumbnail": map[string]any{"url": images.URL + "/missing.png"},
			"author":    map[string]any{"name": "Bot", "icon_url": images.URL + "/notes.txt"},
			"footer":    map[string]any{"text": "f", "icon_url": images.URL + "/avatar.png"},
		}},
	}, http.StatusOK, &m)
	local := `^/api/messages/` + m.ID.String() + `/images/[0-9a-f]{64}$`
	require.Regexp(t, local, m.Webhook.AvatarURL)
	e := m.Embeds[0]
	require.Regexp(t, local, e.Image.URL)
	require.NotEqual(t, m.Webhook.AvatarURL, e.Image.URL)
	require.Nil(t, e.Thumbnail, "a 404 is dropped")
	require.Equal(t, "Bot", e.Author.Name)
	require.Empty(t, e.Author.IconURL, "not an image: dropped")
	require.Equal(t, m.Webhook.AvatarURL, e.Footer.IconURL, "the same image is stored once")

	// Clients only ever see this instance's URLs.
	_, raw := bob.Raw(http.MethodGet, "/api/channels/"+alerts.String()+"/messages", nil, "", http.StatusOK)
	require.NotContains(t, string(raw), images.URL)

	resp, _ := bob.Raw(http.MethodGet, e.Image.URL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.NoError(t, env.App.Files.Sweep(ctx, time.Now().Add(48*time.Hour)))
	bob.Raw(http.MethodGet, e.Image.URL, nil, "", http.StatusOK) // message_images is a blob table
}

// A dropped image is logged by scheme and host only: image URLs often carry
// signed query tokens. That covers the fetch's own errors (a *url.Error
// repeats the URL) and an image the server cannot read.
func TestExecuteKeepsImageURLsOutOfLogs(t *testing.T) {
	env := apptest.New(t)
	env.App.Webhooks.SetImageAllow(func(net.IP) bool { return true })
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	images := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/garbage.png": // served as an image, but not one the server can read
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("not a png"))
		case "/redirect": // onto a port nothing listens on: client.Do fails with a *url.Error
			http.Redirect(w, r, "http://127.0.0.1:1/x.png?sig=secret-redirect", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer images.Close()

	logs := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	env.Anon().Do(http.MethodPost, path, map[string]any{
		"content":    "x",
		"avatar_url": images.URL + "/garbage.png?sig=secret-garbage",
		"embeds": []any{map[string]any{
			"title":     "t",
			"image":     map[string]any{"url": images.URL + "/missing.png?sig=secret-missing"},
			"thumbnail": map[string]any{"url": images.URL + "/redirect?sig=secret-front"},
		}},
	}, http.StatusNoContent, nil)
	out := logs.String()
	require.Equal(t, 3, strings.Count(out, "webhook image dropped"), out)
	require.NotContains(t, out, "secret-")
	require.NotContains(t, out, "/garbage.png")
	require.Contains(t, out, images.URL+" ", "scheme and host are kept")
}

// An embed left with nothing to show once its images are dropped is dropped
// too; with no content and no embed left, there is nothing to send.
func TestExecuteDropsEmptiedEmbeds(t *testing.T) {
	env := apptest.New(t)
	env.App.Webhooks.SetImageAllow(func(net.IP) bool { return true })
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	images := httptest.NewServer(http.NotFoundHandler()) // every fetch fails
	defer images.Close()
	missing := map[string]any{"url": images.URL + "/missing.png"}

	execFail(t, env, path, map[string]any{"embeds": []any{map[string]any{"image": missing}}},
		http.StatusBadRequest, 50006, "image-only embed whose image failed")
	execFail(t, env, path, map[string]any{"embeds": []any{
		map[string]any{"image": missing}, map[string]any{"thumbnail": missing},
	}}, http.StatusBadRequest, 50006, "every embed emptied")
	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+alerts.String()+"/messages", nil, http.StatusOK, &page)
	require.Empty(t, page, "nothing is stored")

	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{"embeds": []any{
		map[string]any{"image": missing},
		map[string]any{"title": "Nightly", "image": missing},
	}}, http.StatusOK, &m)
	require.Len(t, m.Embeds, 1, "the emptied embed is dropped")
	require.Equal(t, "Nightly", m.Embeds[0].Title)
	require.Nil(t, m.Embeds[0].Image, "kept, minus the image")

	var text messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "hi", "embeds": []any{map[string]any{"image": missing}},
	}, http.StatusOK, &text)
	require.Equal(t, "hi", text.Content)
	require.Empty(t, text.Embeds, "content alone still posts")
}
