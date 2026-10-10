package webhooks_test

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/webhooks"
)

// webhookChannel creates a webhook channel as c, who needs MANAGE_CHANNELS.
func webhookChannel(t *testing.T, c *apptest.Client, name string) id.ID {
	t.Helper()
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": name, "type": "webhook"}, http.StatusCreated, &ch)
	return ch.ID
}

// newWebhook creates a webhook in channelID as c and returns it with the path of its URL.
func newWebhook(t *testing.T, c *apptest.Client, channelID id.ID, name string) (webhooks.WebhookWithURL, string) {
	t.Helper()
	var w webhooks.WebhookWithURL
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/webhooks", map[string]any{"name": name}, http.StatusCreated, &w)
	return w, strings.TrimPrefix(w.URL, apptest.PublicURL)
}

// discordError is the error body of the execute call.
type discordError struct {
	Code       int     `json:"code"`
	Message    string  `json:"message"`
	RetryAfter float64 `json:"retry_after"`
}

// execFail posts body to an execute URL without a session and checks Discord's error shape.
func execFail(t *testing.T, env *apptest.Env, path string, body any, status, code int, label string) {
	t.Helper()
	var e discordError
	env.Anon().Do(http.MethodPost, path, body, status, &e)
	require.Equal(t, code, e.Code, "%s: %s", label, e.Message)
	require.NotEmpty(t, e.Message, label)
}

func tokenHash(t *testing.T, env *apptest.Env, webhookID id.ID) []byte {
	t.Helper()
	var h []byte
	require.NoError(t, env.Pool.QueryRow(context.Background(), `SELECT token_hash FROM webhooks WHERE id = $1`, webhookID).Scan(&h))
	return h
}

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 99, 255})
		}
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}
