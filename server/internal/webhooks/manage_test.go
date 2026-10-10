package webhooks_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/webhooks"
)

func TestManageWebhooks(t *testing.T) {
	ctx := context.Background()
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	alerts := webhookChannel(t, alice, "alerts")
	base := "/api/channels/" + alerts.String() + "/webhooks"

	// MANAGE_WEBHOOKS is not in the default permissions.
	bob.Fail(http.MethodGet, base, nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, base, map[string]any{"name": "CI"}, http.StatusForbidden, "MISSING_PERMISSION")

	var created webhooks.WebhookWithURL
	alice.Do(http.MethodPost, base, map[string]any{"name": "  CI  "}, http.StatusCreated, &created)
	require.Equal(t, "CI", created.Name)
	require.Equal(t, alerts, created.ChannelID)
	require.Equal(t, alice.User.ID, *created.CreatedBy)
	require.Len(t, created.Token, 43, "32 random bytes, base64url")
	require.Equal(t, apptest.PublicURL+"/api/webhooks/"+created.ID.String()+"/"+created.Token, created.URL)
	require.Empty(t, created.AvatarURL)
	require.Equal(t, auth.HashToken(created.Token), tokenHash(t, env, created.ID), "only the hash is stored")

	// The list never shows a token.
	_, raw := alice.Raw(http.MethodGet, base, nil, "", http.StatusOK)
	require.NotContains(t, string(raw), created.Token)
	var list []webhooks.Webhook
	require.NoError(t, json.Unmarshal(raw, &list))
	require.Len(t, list, 1)
	require.Equal(t, "CI", list[0].Name)

	alice.Fail(http.MethodPost, "/api/channels/"+alice.General().String()+"/webhooks", map[string]any{"name": "x"},
		http.StatusBadRequest, "NOT_A_WEBHOOK_CHANNEL")
	alice.Fail(http.MethodPost, base, map[string]any{"name": "   "}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Fail(http.MethodPost, base, map[string]any{"name": strings.Repeat("a", 81)}, http.StatusBadRequest, "VALIDATION_FAILED")

	// A channel override grants MANAGE_WEBHOOKS in that channel only.
	member := "/api/channels/" + alerts.String() + "/overrides/member/" + bob.User.ID.String()
	alice.Do(http.MethodPut, member, map[string]any{"allow": uint64(perms.ManageWebhooks), "deny": 0}, http.StatusOK, nil)
	bob.Do(http.MethodGet, base, nil, http.StatusOK, &list)

	hook := "/api/webhooks/" + created.ID.String()
	var renamed webhooks.Webhook
	bob.Do(http.MethodPatch, hook, map[string]any{"name": "Deploys"}, http.StatusOK, &renamed)
	require.Equal(t, "Deploys", renamed.Name)

	var again webhooks.WebhookWithURL
	bob.Do(http.MethodPost, hook+"/token", nil, http.StatusOK, &again)
	require.NotEqual(t, created.Token, again.Token)
	require.Equal(t, auth.HashToken(again.Token), tokenHash(t, env, created.ID))

	// Avatars: cleaned, stored, and served to people who can see the channel.
	var withAvatar webhooks.Webhook
	require.NoError(t, json.Unmarshal(bob.UploadTo(http.MethodPut, hook+"/avatar", "a.png", pngOf(t, 64, 64), http.StatusOK), &withAvatar))
	require.Contains(t, withAvatar.AvatarURL, hook+"/avatar?v=")
	resp, _ := bob.Raw(http.MethodGet, withAvatar.AvatarURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "private, max-age=86400", resp.Header.Get("Cache-Control"))
	env.Anon().Raw(http.MethodGet, withAvatar.AvatarURL, nil, "", http.StatusUnauthorized)
	env.Outsider("eve").Raw(http.MethodGet, withAvatar.AvatarURL, nil, "", http.StatusNotFound)
	bob.UploadTo(http.MethodPut, hook+"/avatar", "a.txt", []byte("not an image"), http.StatusBadRequest)
	require.NoError(t, env.App.Files.Sweep(ctx, time.Now().Add(48*time.Hour)))
	bob.Raw(http.MethodGet, withAvatar.AvatarURL, nil, "", http.StatusOK) // a registered blob table: the sweep keeps it
	var cleared webhooks.Webhook
	_, raw = bob.Raw(http.MethodDelete, hook+"/avatar", nil, "", http.StatusOK)
	require.NoError(t, json.Unmarshal(raw, &cleared))
	require.Empty(t, cleared.AvatarURL)

	// Without the override bob may not manage it; outsiders do not see it at all.
	alice.Do(http.MethodDelete, member, nil, http.StatusNoContent, nil)
	bob.Fail(http.MethodPatch, hook, map[string]any{"name": "x"}, http.StatusForbidden, "MISSING_PERMISSION")
	env.Outsider("mallory").Fail(http.MethodPatch, hook, map[string]any{"name": "x"}, http.StatusNotFound, "NOT_FOUND")

	alice.Do(http.MethodDelete, hook, nil, http.StatusNoContent, nil)
	alice.Fail(http.MethodPatch, hook, map[string]any{"name": "x"}, http.StatusNotFound, "NOT_FOUND")
	alice.Do(http.MethodGet, base, nil, http.StatusOK, &list)
	require.Empty(t, list)
}
