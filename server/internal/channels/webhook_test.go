package channels_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestWebhookChannel(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice") // the owner: every permission
	bob := env.Register("bob")
	srv := alice.Server()

	var hook channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "alerts", "type": "webhook"}, http.StatusCreated, &hook)
	require.Equal(t, channels.TypeWebhook, hook.Type)
	bob.Fail(http.MethodPost, "/api/server/channels", map[string]any{"name": "x", "type": "webhook"}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPost, "/api/server/channels", map[string]any{"name": "x", "type": "thread"}, http.StatusBadRequest, "VALIDATION_FAILED")

	path := "/api/channels/" + hook.ID.String()
	// Nobody posts, uploads or types at the top level, the owner included.
	for _, c := range []*apptest.Client{alice, bob} {
		c.Fail(http.MethodPost, path+"/messages", map[string]any{"content": "hi"}, http.StatusForbidden, "MISSING_PERMISSION")
		c.Fail(http.MethodPost, path+"/typing", nil, http.StatusForbidden, "MISSING_PERMISSION")
		c.UploadFail(hook.ID, "a.txt", []byte("a"), http.StatusForbidden, "MISSING_PERMISSION")
	}
	bob.Do(http.MethodGet, path+"/messages", nil, http.StatusOK, nil) // reading works

	// Its messages are searchable: Readable and in: include webhook channels.
	first := insertMessage(t, env, hook.ID, alice.User.ID, "deploy finished")
	var res messages.SearchResponse
	bob.Do(http.MethodGet, "/api/search?q=deploy", nil, http.StatusOK, &res)
	require.Len(t, res.Results, 1)
	bob.Do(http.MethodGet, "/api/search?q=deploy+in:alerts", nil, http.StatusOK, &res)
	require.Len(t, res.Results, 1)

	// A thread under it is an ordinary thread: the mask does not apply there.
	var thread channels.Channel
	bob.Do(http.MethodPost, path+"/messages/"+first.String()+"/thread", map[string]any{}, http.StatusCreated, &thread)
	alice.Send(thread.ID, "nice")
	bob.Send(thread.ID, "agreed")
	bob.Upload(thread.ID, "notes.txt", []byte("notes"), http.StatusCreated)

	// Its overrides still govern its threads, and the owner can set SEND_MESSAGES on it:
	// the mask does not count against "you can only allow or deny what you hold".
	alice.Do(http.MethodPut, path+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.SendMessages)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, "/api/channels/"+thread.ID.String()+"/messages", map[string]any{"content": "x"},
		http.StatusForbidden, "MISSING_PERMISSION")
	second := insertMessage(t, env, hook.ID, alice.User.ID, "deploy failed")
	bob.Fail(http.MethodPost, path+"/messages/"+second.String()+"/thread", map[string]any{}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodPost, path+"/messages/"+second.String()+"/thread", map[string]any{}, http.StatusCreated, nil)
}

// insertMessage stores a message directly: nobody can post in a webhook channel through the API.
func insertMessage(t *testing.T, env *apptest.Env, channelID, authorID id.ID, content string) id.ID {
	t.Helper()
	mid := id.New()
	_, err := env.Pool.Exec(context.Background(), `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, $4)`,
		mid, channelID, authorID, content)
	require.NoError(t, err)
	return mid
}
