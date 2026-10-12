package messages_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func forum(t *testing.T, c *apptest.Client, requireTag bool) channels.Channel {
	t.Helper()
	return createChannel(t, c, map[string]any{"name": "help", "type": "forum", "tags": []string{"Bug", "Idea"}, "require_tag": requireTag})
}

func threadList(t *testing.T, c *apptest.Client, channelID id.ID) []messages.ThreadListItem {
	t.Helper()
	var list []messages.ThreadListItem
	c.Do(http.MethodGet, "/api/channels/"+channelID.String()+"/threads", nil, http.StatusOK, &list)
	return list
}

func TestForumPosts(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	carol := env.Register("carol")
	general := alice.General()
	f := forum(t, alice, false)
	posts := "/api/channels/" + f.ID.String() + "/posts"

	// A forum holds posts, not plain messages or message threads.
	bob.Fail(http.MethodPost, "/api/channels/"+f.ID.String()+"/messages", map[string]any{"content": "hi"}, http.StatusBadRequest, "NOT_ALLOWED_HERE")
	alice.Fail(http.MethodPost, "/api/channels/"+f.ID.String()+"/messages/"+id.New().String()+"/thread", map[string]any{}, http.StatusBadRequest, "NO_THREADS_HERE")

	body := strings.Repeat("éx", 100)
	var post messages.ThreadListItem
	bob.Do(http.MethodPost, posts, map[string]any{"title": "  App crashes  ", "content": body, "tags": []string{"bug"}}, http.StatusCreated, &post)
	require.Equal(t, "App crashes", post.Channel.Name)
	require.Equal(t, []string{"Bug"}, post.Channel.Tags, "tags take the spelling of the forum")
	require.Equal(t, f.ID, *post.Channel.ParentChannelID)
	require.Nil(t, post.ParentMessageID)
	require.NotNil(t, post.Author)
	require.Equal(t, "bob", post.Author.Username)
	require.Equal(t, string([]rune(body)[:200]), post.Excerpt)
	require.NotNil(t, post.FirstMessageID)
	require.Equal(t, 1, post.Summary.MessageCount)

	list := threadList(t, carol, f.ID)
	require.Len(t, list, 1)
	require.Equal(t, post.Channel.ID, list[0].Channel.ID)
	require.Equal(t, "bob", list[0].Author.Username)
	require.Equal(t, post.Excerpt, list[0].Excerpt)
	require.Equal(t, []string{"Bug"}, list[0].Channel.Tags)
	require.Equal(t, *post.FirstMessageID, *list[0].FirstMessageID)

	var page []messages.Message
	carol.Do(http.MethodGet, "/api/channels/"+post.Channel.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 1)
	require.Equal(t, body, page[0].Content)
	require.Equal(t, *post.FirstMessageID, page[0].ID)

	// Tags must come from the forum.
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "x", "content": "y", "tags": []string{"Nope"}}, http.StatusBadRequest, "UNKNOWN_TAG")
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "x", "content": "y", "tags": []string{"a", "b", "c", "d", "e", "f"}}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "   ", "content": "y"}, http.StatusBadRequest, "VALIDATION_FAILED")
	bob.Fail(http.MethodPost, "/api/channels/"+general.String()+"/posts", map[string]any{"title": "x", "content": "y"}, http.StatusBadRequest, "NOT_A_FORUM")

	// Updating: the author and moderators, not other members.
	postURL := "/api/channels/" + post.Channel.ID.String() + "/post"
	var updated messages.ThreadListItem
	bob.Do(http.MethodPatch, postURL, map[string]any{"title": "App crashes on start", "tags": []string{"Bug", "Idea"}}, http.StatusOK, &updated)
	require.Equal(t, "App crashes on start", updated.Channel.Name)
	require.Equal(t, []string{"Bug", "Idea"}, updated.Channel.Tags)
	require.Equal(t, "bob", updated.Author.Username)
	updated = messages.ThreadListItem{}
	bob.Do(http.MethodPatch, postURL, map[string]any{"title": "App crashes on start"}, http.StatusOK, &updated)
	require.Equal(t, []string{"Bug", "Idea"}, updated.Channel.Tags, "an update without tags keeps them")
	carol.Fail(http.MethodPatch, postURL, map[string]any{"title": "mine now"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPatch, postURL, map[string]any{"tags": []string{"Nope"}}, http.StatusBadRequest, "UNKNOWN_TAG")

	var mod struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)
	updated = messages.ThreadListItem{}
	carol.Do(http.MethodPatch, postURL, map[string]any{"tags": []string{}}, http.StatusOK, &updated)
	require.Empty(t, updated.Channel.Tags)
	require.Equal(t, "App crashes on start", updated.Channel.Name, "an update without a title keeps it")

	// Only forum posts have /post.
	alice.Fail(http.MethodPatch, "/api/channels/"+general.String()+"/post", map[string]any{"title": "x"}, http.StatusBadRequest, "NOT_A_POST")

	// Deleting.
	dave := env.Register("dave")
	dave.Fail(http.MethodDelete, postURL, nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodDelete, postURL, nil, http.StatusNoContent, nil)
	require.Empty(t, threadList(t, carol, f.ID))
	carol.Fail(http.MethodGet, "/api/channels/"+post.Channel.ID.String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
}

func TestForumRequireTagAndPermissions(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, true)
	posts := "/api/channels/" + f.ID.String() + "/posts"

	bob.Fail(http.MethodPost, posts, map[string]any{"title": "x", "content": "y"}, http.StatusBadRequest, "TAG_REQUIRED")
	var post messages.ThreadListItem
	bob.Do(http.MethodPost, posts, map[string]any{"title": "x", "content": "y", "tags": []string{"Idea"}}, http.StatusCreated, &post)
	bob.Fail(http.MethodPatch, "/api/channels/"+post.Channel.ID.String()+"/post", map[string]any{"tags": []string{}}, http.StatusBadRequest, "TAG_REQUIRED")

	srv := alice.Server()
	alice.Do(http.MethodPut, "/api/channels/"+f.ID.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.CreateThreads)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "x", "content": "y", "tags": []string{"Idea"}}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Send(post.Channel.ID, "replying needs only SEND_MESSAGES")
}

func TestForumPostAttachments(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	posts := "/api/channels/" + f.ID.String() + "/posts"
	a := bob.Upload(f.ID, "log.txt", []byte("stack trace"), http.StatusCreated)

	var post messages.ThreadListItem
	bob.Do(http.MethodPost, posts, map[string]any{"title": "Crash", "content": "see log", "attachment_ids": []string{a.ID.String()}}, http.StatusCreated, &post)
	var page []messages.Message
	alice.Do(http.MethodGet, "/api/channels/"+post.Channel.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Len(t, page, 1)
	require.Len(t, page[0].Attachments, 1)
	require.Equal(t, a.ID, page[0].Attachments[0].ID)
	require.Equal(t, post.Channel.ID, *page[0].Attachments[0].ChannelID, "the attachment moves to the post")
	_, raw := alice.Raw(http.MethodGet, page[0].Attachments[0].URL, nil, "", http.StatusOK)
	require.Equal(t, "stack trace", string(raw))

	// An attachment-only post is fine; nothing at all is not.
	b := bob.Upload(f.ID, "b.txt", []byte("b"), http.StatusCreated)
	bob.Do(http.MethodPost, posts, map[string]any{"title": "Files", "content": "", "attachment_ids": []string{b.ID.String()}}, http.StatusCreated, nil)
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "Empty", "content": "  "}, http.StatusBadRequest, "EMPTY_MESSAGE")
	// A failed claim leaves no post behind.
	bob.Fail(http.MethodPost, posts, map[string]any{"title": "Reused", "content": "x", "attachment_ids": []string{a.ID.String()}}, http.StatusBadRequest, "ATTACHMENT_INVALID")
	require.Len(t, threadList(t, alice, f.ID), 2)
}

func TestForumPostEvents(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	ws, _ := alice.Connect()

	var post messages.ThreadListItem
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Hello", "content": "first"}, http.StatusCreated, &post)
	var created messages.Message
	ws.ExpectDispatch("MESSAGE_CREATE", &created)
	require.Equal(t, post.Channel.ID, created.ChannelID)
	var up messages.PostUpdate
	ws.ExpectDispatch("POST_UPDATE", &up)
	require.Equal(t, f.ID, up.ChannelID)
	require.Equal(t, post.Channel.ID, up.Post.Channel.ID)
	require.Equal(t, 1, up.Post.Summary.MessageCount)
	require.Equal(t, "first", up.Post.Excerpt)

	alice.Send(post.Channel.ID, "reply")
	up = messages.PostUpdate{}
	ws.ExpectDispatch("POST_UPDATE", &up)
	require.Equal(t, 2, up.Post.Summary.MessageCount)

	bob.Do(http.MethodDelete, "/api/channels/"+post.Channel.ID.String()+"/post", nil, http.StatusNoContent, nil)
	var gone messages.PostDeleted
	ws.ExpectDispatch("POST_DELETE", &gone)
	require.Equal(t, f.ID, gone.ChannelID)
	require.Equal(t, post.Channel.ID, gone.ID)
	ws.ExpectNoDispatch("POST_UPDATE", 200*time.Millisecond)
}

func TestForumListWithoutAuthor(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	var post messages.ThreadListItem
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Orphan", "content": "x"}, http.StatusCreated, &post)
	// What deleting the user does to the post (created_by is ON DELETE SET NULL).
	_, err := env.Pool.Exec(t.Context(), "UPDATE channels SET created_by = NULL WHERE id = $1", post.Channel.ID)
	require.NoError(t, err)
	list := threadList(t, alice, f.ID)
	require.Len(t, list, 1)
	require.Nil(t, list[0].Author)
	require.Equal(t, "x", list[0].Excerpt)
}

func TestEditingOthersPostsFollowsHierarchy(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob, carol, dave := env.Register("bob"), env.Register("carol"), env.Register("dave")
	var helper, mod struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Helper", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &helper)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil) // rank 1
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)  // rank 2
	f := forum(t, alice, false)
	posts := "/api/channels/" + f.ID.String() + "/posts"

	var byMod, byMember, orphan messages.ThreadListItem
	carol.Do(http.MethodPost, posts, map[string]any{"title": "From a moderator", "content": "x"}, http.StatusCreated, &byMod)
	dave.Do(http.MethodPost, posts, map[string]any{"title": "From a member", "content": "x"}, http.StatusCreated, &byMember)
	dave.Do(http.MethodPost, posts, map[string]any{"title": "Orphan", "content": "x"}, http.StatusCreated, &orphan)
	_, err := env.Pool.Exec(t.Context(), "UPDATE channels SET created_by = NULL WHERE id = $1", orphan.Channel.ID)
	require.NoError(t, err)

	modURL := "/api/channels/" + byMod.Channel.ID.String() + "/post"
	bob.Fail(http.MethodPatch, modURL, map[string]any{"title": "mine"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodDelete, modURL, nil, http.StatusForbidden, "MISSING_PERMISSION")
	memberURL := "/api/channels/" + byMember.Channel.ID.String() + "/post"
	bob.Do(http.MethodPatch, memberURL, map[string]any{"title": "Tidied"}, http.StatusOK, nil)
	bob.Do(http.MethodDelete, memberURL, nil, http.StatusNoContent, nil)
	// A post whose author is gone can be changed by any moderator.
	bob.Do(http.MethodDelete, "/api/channels/"+orphan.Channel.ID.String()+"/post", nil, http.StatusNoContent, nil)
}

func TestEditingFirstMessageRefreshesExcerpt(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	ws, _ := alice.Connect()
	var post messages.ThreadListItem
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Hello", "content": "first"}, http.StatusCreated, &post)
	ws.ExpectDispatch("POST_UPDATE", nil)

	bob.Do(http.MethodPatch, "/api/channels/"+post.Channel.ID.String()+"/messages/"+post.FirstMessageID.String(),
		map[string]any{"content": "first, edited"}, http.StatusOK, nil)
	var up messages.PostUpdate
	ws.ExpectDispatch("POST_UPDATE", &up)
	require.Equal(t, f.ID, up.ChannelID)
	require.Equal(t, "first, edited", up.Post.Excerpt)
}

func TestForumReadState(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	f := forum(t, alice, false)
	readState := func() messages.ReadState {
		t.Helper()
		rs, err := env.App.Messages.ReadStates(t.Context(), alice.User.ID, []id.ID{f.ID})
		require.NoError(t, err)
		require.Len(t, rs, 1)
		return rs[0]
	}

	// A forum with no posts has nothing to read.
	require.Nil(t, readState().LastMessageID)

	var first, second messages.ThreadListItem
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "One", "content": "a"}, http.StatusCreated, &first)
	bob.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Two", "content": "b"}, http.StatusCreated, &second)
	require.Equal(t, *second.FirstMessageID, *second.Summary.LastMessageID)

	// The newest reply in any post is the forum's newest message.
	reply := bob.Send(first.Channel.ID, "reply in the older post")
	rs := readState()
	require.Equal(t, reply.ID, *rs.LastMessageID)
	require.Nil(t, rs.LastReadID)

	// Acking the forum with a post's message id clears it.
	alice.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/ack", map[string]any{"message_id": reply.ID.String()}, http.StatusNoContent, nil)
	rs = readState()
	require.Equal(t, reply.ID, *rs.LastReadID)
	require.Equal(t, *rs.LastMessageID, *rs.LastReadID)

	// The post's summary names its newest message.
	found := false
	for _, p := range threadList(t, alice, f.ID) {
		if p.Channel.ID == first.Channel.ID {
			found = true
			require.Equal(t, reply.ID, *p.Summary.LastMessageID)
		}
	}
	require.True(t, found)
}

// Sending a message marks it read for its author on the server, so after a
// reload the author's own newest message is not unread.
func TestOwnMessagesAreRead(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	readState := func(userID, channelID id.ID) messages.ReadState {
		t.Helper()
		rs, err := env.App.Messages.ReadStates(t.Context(), userID, []id.ID{channelID})
		require.NoError(t, err)
		require.Len(t, rs, 1)
		return rs[0]
	}

	// A text channel: my message is read for me, but not for bob.
	m := alice.Send(ch, "hello")
	require.Equal(t, m.ID, *readState(alice.User.ID, ch).LastReadID)
	require.Nil(t, readState(bob.User.ID, ch).LastReadID)

	// A forum: my new post and my reply are read for me in the post and in the forum.
	f := forum(t, alice, false)
	var post messages.ThreadListItem
	alice.Do(http.MethodPost, "/api/channels/"+f.ID.String()+"/posts", map[string]any{"title": "Mine", "content": "body"}, http.StatusCreated, &post)
	require.Equal(t, *post.FirstMessageID, *readState(alice.User.ID, post.Channel.ID).LastReadID)
	require.Equal(t, *post.FirstMessageID, *readState(alice.User.ID, f.ID).LastReadID)

	reply := alice.Send(post.Channel.ID, "my reply")
	forumRS := readState(alice.User.ID, f.ID)
	require.Equal(t, reply.ID, *forumRS.LastReadID)
	require.Equal(t, *forumRS.LastMessageID, *forumRS.LastReadID)
	require.Nil(t, readState(bob.User.ID, f.ID).LastReadID)
}
