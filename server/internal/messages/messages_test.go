package messages_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func setup(t *testing.T) (*apptest.Env, *apptest.Client, *apptest.Client, id.ID, id.ID) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.Server()
	return env, alice, bob, c.ID, alice.General()
}

func TestSendAndList(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"

	var first messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "one", "nonce": "n-1"}, http.StatusCreated, &first)
	require.Equal(t, "n-1", first.Nonce)
	require.Equal(t, "alice", first.Author.Username)
	require.WithinDuration(t, first.ID.Time(), first.CreatedAt, 0)
	second := bob.Send(ch, "two")
	alice.Send(ch, "three")

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, []string{"three", "two", "one"}, contents(page), "newest first")

	bob.Do(http.MethodGet, path+"?limit=2", nil, http.StatusOK, &page)
	require.Len(t, page, 2)
	bob.Do(http.MethodGet, path+"?before="+second.ID.String(), nil, http.StatusOK, &page)
	require.Equal(t, []string{"one"}, contents(page))

	alice.Fail(http.MethodPost, path, map[string]any{"content": strings.Repeat("a", 4001)}, http.StatusBadRequest, "VALIDATION_FAILED")
	alice.Do(http.MethodPost, path, map[string]any{"content": strings.Repeat("é", 4000)}, http.StatusCreated, nil)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "   "}, http.StatusBadRequest, "EMPTY_MESSAGE")
	alice.Fail(http.MethodGet, path+"?limit=101", nil, http.StatusBadRequest, "VALIDATION_FAILED")

	env.Outsider("outsider").Fail(http.MethodGet, path, nil, http.StatusNotFound, "NOT_FOUND")
}

func contents(ms []messages.Message) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.Content)
	}
	return out
}

func TestEditAndDelete(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	m := bob.Send(ch, "typo")
	url := "/api/channels/" + ch.String() + "/messages/" + m.ID.String()

	alice.Fail(http.MethodPatch, url, map[string]any{"content": "hijack"}, http.StatusForbidden, "MISSING_PERMISSION")
	var edited messages.Message
	bob.Do(http.MethodPatch, url, map[string]any{"content": "fixed"}, http.StatusOK, &edited)
	require.Equal(t, "fixed", edited.Content)
	require.NotNil(t, edited.EditedAt)

	other := alice.Send(ch, "mine")
	bob.Fail(http.MethodDelete, "/api/channels/"+ch.String()+"/messages/"+other.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Do(http.MethodDelete, url, nil, http.StatusNoContent, nil) // the owner has MANAGE_MESSAGES

	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &page)
	require.True(t, page[1].Deleted)
	require.Empty(t, page[1].Content, "deleting clears the content but keeps the row")

	bob.Fail(http.MethodPatch, url, map[string]any{"content": "again"}, http.StatusNotFound, "NOT_FOUND")
	alice.Fail(http.MethodDelete, url, nil, http.StatusNotFound, "NOT_FOUND")
}

func TestChannelPermissionsApply(t *testing.T) {
	_, alice, bob, serverID, ch := setup(t)
	ov := "/api/channels/" + ch.String() + "/overrides/role/" + serverID.String()
	path := "/api/channels/" + ch.String() + "/messages"

	alice.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.SendMessages)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, path, map[string]any{"content": "hi"}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/channels/"+ch.String()+"/typing", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodGet, path, nil, http.StatusOK, nil)

	alice.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	bob.Fail(http.MethodGet, path, nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestDMMessages(t *testing.T) {
	env, alice, bob, _, _ := setup(t)
	var dm channels.Channel
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm)
	alice.Send(dm.ID, "psst")
	var page []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+dm.ID.String()+"/messages", nil, http.StatusOK, &page)
	require.Equal(t, []string{"psst"}, contents(page))

	carol := env.Register("carol")
	carol.Fail(http.MethodGet, "/api/channels/"+dm.ID.String()+"/messages", nil, http.StatusNotFound, "NOT_FOUND")
}

func TestTypingAndAck(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	bob.Do(http.MethodPost, "/api/channels/"+ch.String()+"/typing", nil, http.StatusNoContent, nil)

	m1 := alice.Send(ch, "1")
	m2 := alice.Send(ch, "2")
	ack := "/api/channels/" + ch.String() + "/ack"
	bob.Do(http.MethodPost, ack, map[string]any{"message_id": m2.ID.String()}, http.StatusNoContent, nil)
	bob.Do(http.MethodPost, ack, map[string]any{"message_id": m1.ID.String()}, http.StatusNoContent, nil) // never moves backwards

	var last id.ID
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT last_message_id FROM read_states WHERE user_id = $1 AND channel_id = $2`, bob.User.ID, ch).Scan(&last))
	require.Equal(t, m2.ID, last)
}

func TestAttachments(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	path := "/api/channels/" + ch.String() + "/messages"
	a := alice.Upload(ch, "notes.txt", []byte("hello file"), http.StatusCreated)

	var m messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "", "attachment_ids": []string{a.ID.String()}}, http.StatusCreated, &m)
	require.Empty(t, m.Content, "a message may be attachment-only")
	require.Len(t, m.Attachments, 1)
	require.Equal(t, a.ID, m.Attachments[0].ID)

	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, "notes.txt", page[0].Attachments[0].Filename)
	require.NotNil(t, page[0].Attachments)
	_, body := bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "hello file", string(body), "once sent, the channel can download it")

	alice.Fail(http.MethodPost, path, map[string]any{"content": "again", "attachment_ids": []string{a.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // already sent
	b := bob.Upload(ch, "b.txt", []byte("b"), http.StatusCreated)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": []string{b.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // someone else's upload
	var other channels.Channel
	alice.Do(http.MethodPost, "/api/server/channels",
		map[string]any{"name": "other", "type": "text"}, http.StatusCreated, &other)
	c := alice.Upload(other.ID, "c.txt", []byte("c"), http.StatusCreated)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": []string{c.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID") // uploaded to another channel
	alice.Fail(http.MethodPost, path, map[string]any{"content": "   "}, http.StatusBadRequest, "EMPTY_MESSAGE")

	ids := make([]string, 11)
	for i := range ids {
		ids[i] = alice.Upload(ch, "f.txt", []byte{byte(i)}, http.StatusCreated).ID.String()
	}
	alice.Fail(http.MethodPost, path, map[string]any{"content": "x", "attachment_ids": ids}, http.StatusBadRequest, "VALIDATION_FAILED")

	var edited messages.Message
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "now with text"}, http.StatusOK, &edited)
	require.Len(t, edited.Attachments, 1)
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": ""}, http.StatusOK, &edited)
	require.Empty(t, edited.Content)
	require.Len(t, edited.Attachments, 1, "an attachment-only message may be edited to empty text")
	plain := alice.Send(ch, "plain")
	alice.Fail(http.MethodPatch, path+"/"+plain.ID.String(), map[string]any{"content": ""}, http.StatusBadRequest, "EMPTY_MESSAGE")

	d := alice.Upload(ch, "d.txt", []byte("dup"), http.StatusCreated)
	var dup messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "dup", "attachment_ids": []string{d.ID.String(), d.ID.String()}}, http.StatusCreated, &dup)
	require.Len(t, dup.Attachments, 1, "duplicate IDs collapse")

	v := alice.Upload(ch, "v.txt", []byte("valid"), http.StatusCreated)
	alice.Fail(http.MethodPost, path, map[string]any{"content": "partial", "attachment_ids": []string{v.ID.String(), c.ID.String()}},
		http.StatusBadRequest, "ATTACHMENT_INVALID")
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	for _, p := range page {
		require.NotEqual(t, "partial", p.Content, "a failed send leaves no message")
	}
	alice.SendWith(ch, "retry", v.ID) // the valid one was not consumed

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK) // sent files survive the cleanup

	alice.Do(http.MethodDelete, path+"/"+m.ID.String(), nil, http.StatusNoContent, nil)
	bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	entries, err := os.ReadDir(filepath.Join(env.DataDir, "files"))
	require.NoError(t, err)
	for _, e := range entries {
		if files.ValidSum(e.Name()) {
			sum := sha256.Sum256([]byte("hello file"))
			require.NotEqual(t, hex.EncodeToString(sum[:]), e.Name(), "the deleted message's blob is gone")
		}
	}
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	for _, p := range page {
		if p.ID == m.ID {
			require.Empty(t, p.Attachments, "a deleted message has no files")
		}
	}
}

func TestAttachFilesCheckedAtSend(t *testing.T) {
	_, alice, bob, serverID, ch := setup(t)
	a := bob.Upload(ch, "x.txt", []byte("x"), http.StatusCreated)
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+serverID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	bob.Fail(http.MethodPost, "/api/channels/"+ch.String()+"/messages",
		map[string]any{"content": "x", "attachment_ids": []string{a.ID.String()}}, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Send(ch, "plain text still works")
}

func TestDeletingOthersMessagesFollowsHierarchy(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	carol, dave := env.Register("carol"), env.Register("dave")
	var helper, mod struct{ ID id.ID }
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Helper", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &helper)
	alice.Do(http.MethodPost, "/api/server/roles", map[string]any{"name": "Moderator", "permissions": uint64(perms.ManageMessages)}, http.StatusCreated, &mod)
	alice.Do(http.MethodPut, "/api/server/members/"+bob.User.ID.String()+"/roles/"+helper.ID.String(), nil, http.StatusNoContent, nil) // rank 1
	alice.Do(http.MethodPut, "/api/server/members/"+carol.User.ID.String()+"/roles/"+mod.ID.String(), nil, http.StatusNoContent, nil)  // rank 2

	byMod := carol.Send(ch, "from a moderator")
	byMember := dave.Send(ch, "from a member")
	bob.Fail(http.MethodDelete, "/api/channels/"+ch.String()+"/messages/"+byMod.ID.String(), nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Do(http.MethodDelete, "/api/channels/"+ch.String()+"/messages/"+byMember.ID.String(), nil, http.StatusNoContent, nil)
}

// createChannel creates a server channel of any type and returns it.
func createChannel(t *testing.T, c *apptest.Client, body map[string]any) channels.Channel {
	t.Helper()
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/server/channels", body, http.StatusCreated, &ch)
	return ch
}

func tinyPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for x := 0; x < 4; x++ {
		for y := 0; y < 4; y++ {
			img.Set(x, y, color.RGBA{uint8(x * 40), uint8(y * 40), 99, 255})
		}
	}
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func TestAnnouncementChannel(t *testing.T) {
	_, alice, bob, _, general := setup(t)
	news := createChannel(t, alice, map[string]any{"name": "news", "type": "announcement"})
	path := "/api/channels/" + news.ID.String() + "/messages"

	bob.Fail(http.MethodPost, path, map[string]any{"content": "me too"}, http.StatusForbidden, "MISSING_PERMISSION")

	var m messages.Message
	alice.Do(http.MethodPost, path, map[string]any{"content": "We launched", "title": "  Launch day  "}, http.StatusCreated, &m)
	require.Equal(t, "Launch day", m.Title)
	var page []messages.Message
	bob.Do(http.MethodGet, path, nil, http.StatusOK, &page)
	require.Equal(t, "Launch day", page[0].Title)

	alice.Fail(http.MethodPost, "/api/channels/"+general.String()+"/messages",
		map[string]any{"content": "x", "title": "nope"}, http.StatusBadRequest, "NOT_ALLOWED_HERE")

	// Members discuss announcements in threads.
	var thread channels.Channel
	bob.Do(http.MethodPost, path+"/"+m.ID.String()+"/thread", map[string]any{}, http.StatusCreated, &thread)
	bob.Do(http.MethodPost, "/api/channels/"+thread.ID.String()+"/messages", map[string]any{"content": "congrats"}, http.StatusCreated, nil)

	var edited messages.Message
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "We launched!", "title": "Launch"}, http.StatusOK, &edited)
	require.Equal(t, "Launch", edited.Title)
	require.Equal(t, "We launched!", edited.Content)
	alice.Do(http.MethodPatch, path+"/"+m.ID.String(), map[string]any{"content": "We launched!!"}, http.StatusOK, &edited)
	require.Equal(t, "Launch", edited.Title, "an edit without a title keeps it")

	plain := alice.Send(general, "plain")
	alice.Fail(http.MethodPatch, "/api/channels/"+general.String()+"/messages/"+plain.ID.String(),
		map[string]any{"content": "plain", "title": "t"}, http.StatusBadRequest, "NOT_ALLOWED_HERE")
}

func TestGalleryChannel(t *testing.T) {
	env, alice, bob, _, general := setup(t)
	art := createChannel(t, alice, map[string]any{"name": "art", "type": "gallery"})
	path := "/api/channels/" + art.ID.String() + "/messages"

	bob.Fail(http.MethodPost, path, map[string]any{"content": "just words"}, http.StatusBadRequest, "MEDIA_ONLY")

	img := bob.Upload(art.ID, "cat.png", tinyPNG(t), http.StatusCreated)
	var m messages.Message
	bob.Do(http.MethodPost, path, map[string]any{"content": "my cat", "attachment_ids": []string{img.ID.String()}}, http.StatusCreated, &m)
	require.Len(t, m.Attachments, 1)

	txt := bob.Upload(art.ID, "notes.txt", []byte("not media"), http.StatusCreated)
	bob.Fail(http.MethodPost, path, map[string]any{"content": "", "attachment_ids": []string{txt.ID.String()}}, http.StatusBadRequest, "MEDIA_ONLY")
	var count int
	require.NoError(t, env.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM attachments WHERE id = $1 AND message_id IS NULL`, txt.ID).Scan(&count))
	require.Equal(t, 1, count, "a rejected upload stays unclaimed")

	// Uploads are bound to their channel, so a text channel takes its own copy.
	other := bob.Upload(general, "notes.txt", []byte("not media"), http.StatusCreated)
	bob.SendWith(general, "", other.ID)

	var thread channels.Channel
	alice.Do(http.MethodPost, path+"/"+m.ID.String()+"/thread", map[string]any{}, http.StatusCreated, &thread)
	alice.Send(thread.ID, "lovely")
}
