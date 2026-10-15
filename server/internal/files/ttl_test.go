package files_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
)

const mb = 1 << 20

func TestTTLFor(t *testing.T) {
	rules := []auth.TTLRule{{MinBytes: 100 * mb, TTLHours: 720}, {MinBytes: 500 * mb, TTLHours: 168}}
	_, ok := files.TTLFor(rules, 99*mb)
	require.False(t, ok)
	d, ok := files.TTLFor(rules, 100*mb)
	require.True(t, ok)
	require.Equal(t, 720*time.Hour, d)
	d, _ = files.TTLFor(rules, 900*mb)
	require.Equal(t, 168*time.Hour, d, "the biggest matching tier wins")
	_, ok = files.TTLFor(nil, 900*mb)
	require.False(t, ok)
}

func TestUploadExpires(t *testing.T) {
	env, alice, bob, _, ch := setup(t)
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{{"min_bytes": mb, "ttl_hours": 24}}}, http.StatusOK, nil)

	big := bytes.Repeat([]byte("x"), mb+10)
	a := alice.Upload(ch, "big.bin", big, http.StatusCreated)
	m := alice.SendWith(ch, "here", a.ID)
	require.NotNil(t, m.Attachments[0].ExpiresAt)
	require.WithinDuration(t, time.Now().Add(24*time.Hour), *m.Attachments[0].ExpiresAt, time.Minute)

	small := alice.SendWith(ch, "tiny", alice.Upload(ch, "s.txt", []byte("hi"), http.StatusCreated).ID)
	require.Nil(t, small.Attachments[0].ExpiresAt)

	// The same bytes again, kept forever: their shared blob must survive the first one expiring.
	b := alice.Upload(ch, "copy.bin", big, http.StatusCreated)
	mb2 := alice.SendWith(ch, "copy", b.ID)
	alice.Do(http.MethodPatch, "/api/attachments/"+b.ID.String(), map[string]any{"keep": true}, http.StatusOK, nil)

	// Changing the rules later does not touch files already sent.
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"upload_ttl_rules": []map[string]any{}}, http.StatusOK, nil)

	bobWS, _ := bob.Connect()
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	var upd struct {
		ID          string             `json:"id"`
		Attachments []files.Attachment `json:"attachments"`
	}
	bobWS.ExpectDispatch("MESSAGE_UPDATE", &upd)
	require.Equal(t, m.ID.String(), upd.ID)
	require.True(t, upd.Attachments[0].Expired)
	require.Empty(t, upd.Attachments[0].URL)

	alice.Fail(http.MethodGet, a.URL, nil, http.StatusGone, "FILE_EXPIRED")
	alice.Raw(http.MethodGet, mb2.Attachments[0].URL, nil, "", http.StatusOK) // kept: still there
	require.Equal(t, 2, blobCount(t, env))                                    // the shared blob and the small one

	var page struct {
		Items []struct {
			Attachment files.Attachment `json:"attachment"`
		} `json:"items"`
	}
	alice.Do(http.MethodGet, "/api/files?channel="+ch.String(), nil, http.StatusOK, &page)
	require.NotEmpty(t, page.Items)
	for _, it := range page.Items {
		require.NotEqual(t, a.ID, it.Attachment.ID, "the gallery hides expired files")
	}

	// Once the copy expires too, only expired rows point at the blob: it goes.
	_, err := env.Pool.Exec(context.Background(), "UPDATE attachments SET keep = false, expires_at = now() WHERE id = $1", b.ID)
	require.NoError(t, err)
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(time.Minute)))
	require.Equal(t, 1, blobCount(t, env), "only the small blob is left")
}

// An expired file leaves the albums it was in: their listing and count skip it.
func TestExpiredFileLeavesAlbums(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	g := alice.CreateGallery("all", "all")
	var album albums.Album
	alice.Do(http.MethodPost, "/api/channels/"+g.String()+"/albums", map[string]any{"title": "T", "visibility": "gallery"}, http.StatusCreated, &album)
	path := "/api/albums/" + album.ID.String()
	f := alice.Upload(ch, "pic.txt", []byte("x"), http.StatusCreated)
	alice.SendWith(ch, "", f.ID)
	alice.Do(http.MethodPut, path+"/files/"+f.ID.String(), nil, http.StatusNoContent, nil)

	var page struct {
		Items []struct {
			Attachment files.Attachment `json:"attachment"`
		} `json:"items"`
	}
	alice.Do(http.MethodGet, path+"/files", nil, http.StatusOK, &page)
	require.Len(t, page.Items, 1)

	alice.Do(http.MethodDelete, "/api/attachments/"+f.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, path+"/files", nil, http.StatusOK, &page)
	require.Empty(t, page.Items)
	var got albums.Album
	alice.Do(http.MethodGet, path, nil, http.StatusOK, &got)
	require.Equal(t, 0, got.ItemCount, "the count matches the listing")
}
