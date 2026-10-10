package communities_test

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
)

func iconPNG(t *testing.T, side int) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, side, side))))
	return buf.Bytes()
}

func TestRoleIcons(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	srv := alice.Server()
	var role communities.Role
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Gamers", "permissions": 0}, http.StatusCreated, &role)
	path := "/api/server/roles/" + role.ID.String()

	alice.Do(http.MethodPatch, path, map[string]any{"icon_emoji": "🎮"}, http.StatusOK, &role)
	require.Equal(t, "🎮", role.IconEmoji)
	alice.Fail(http.MethodPatch, path, map[string]any{"icon_emoji": "abc"}, http.StatusBadRequest, "BAD_ICON")
	alice.Fail(http.MethodPatch, path, map[string]any{"icon_emoji": "custom:123"}, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodPatch, "/api/server/roles/"+srv.Server.ID.String(), map[string]any{"icon_emoji": "🎮"}, http.StatusBadRequest, "CANNOT_STYLE_EVERYONE")
	bob.Fail(http.MethodPatch, path, map[string]any{"icon_emoji": "🎲"}, http.StatusForbidden, "MISSING_PERMISSION")

	raw := alice.UploadTo(http.MethodPut, path+"/icon", "icon.png", iconPNG(t, 64), http.StatusOK)
	role = communities.Role{}
	require.NoError(t, json.Unmarshal(raw, &role))
	require.Empty(t, role.IconEmoji, "an image replaces the emoji")
	require.True(t, strings.HasPrefix(role.IconURL, "/api/role-icons/"+role.ID.String()+"?v="))
	resp, _ := alice.Raw(http.MethodGet, role.IconURL, nil, "", http.StatusOK)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	alice.UploadTo(http.MethodPut, path+"/icon", "big.png", iconPNG(t, 600), http.StatusBadRequest)
	bob.UploadTo(http.MethodPut, path+"/icon", "icon.png", iconPNG(t, 64), http.StatusForbidden)

	role = communities.Role{}
	alice.Do(http.MethodPatch, path, map[string]any{"icon_emoji": "🎲"}, http.StatusOK, &role)
	require.Equal(t, "🎲", role.IconEmoji)
	require.Empty(t, role.IconURL, "an emoji replaces the image")

	raw = alice.UploadTo(http.MethodDelete, path+"/icon", "", nil, http.StatusOK)
	role = communities.Role{}
	require.NoError(t, json.Unmarshal(raw, &role))
	require.Empty(t, role.IconEmoji)
	require.Empty(t, role.IconURL)
}
