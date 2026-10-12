package messages_test

import (
	"net/http"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func listFiles(t *testing.T, c *apptest.Client, q url.Values) messages.FilesPage {
	t.Helper()
	var p messages.FilesPage
	c.Do(http.MethodGet, "/api/files?"+q.Encode(), nil, http.StatusOK, &p)
	return p
}

func fileNames(p messages.FilesPage) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.Attachment.Filename)
	}
	return out
}

// minimal WAV header + silence: sniffed as audio/wave.
func wav() []byte {
	b := make([]byte, 44+800)
	copy(b, "RIFF")
	b[4], b[5] = 0x44, 0x03 // 36+800 little-endian
	copy(b[8:], "WAVEfmt ")
	b[16], b[20], b[22], b[24], b[25], b[32], b[34] = 16, 1, 1, 0x40, 0x1f, 2, 16
	copy(b[36:], "data")
	b[40], b[41] = 0x20, 0x03
	return b
}

func TestFilesScope(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	srv := alice.Server()
	secret := alice.CreateTextChannel("secret")
	alice.Do(http.MethodPut, "/api/channels/"+secret.String()+"/overrides/role/"+srv.ID.String(),
		map[string]any{"allow": 0, "deny": perms.ViewChannel}, http.StatusOK, nil)

	alice.SendWith(general, "a song", alice.Upload(general, "song.wav", wav(), http.StatusCreated).ID)
	alice.SendWith(secret, "", alice.Upload(secret, "hidden.wav", wav(), http.StatusCreated).ID)
	parent := alice.Send(general, "thread here")
	th := startThread(t, alice, general, parent)
	alice.SendWith(th.ID, "", alice.Upload(th.ID, "in-thread.txt", []byte("hello"), http.StatusCreated).ID)
	d := dm(t, alice, bob)
	alice.SendWith(d.ID, "", alice.Upload(d.ID, "dm.txt", []byte("psst"), http.StatusCreated).ID)

	got := listFiles(t, bob, url.Values{})
	require.Equal(t, alice.User.ID, got.Items[1].UploaderID)
	require.False(t, got.Items[1].CreatedAt.IsZero())
	require.Equal(t, []string{"in-thread.txt", "song.wav"}, fileNames(got))
	require.Equal(t, "thread", got.Items[0].Channel.Type)
	require.Equal(t, general, *got.Items[0].Channel.ParentID, "a thread's file is tagged with its parent")
	require.Equal(t, "audio", got.Items[1].Kind)
	require.Equal(t, "a song", got.Items[1].Message.Content)

	// alice sees her secret channel too, but never DMs.
	require.Equal(t, []string{"in-thread.txt", "hidden.wav", "song.wav"}, fileNames(listFiles(t, alice, url.Values{})))

	// A channel filter naming a hidden channel, a DM or a thread yields nothing and no error.
	require.Empty(t, listFiles(t, bob, url.Values{"channel": {secret.String()}}).Items)
	require.Empty(t, listFiles(t, bob, url.Values{"channel": {d.ID.String()}}).Items)
	require.Equal(t, []string{"in-thread.txt", "song.wav"}, fileNames(listFiles(t, bob, url.Values{"channel": {general.String()}})))
}

func TestFilesFilters(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	general := alice.General()
	png := alice.Upload(general, "pic.png", tinyPNG(t), http.StatusCreated)
	pdf := alice.Upload(general, "50%_off notes.pdf", []byte("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"), http.StatusCreated)
	zip := bob.Upload(general, "pack.zip", []byte("PK\x03\x04rest-of-zip"), http.StatusCreated)
	bin := bob.Upload(general, "blob.bin", []byte{0, 1, 2, 3, 0xff}, http.StatusCreated)
	alice.SendWith(general, "", png.ID, pdf.ID)
	bob.SendWith(general, "the wingspan rules", zip.ID, bin.ID)

	kinds := func(k string) []string { return fileNames(listFiles(t, bob, url.Values{"kind": {k}})) }
	require.Equal(t, []string{"pic.png"}, kinds("image"))
	require.Equal(t, []string{"50%_off notes.pdf"}, kinds("document"))
	require.Equal(t, []string{"pack.zip"}, kinds("archive"))
	require.Equal(t, []string{"blob.bin"}, kinds("other"))
	require.Equal(t, []string{"pack.zip", "50%_off notes.pdf"}, kinds("archive,document"))

	require.Equal(t, []string{"blob.bin", "pack.zip"}, fileNames(listFiles(t, alice, url.Values{"uploader": {bob.User.ID.String()}})))

	q := func(s string) []string { return fileNames(listFiles(t, bob, url.Values{"q": {s}})) }
	require.Equal(t, []string{"50%_off notes.pdf"}, q("NOTES"), "file names match case-insensitively")
	require.Equal(t, []string{"50%_off notes.pdf"}, q("50%_"), "% and _ are literal")
	require.Empty(t, q("5_%"))
	require.Equal(t, []string{"blob.bin", "pack.zip"}, q("wingspan"), "captions match")

	bob.Fail(http.MethodGet, "/api/files?kind=music", nil, http.StatusBadRequest, "VALIDATION_FAILED")
}

func TestFilesPagination(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	var ids []id.ID
	for i := 0; i < 5; i++ {
		a := alice.Upload(general, "f.txt", []byte("x"), http.StatusCreated)
		alice.SendWith(general, "", a.ID)
		ids = append(ids, a.ID)
	}
	first := listFiles(t, alice, url.Values{"limit": {"3"}})
	require.Len(t, first.Items, 3)
	require.Equal(t, ids[4], first.Items[0].Attachment.ID)
	require.NotNil(t, first.NextCursor)
	second := listFiles(t, alice, url.Values{"limit": {"3"}, "before": {first.NextCursor.String()}})
	require.Len(t, second.Items, 2)
	require.Equal(t, ids[1], second.Items[0].Attachment.ID)
	require.Nil(t, second.NextCursor)

	// Deleting the message removes its files from the gallery.
	m := alice.SendWith(general, "", alice.Upload(general, "gone.txt", []byte("x"), http.StatusCreated).ID)
	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)
	require.NotContains(t, fileNames(listFiles(t, alice, url.Values{})), "gone.txt")
}

// Deleting a message deletes its files, which takes them out of any album.
func TestDeletedMessageLeavesAlbums(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	general := alice.General()
	a := alice.Upload(general, "pic.txt", []byte("x"), http.StatusCreated)
	m := alice.SendWith(general, "", a.ID)
	var album struct {
		ID id.ID `json:"id"`
	}
	alice.Do(http.MethodPost, "/api/albums", map[string]any{"title": "T", "visibility": "private"}, http.StatusCreated, &album)
	alice.Do(http.MethodPut, "/api/albums/"+album.ID.String()+"/files/"+a.ID.String(), nil, http.StatusNoContent, nil)

	alice.Do(http.MethodDelete, "/api/channels/"+general.String()+"/messages/"+m.ID.String(), nil, http.StatusNoContent, nil)

	var p messages.FilesPage
	alice.Do(http.MethodGet, "/api/albums/"+album.ID.String()+"/files", nil, http.StatusOK, &p)
	require.Empty(t, p.Items)
}
