package messages_test

import (
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func search(t *testing.T, c *apptest.Client, q string) messages.SearchResponse {
	t.Helper()
	var r messages.SearchResponse
	c.Do(http.MethodGet, "/api/search?q="+url.QueryEscape(q), nil, http.StatusOK, &r)
	return r
}

func resultContents(rs []messages.SearchResult) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.Message.Content)
	}
	return out
}

func startThread(t *testing.T, c *apptest.Client, channelID id.ID, parent messages.Message) channels.Channel {
	t.Helper()
	var th channels.Channel
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages/"+parent.ID.String()+"/thread", map[string]any{}, http.StatusCreated, &th)
	return th
}

func dm(t *testing.T, from, to *apptest.Client) channels.Channel {
	t.Helper()
	var ch channels.Channel
	from.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{to.User.ID.String()}}, http.StatusOK, &ch)
	return ch
}

func TestSearchPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	srv := alice.Server()
	deny := func(ch id.ID, p perms.Perms) {
		alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+srv.ID.String(),
			map[string]any{"allow": 0, "deny": p}, http.StatusOK, nil)
	}
	secret := alice.CreateTextChannel("secret")
	deny(secret, perms.ViewChannel)
	noHistory := alice.CreateTextChannel("no-history")
	deny(noHistory, perms.ReadHistory)

	alice.Send(general, "wingspan in general")
	alice.Send(secret, "wingspan in secret")
	alice.Send(noHistory, "wingspan without history")
	hidden := startThread(t, alice, secret, alice.Send(secret, "plans"))
	alice.Send(hidden.ID, "wingspan in a hidden thread")
	open := startThread(t, alice, general, alice.Send(general, "saturday"))
	alice.Send(open.ID, "wingspan in a visible thread")
	alice.Send(dm(t, alice, carol).ID, "wingspan between alice and carol")
	alice.Send(dm(t, alice, bob).ID, "wingspan between alice and bob")

	got := search(t, bob, "wingspan")
	require.Equal(t, []string{"wingspan between alice and bob", "wingspan in a visible thread", "wingspan in general"}, resultContents(got.Results))
	require.Equal(t, 3, *got.Total)
	require.Equal(t, "dm", got.Results[0].Channel.Type)
	require.Equal(t, "thread", got.Results[1].Channel.Type)
	require.Equal(t, "general", got.Results[1].Channel.ParentName)
	require.Equal(t, "general", got.Results[2].Channel.Name)

	require.Equal(t, []string{"wingspan between alice and carol", "wingspan in a visible thread", "wingspan in general"},
		resultContents(search(t, carol, "wingspan").Results))
	require.Len(t, search(t, alice, "wingspan").Results, 7) // the owner reads every channel, and both her DMs

	// Naming a channel bob cannot read does not reveal it.
	bob.Fail(http.MethodGet, "/api/search?q="+url.QueryEscape("in:#secret wingspan"), nil, http.StatusBadRequest, "UNKNOWN_FILTER")

	// A kicked member keeps only their DMs.
	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	require.Equal(t, []string{"wingspan between alice and bob"}, resultContents(search(t, bob, "wingspan").Results))
}

func TestSearchFilters(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	games := alice.CreateTextChannel("games")
	alice.Send(general, "board games tonight")
	bob.Send(general, "Games night? board ready")
	alice.Send(games, "board rules: https://example.com")
	a := alice.Upload(games, "board.txt", []byte("hi"), http.StatusCreated)
	alice.SendWith(games, "board photo", a.ID)
	alice.Send(dm(t, alice, bob).ID, "board in a dm")

	// Whole words in any order, newest first.
	require.Equal(t, []string{"board in a dm", "board photo", "board rules: https://example.com", "Games night? board ready", "board games tonight"},
		resultContents(search(t, bob, "board").Results))
	require.Equal(t, []string{"Games night? board ready", "board games tonight"}, resultContents(search(t, bob, "games BOARD").Results))
	require.Empty(t, search(t, bob, "boar").Results)

	r := search(t, bob, "board from:alice in:#games")
	require.Equal(t, []string{"board photo", "board rules: https://example.com"}, resultContents(r.Results))
	require.Equal(t, "alice", r.Filters.From.Username)
	require.Equal(t, "games", r.Filters.InChannel.Name)
	require.Equal(t, []string{"board"}, r.Filters.Terms)

	r = search(t, bob, "board in:@alice")
	require.Equal(t, []string{"board in a dm"}, resultContents(r.Results))
	require.Equal(t, "alice", r.Filters.InDMWith.Username)

	require.Equal(t, []string{"board rules: https://example.com"}, resultContents(search(t, bob, "has:link").Results))
	require.Equal(t, []string{"board photo"}, resultContents(search(t, bob, "has:file board").Results))

	bob.Fail(http.MethodGet, "/api/search?q=from:nobody", nil, http.StatusBadRequest, "UNKNOWN_FILTER")
	bob.Fail(http.MethodGet, "/api/search?q=has:gif", nil, http.StatusBadRequest, "INVALID_QUERY")
	bob.Fail(http.MethodGet, "/api/search?q=", nil, http.StatusBadRequest, "EMPTY_QUERY")
	bob.Fail(http.MethodGet, "/api/search?q=board&cursor=nope", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestSearchHasFileSkipsExpiredFiles(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "old.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(ch, "harbor snapshot", a.ID)
	require.Equal(t, []string{"harbor snapshot"}, resultContents(search(t, alice, "has:file harbor").Results))
	alice.Do(http.MethodDelete, "/api/attachments/"+a.ID.String(), nil, http.StatusNoContent, nil)
	require.Empty(t, search(t, alice, "has:file harbor").Results, "an expired file no longer counts")
	require.Len(t, search(t, alice, "harbor").Results, 1, "the message itself stays")
}

func TestSearchDatesAndPages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	noon := func(s string) time.Time {
		d, err := time.Parse(time.DateOnly, s)
		require.NoError(t, err)
		return d.Add(12 * time.Hour)
	}
	// 30 messages at noon UTC on 2026-04-10 and one on 2026-05-02, with IDs from those times.
	_, err := env.Pool.Exec(t.Context(), `
		INSERT INTO messages (id, channel_id, author_id, content)
		SELECT $3::bigint + g, $1, $2, 'cascadia ' || g FROM generate_series(1, 30) g`,
		general, alice.User.ID, int64(id.FirstAt(noon("2026-04-10"))))
	require.NoError(t, err)
	_, err = env.Pool.Exec(t.Context(), `INSERT INTO messages (id, channel_id, author_id, content) VALUES ($1, $2, $3, 'cascadia may')`,
		id.FirstAt(noon("2026-05-02")), general, alice.User.ID)
	require.NoError(t, err)

	first := search(t, alice, "cascadia")
	require.Len(t, first.Results, 25)
	require.Equal(t, 31, *first.Total)
	require.Equal(t, "cascadia may", first.Results[0].Message.Content)
	require.NotNil(t, first.NextCursor)
	var second messages.SearchResponse
	alice.Do(http.MethodGet, "/api/search?q=cascadia&cursor="+first.NextCursor.String(), nil, http.StatusOK, &second)
	require.Len(t, second.Results, 6)
	require.Nil(t, second.NextCursor)
	require.Nil(t, second.Total)
	require.Equal(t, "cascadia 1", second.Results[5].Message.Content)

	require.Equal(t, []string{"cascadia may"}, resultContents(search(t, alice, "cascadia after:2026-04-10").Results))
	require.Len(t, search(t, alice, "cascadia before:2026-05-01").Results, 25)

	// Dates are the caller's days: at UTC+14, noon UTC on 2026-04-10 is already 2026-04-11.
	var r messages.SearchResponse
	q := url.QueryEscape("cascadia before:2026-04-11")
	alice.Do(http.MethodGet, "/api/search?q="+q+"&utc_offset=840", nil, http.StatusOK, &r)
	require.Empty(t, r.Results)
	alice.Do(http.MethodGet, "/api/search?q="+q, nil, http.StatusOK, &r)
	require.Len(t, r.Results, 25)
}

func TestSearchTokensAndDeleted(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	alice.Send(general, "see https://example.com now")
	alice.Send(general, "grab board.txt v3.5 from bob@x.com")
	gone := alice.Send(general, "temporary")

	// Whole tokens as Postgres sees them: hosts, file names, versions, emails.
	for q, want := range map[string]string{
		"example.com": "see https://example.com now",
		"board.txt":   "grab board.txt v3.5 from bob@x.com",
		"bob@x.com":   "grab board.txt v3.5 from bob@x.com",
	} {
		require.Equal(t, []string{want}, resultContents(search(t, alice, q).Results), q)
	}
	require.Equal(t, []string{"example.com"}, search(t, alice, "example.com").Filters.Terms)

	// A deleted message is not found by a filter-only search, nor counted.
	before := search(t, alice, "from:alice")
	require.Equal(t, 3, *before.Total)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+gone.ID.String(), nil, http.StatusNoContent, nil)
	after := search(t, alice, "from:alice")
	require.Equal(t, 2, *after.Total)
	require.Len(t, after.Results, 2)
	for _, r := range after.Results {
		require.NotEqual(t, gone.ID, r.Message.ID)
	}
}

func TestSearchHeldAtRulesGate(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.Do(http.MethodPut, "/api/server/welcome", map[string]any{"markdown": "Rules: be nice.", "rules_gate": true}, http.StatusOK, nil)
	alice.Send(alice.General(), "wingspan in general")
	dave := env.Register("dave")
	require.Empty(t, search(t, dave, "wingspan").Results)
	require.Len(t, search(t, alice, "wingspan").Results, 1)
}

func TestSearchRateLimited(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	for i := 0; i < 30; i++ {
		search(t, alice, "anything")
	}
	alice.Fail(http.MethodGet, "/api/search?q=anything", nil, http.StatusTooManyRequests, "RATE_LIMITED")
}

func TestSearchCoversNewChannelTypes(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	news := createChannel(t, alice, map[string]any{"name": "news", "type": "announcement"})
	art := createChannel(t, alice, map[string]any{"name": "art", "type": "gallery"})
	help := createChannel(t, alice, map[string]any{"name": "help", "type": "forum"})

	alice.Send(news.ID, "zeppelin in news")
	img := alice.Upload(art.ID, "z.png", tinyPNG(t), http.StatusCreated)
	item := alice.SendWith(art.ID, "zeppelin in art", img.ID)
	alice.Send(startThread(t, alice, art.ID, item).ID, "zeppelin in a gallery thread")
	var post messages.ThreadListItem
	alice.Do(http.MethodPost, "/api/channels/"+help.ID.String()+"/posts", map[string]any{"title": "Q", "content": "zeppelin in a post"}, http.StatusCreated, &post)
	alice.Send(post.Channel.ID, "zeppelin in a reply")

	require.Equal(t, []string{"zeppelin in a reply", "zeppelin in a post", "zeppelin in a gallery thread", "zeppelin in art", "zeppelin in news"},
		resultContents(search(t, bob, "zeppelin").Results))
	require.Equal(t, []string{"zeppelin in a gallery thread", "zeppelin in art"}, resultContents(search(t, bob, "zeppelin in:#art").Results))
	require.Equal(t, []string{"zeppelin in news"}, resultContents(search(t, bob, "zeppelin in:#news").Results))
	require.Equal(t, []string{"zeppelin in a reply", "zeppelin in a post"}, resultContents(search(t, bob, "zeppelin in:#help").Results))
}
