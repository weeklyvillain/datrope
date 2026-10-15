package messages_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/messages"
)

func TestSendStoresSenderTimeZone(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"

	var m messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "gaming @ 9pm", "tz": "Europe/Stockholm"}, http.StatusCreated, &m)
	require.Equal(t, "Europe/Stockholm", m.TZ)

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, "Europe/Stockholm", page[0].TZ, "listed messages carry it too")

	// Edits keep the original zone.
	var edited messages.Message
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "gaming @ 10pm"}, http.StatusOK, &edited)
	require.Equal(t, "Europe/Stockholm", edited.TZ)
}

func TestSendDropsInvalidTimeZone(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"
	for _, tz := range []string{"Mars/Base", "", strings.Repeat("a", 64)} {
		var m messages.Message
		alice.Do(http.MethodPost, path, map[string]any{"content": "x", "tz": tz}, http.StatusCreated, &m)
		require.Empty(t, m.TZ, tz)
	}
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "tz": strings.Repeat("a", 65)}, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestForumPostStoresSenderTimeZone(t *testing.T) {
	env := apptest.New(t)
	bob := env.Register("bob")
	f := forum(t, bob, false)
	var post messages.ThreadListItem
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Game night", "content": "gaming @ 9pm", "tz": "Europe/Stockholm"}, http.StatusCreated, &post)

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+post.Channel.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 1)
	require.Equal(t, "Europe/Stockholm", page[0].TZ)
}
