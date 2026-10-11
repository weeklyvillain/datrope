package webhooks_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/webhooks"
)

func TestExecute(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alerts := webhookChannel(t, alice, "alerts")
	hook, path := newWebhook(t, alice, alerts, "CI")
	ws, _ := bob.Connect()

	// No session: the URL is the credential.
	env.Anon().Do(http.MethodPost, path, map[string]any{"content": "Build passed"}, http.StatusNoContent, nil)
	var ev messages.Message
	ws.ExpectDispatch("MESSAGE_CREATE", &ev)
	require.Nil(t, ev.Author)
	require.Equal(t, "CI", ev.Webhook.Name)
	require.Equal(t, hook.ID, *ev.Webhook.ID)
	require.Equal(t, "Build passed", ev.Content)

	// A Discord payload, extra fields and all; ?wait=true answers with the message.
	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "Deployed", "username": "Deploy bot", "tts": false, "allowed_mentions": map[string]any{"parse": []string{}},
		"embeds": []any{map[string]any{
			"type": "rich", "title": "v1.2.3", "url": "https://example.com/releases/1.2.3", "description": "**Fixed** things",
			"color": 0x2ecc71, "timestamp": "2026-10-10T14:00:00.000+02:00",
			"author": map[string]any{"name": "GitHub", "url": "https://github.com"},
			"fields": []any{
				map[string]any{"name": "Branch", "value": "main", "inline": true},
				map[string]any{"name": "Commit", "value": "abc123", "inline": true},
			},
			"footer": map[string]any{"text": "CI"},
			"image":  map[string]any{"url": "http://127.0.0.1:1/x.png"},
		}},
	}, http.StatusOK, &m)
	require.Equal(t, "Deploy bot", m.Webhook.Name, "username overrides the name for this message")
	require.Equal(t, "Deployed", m.Content)
	require.Len(t, m.Embeds, 1)
	e := m.Embeds[0]
	require.Equal(t, "v1.2.3", e.Title)
	require.Equal(t, "https://example.com/releases/1.2.3", e.URL)
	require.Equal(t, 0x2ecc71, *e.Color)
	require.Equal(t, "2026-10-10T12:00:00Z", e.Timestamp, "normalised to UTC")
	require.Equal(t, "GitHub", e.Author.Name)
	require.Len(t, e.Fields, 2)
	require.True(t, e.Fields[1].Inline)
	require.Equal(t, "CI", e.Footer.Text)
	require.Nil(t, e.Image, "an image that cannot be fetched is dropped; the message still posts")

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+alerts.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 2)
	require.Equal(t, "Deploy bot", page[0].Webhook.Name)
	require.Equal(t, "CI", page[1].Webhook.Name)

	// Errors have Discord's shape.
	execFail(t, env, "/api/webhooks/"+hook.ID.String()+"/wrong-token", map[string]any{"content": "x"}, http.StatusUnauthorized, 50027, "bad token")
	execFail(t, env, "/api/webhooks/123/"+hook.Token, map[string]any{"content": "x"}, http.StatusNotFound, 10015, "unknown webhook")
	execFail(t, env, "/api/webhooks/nope/"+hook.Token, map[string]any{"content": "x"}, http.StatusNotFound, 10015, "malformed ID")
	execFail(t, env, path, map[string]any{}, http.StatusBadRequest, 50006, "nothing to send")
	execFail(t, env, path, map[string]any{"content": "   "}, http.StatusBadRequest, 50006, "blank content")
	_, raw := env.Anon().Raw(http.MethodPost, path, strings.NewReader("{"), "application/json", http.StatusBadRequest)
	var bad discordError
	require.NoError(t, json.Unmarshal(raw, &bad))
	require.Equal(t, 50109, bad.Code)
}

func TestExecuteLimits(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "Limits") // its own webhook: these 19 calls stay under 30 a minute
	long := func(n int) string { return strings.Repeat("a", n) }
	embed := func(e map[string]any) map[string]any { return map[string]any{"embeds": []any{e}} }
	many := func(n int, item map[string]any) []any {
		out := make([]any, n)
		for i := range out {
			out[i] = item
		}
		return out
	}
	for _, tc := range []struct {
		name string
		body any
	}{
		{"content", map[string]any{"content": long(2001)}},
		{"username", map[string]any{"content": "x", "username": long(81)}},
		{"too many embeds", map[string]any{"embeds": many(11, map[string]any{"title": "x"})}},
		{"title", embed(map[string]any{"title": long(257)})},
		{"description", embed(map[string]any{"description": long(4097)})},
		{"too many fields", embed(map[string]any{"fields": many(26, map[string]any{"name": "n", "value": "v"})})},
		{"field name", embed(map[string]any{"fields": []any{map[string]any{"name": long(257), "value": "v"}}})},
		{"field value", embed(map[string]any{"fields": []any{map[string]any{"name": "n", "value": long(1025)}}})},
		{"empty field", embed(map[string]any{"fields": []any{map[string]any{"name": "", "value": "v"}}})},
		{"author name", embed(map[string]any{"author": map[string]any{"name": long(257)}})},
		{"footer", embed(map[string]any{"footer": map[string]any{"text": long(2049)}})},
		{"total text", map[string]any{"embeds": []any{map[string]any{"description": long(4000)}, map[string]any{"description": long(2001)}}}},
		{"colour", embed(map[string]any{"title": "x", "color": 0x1000000})},
		{"timestamp", embed(map[string]any{"title": "x", "timestamp": "yesterday"})},
		{"link scheme", embed(map[string]any{"title": "x", "url": "javascript:alert(1)"})},
		{"image scheme", embed(map[string]any{"image": map[string]any{"url": "file:///etc/passwd"}})},
		{"avatar scheme", map[string]any{"content": "x", "avatar_url": "ftp://example.com/a.png"}},
		{"empty embed", embed(map[string]any{})},
	} {
		execFail(t, env, path, tc.body, http.StatusBadRequest, 50035, tc.name)
	}
	// Exactly at every limit it posts (6000 characters of embed text in all).
	env.Anon().Do(http.MethodPost, path, map[string]any{
		"content": strings.Repeat("é", 2000), "username": long(80),
		"embeds": []any{map[string]any{"title": long(256), "description": long(4096), "footer": map[string]any{"text": long(1648)}}},
	}, http.StatusNoContent, nil)
}

func TestExecuteMentions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	everyone := env.Register("everyone")
	here := env.Register("here")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")

	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{"content": "@everyone @here deploy is out, @bob"}, http.StatusOK, &m)
	require.Equal(t, []id.ID{bob.User.ID}, m.Mentions, "@everyone and @here never mention anyone from a webhook")

	var inbox messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &inbox)
	require.Len(t, inbox.Items, 1)
	require.Equal(t, m.ID, inbox.Items[0].Message.ID)
	for _, c := range []*apptest.Client{everyone, here} {
		c.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &inbox)
		require.Empty(t, inbox.Items)
	}
}

func TestExecuteRateLimit(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	post := func(p string) (*http.Response, []byte) {
		t.Helper()
		resp, err := http.Post(env.Server.URL+p, "application/json", strings.NewReader(`{"content":"tick"}`))
		require.NoError(t, err)
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		return resp, body
	}
	sent := 0
	for ; sent < 45; sent++ {
		resp, body := post(path)
		if resp.StatusCode == http.StatusTooManyRequests {
			require.Equal(t, "2", resp.Header.Get("Retry-After"))
			var e discordError
			require.NoError(t, json.Unmarshal(body, &e))
			require.Equal(t, 2.0, e.RetryAfter)
			break
		}
		require.Equal(t, http.StatusNoContent, resp.StatusCode, string(body))
	}
	require.GreaterOrEqual(t, sent, 30, "30 a minute are allowed")
	require.Less(t, sent, 45, "then it is rate limited")

	// Each webhook has its own budget.
	_, other := newWebhook(t, alice, alerts, "Other")
	resp, _ := post(other)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestWebhookLifecycle(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alerts := webhookChannel(t, alice, "alerts")
	hook, path := newWebhook(t, alice, alerts, "CI")
	env.Anon().Do(http.MethodPost, path, map[string]any{"content": "one"}, http.StatusNoContent, nil)

	// Regenerating the token turns the old URL off.
	var again webhooks.WebhookWithURL
	alice.Do(http.MethodPost, "/api/webhooks/"+hook.ID.String()+"/token", nil, http.StatusOK, &again)
	execFail(t, env, path, map[string]any{"content": "old"}, http.StatusUnauthorized, 50027, "old token")
	newPath := strings.TrimPrefix(again.URL, apptest.PublicURL)
	env.Anon().Do(http.MethodPost, newPath, map[string]any{"content": "two"}, http.StatusNoContent, nil)

	// Renaming or deleting the webhook does not change what it posted.
	alice.Do(http.MethodPatch, "/api/webhooks/"+hook.ID.String(), map[string]any{"name": "Renamed"}, http.StatusOK, nil)
	alice.Do(http.MethodDelete, "/api/webhooks/"+hook.ID.String(), nil, http.StatusNoContent, nil)
	execFail(t, env, newPath, map[string]any{"content": "three"}, http.StatusNotFound, 10015, "deleted webhook")
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+alerts.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 2)
	for _, m := range page {
		require.Equal(t, "CI", m.Webhook.Name)
		require.Nil(t, m.Webhook.ID, "the webhook is gone")
	}

	// Deleting a webhook message needs MANAGE_MESSAGES; there is no author to outrank.
	msg := "/api/channels/" + alerts.String() + "/messages/" + page[0].ID.String()
	bob.Fail(http.MethodDelete, msg, nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, msg, nil, http.StatusNoContent, nil)
}

func TestWebhookAvatarOnMessages(t *testing.T) {
	ctx := context.Background()
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alerts := webhookChannel(t, alice, "alerts")
	hook, path := newWebhook(t, alice, alerts, "CI")

	var plain messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{"content": "no avatar yet"}, http.StatusOK, &plain)
	require.Empty(t, plain.Webhook.AvatarURL, "clients draw the webhook icon")

	alice.UploadTo(http.MethodPut, "/api/webhooks/"+hook.ID.String()+"/avatar", "a.png", pngOf(t, 64, 64), http.StatusOK)
	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{"content": "with avatar"}, http.StatusOK, &m)
	avatar := m.Webhook.AvatarURL
	require.Regexp(t, `^/api/messages/`+m.ID.String()+`/images/[0-9a-f]{64}$`, avatar)
	sum := avatar[strings.LastIndex(avatar, "/")+1:]

	// Served to readers of the channel only, and only under its own message.
	resp, _ := bob.Raw(http.MethodGet, avatar, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "private, max-age=86400", resp.Header.Get("Cache-Control"))
	env.Anon().Raw(http.MethodGet, avatar, nil, "", http.StatusUnauthorized)
	env.Outsider("eve").Raw(http.MethodGet, avatar, nil, "", http.StatusNotFound)
	bob.Raw(http.MethodGet, "/api/messages/"+plain.ID.String()+"/images/"+sum, nil, "", http.StatusNotFound)

	// The message keeps its avatar after the webhook (and its own avatar) are gone, and the sweep keeps it.
	alice.Do(http.MethodDelete, "/api/webhooks/"+hook.ID.String(), nil, http.StatusNoContent, nil)
	require.NoError(t, env.App.Files.Sweep(ctx, time.Now().Add(48*time.Hour)))
	bob.Raw(http.MethodGet, avatar, nil, "", http.StatusOK)

	// Deleting the message removes its images.
	alice.Do(http.MethodDelete, "/api/channels/"+alerts.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	bob.Raw(http.MethodGet, avatar, nil, "", http.StatusNotFound)
	_, err := os.Stat(filepath.Join(env.DataDir, "files", sum))
	require.ErrorIs(t, err, os.ErrNotExist)
}

// lockedBuffer collects log output written from the server's goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func TestExecuteKeepsTokenOutOfLogs(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	hook, path := newWebhook(t, alice, alerts, "CI")

	logs := &lockedBuffer{}
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	env.Anon().Do(http.MethodPost, path, map[string]any{"content": "Build passed"}, http.StatusNoContent, nil)
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{"content": "again"}, http.StatusOK, nil)
	execFail(t, env, path, map[string]any{}, http.StatusBadRequest, 50006, "nothing to send")
	execFail(t, env, "/api/webhooks/123/"+hook.Token, map[string]any{"content": "x"}, http.StatusNotFound, 10015, "unknown webhook")
	env.Anon().Raw(http.MethodGet, path, nil, "", http.StatusMethodNotAllowed) // a browser opening the URL
	env.Anon().Raw(http.MethodPost, path+"/github", strings.NewReader(`{"content":"x"}`), "application/json", http.StatusNotFound)
	require.Contains(t, logs.String(), "/api/webhooks/"+hook.ID.String()+"/…", "the requests were logged")
	require.NotContains(t, logs.String(), hook.Token)
}

func TestExecuteTrimsBeforeLimits(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "  " + strings.Repeat("a", 2000) + "\n", "username": " " + strings.Repeat("b", 80) + " ",
	}, http.StatusOK, &m)
	require.Equal(t, strings.Repeat("a", 2000), m.Content)
	require.Equal(t, strings.Repeat("b", 80), m.Webhook.Name)
}

func TestExecutePingsOnlyMentionableRoles(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alerts := webhookChannel(t, alice, "alerts")
	_, path := newWebhook(t, alice, alerts, "CI")
	var open, closed struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Oncall", "permissions": 0, "mentionable": true}, http.StatusCreated, &open)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Staff", "permissions": 0}, http.StatusCreated, &closed)
	var m messages.Message
	env.Anon().Do(http.MethodPost, path+"?wait=true", map[string]any{
		"content": "deploy failed <@&" + open.ID.String() + "> <@&" + closed.ID.String() + ">"}, http.StatusOK, &m)
	require.Equal(t, []id.ID{open.ID}, m.MentionRoles)
}
