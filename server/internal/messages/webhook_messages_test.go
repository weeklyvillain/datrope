package messages_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

// A message with no author_id (as a webhook posts it, Task 4) reads, searches,
// pins, mentions and deletes like any other.
func TestWebhookAuthoredMessages(t *testing.T) {
	env, alice, bob, _, _ := setup(t)
	ctx := context.Background()
	var alerts channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": "alerts", "type": "webhook"}, http.StatusCreated, &alerts)
	path := "/api/channels/" + alerts.ID.String() + "/messages"

	mid := id.New()
	_, err := env.Pool.Exec(ctx, `
		INSERT INTO messages (id, channel_id, author_id, content, author_name, mentions, embeds)
		VALUES ($1, $2, NULL, 'build is green @bob', 'CI', $3, $4)`, mid, alerts.ID, []int64{int64(bob.User.ID)},
		`[{"title":"Build #42","color":65280,"fields":[{"name":"Branch","value":"main","inline":true}]}]`)
	require.NoError(t, err)
	_, err = env.Pool.Exec(ctx, `INSERT INTO messages (id, channel_id, content) VALUES ($1, $2, 'nobody')`, id.New(), alerts.ID)
	require.Error(t, err, "a message needs an author or an author name")

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Len(t, page, 1)
	m := page[0]
	require.Nil(t, m.Author)
	require.Equal(t, "CI", m.Webhook.Name)
	require.Nil(t, m.Webhook.ID, "no webhooks row")
	require.Empty(t, m.Webhook.AvatarURL)
	require.Equal(t, []id.ID{bob.User.ID}, m.Mentions)
	require.Len(t, m.Embeds, 1)
	require.Equal(t, "Build #42", m.Embeds[0].Title)
	require.Equal(t, 65280, *m.Embeds[0].Color)
	require.True(t, m.Embeds[0].Fields[0].Inline)
	_, raw := bob.Raw(http.MethodGet, path, nil, "", http.StatusOK)
	require.NotContains(t, string(raw), `"author"`, "author is absent, not null")

	// The inbox lists it: author_id is NULL, which `<> me` would have dropped.
	var inbox messages.MentionsPage
	bob.Do(http.MethodGet, "/api/users/@me/mentions", nil, http.StatusOK, &inbox)
	require.Equal(t, []id.ID{mid}, itemIDs(inbox.Items))
	require.Equal(t, "CI", inbox.Items[0].Message.Webhook.Name)

	var res messages.SearchResponse
	bob.Do(http.MethodGet, "/api/search?q=green", nil, http.StatusOK, &res)
	require.Len(t, res.Results, 1)
	require.Nil(t, res.Results[0].Message.Author)

	alice.Do(http.MethodPut, "/api/channels/"+alerts.ID.String()+"/pins/"+mid.String(), nil, http.StatusNoContent, nil)
	var pins []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+alerts.ID.String()+"/pins", nil, http.StatusOK, &pins)
	require.Equal(t, "CI", pins[0].Webhook.Name)

	// Nobody edits it; deleting it needs MANAGE_MESSAGES, with no hierarchy to check.
	msg := path + "/" + mid.String()
	alice.Fail(http.MethodPatch, msg, map[string]any{"content": "x"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodDelete, msg, nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, msg, nil, http.StatusNoContent, nil)
	page = nil // decode fresh: an absent key would keep the old element's value
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.True(t, page[0].Deleted)
	require.Equal(t, "CI", page[0].Webhook.Name, "a deleted webhook message keeps its name")
	require.Nil(t, page[0].Embeds)
}
