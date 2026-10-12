package files_test

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

func setup(t *testing.T) (*apptest.Env, *apptest.Client, *apptest.Client, communities.ServerWithRoles, id.ID) {
	env := apptest.New(t)
	alice := env.Register("alice")
	bob := env.Register("bob")
	c := alice.Server()
	return env, alice, bob, c, alice.General()
}

func blobCount(t *testing.T, env *apptest.Env) int {
	entries, err := os.ReadDir(filepath.Join(env.DataDir, "files"))
	require.NoError(t, err)
	n := 0
	for _, e := range entries {
		if files.ValidSum(e.Name()) {
			n++
		}
	}
	return n
}

func errorCode(t *testing.T, raw []byte) string {
	var e httpx.Error
	require.NoError(t, json.Unmarshal(raw, &e), string(raw))
	return e.Code
}

func TestUploadAndDownloadImage(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	img := pngImage(20, 10, false)
	a := alice.Upload(ch, "cat.png", img, http.StatusCreated)
	require.True(t, a.Inline)
	require.Equal(t, "image/png", a.ContentType)
	require.Equal(t, 20, *a.Width)
	require.Equal(t, 10, *a.Height)
	require.Equal(t, int64(len(img)), a.Size)
	require.Equal(t, "/api/attachments/"+a.ID.String(), a.URL)
	require.Empty(t, a.ThumbnailURL, "no thumbnails without imgproxy")

	resp, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, img, body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "inline; filename=cat.png", resp.Header.Get("Content-Disposition"))
	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Equal(t, "default-src 'none'; sandbox", resp.Header.Get("Content-Security-Policy"))
}

func TestUnsentAttachmentIsPrivate(t *testing.T) {
	_, alice, bob, _, ch := setup(t)
	a := alice.Upload(ch, "notes.txt", []byte("draft"), http.StatusCreated)
	_, raw := bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	require.Equal(t, "NOT_FOUND", errorCode(t, raw))
}

func TestNoThumbnailsWithoutImgproxy(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "wide.png", pngImage(1000, 500, false), http.StatusCreated)
	require.Empty(t, a.ThumbnailURL, "uploads no longer get thumbnails; clients show the original")
	require.Equal(t, 1, blobCount(t, env))
	_, raw := alice.Raw(http.MethodGet, a.URL+"/thumbnail", nil, "", http.StatusNotFound)
	require.Equal(t, "NOT_FOUND", errorCode(t, raw))
}

func TestLegacyThumbnailStillServed(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	img := pngImage(1000, 500, false)
	a := alice.Upload(ch, "wide.png", img, http.StatusCreated)
	// Rows from before on-demand variants have a thumbnail blob; point this one at its own file.
	_, err := env.Pool.Exec(context.Background(), `UPDATE attachments SET thumb_sha256 = sha256 WHERE id = $1`, a.ID)
	require.NoError(t, err)
	resp, body := alice.Raw(http.MethodGet, a.URL+"/thumbnail", nil, "", http.StatusOK)
	require.Equal(t, img, body)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
}

func TestMetadataIsStripped(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "photo.jpg", withSegments(jpegImage(40, 20), exifSegment(1, "SECRET-GPS")), http.StatusCreated)
	_, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.NotContains(t, string(body), "SECRET-GPS")
	require.Equal(t, 40, *a.Width)

	rotated := alice.Upload(ch, "phone.jpg", withSegments(jpegImage(40, 20), exifSegment(6, "SECRET-GPS")), http.StatusCreated)
	require.Equal(t, 20, *rotated.Width, "the EXIF rotation is applied")
	require.Equal(t, 40, *rotated.Height)
}

func TestNonImagesAreDownloadOnly(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "page.html", []byte("<html><script>alert(1)</script></html>"), http.StatusCreated)
	require.False(t, a.Inline)
	require.Nil(t, a.Width)
	resp, _ := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "application/octet-stream", resp.Header.Get("Content-Type"))
	require.Equal(t, "attachment; filename=page.html", resp.Header.Get("Content-Disposition"))

	broken := alice.Upload(ch, "broken.png", append(pngImage(4, 4, false)[:20], 0, 0, 0), http.StatusCreated)
	require.False(t, broken.Inline, "a corrupt image is kept as a plain file")
}

func TestMediaIsServedForPlaying(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "song.flac", []byte("fLaC\x00\x00\x00\x22rest of the stream"), http.StatusCreated)
	require.Equal(t, "audio/flac", a.ContentType)
	require.False(t, a.Inline, "inline is for images")
	resp, _ := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, "audio/flac", resp.Header.Get("Content-Type"))
	require.Equal(t, "inline; filename=song.flac", resp.Header.Get("Content-Disposition"))
	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Equal(t, "default-src 'none'; sandbox", resp.Header.Get("Content-Security-Policy"))
}

func TestFilenameIsSanitized(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "../../etc/passwd", []byte("x"), http.StatusCreated)
	require.Equal(t, "passwd", a.Filename)
}

func TestUploadPermissions(t *testing.T) {
	env, alice, bob, c, ch := setup(t)
	env.Outsider("eve").UploadFail(ch, "x.txt", []byte("x"), http.StatusNotFound, "NOT_FOUND")
	env.Anon().UploadFail(ch, "x.txt", []byte("x"), http.StatusUnauthorized, "UNAUTHORIZED")

	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	bob.UploadFail(ch, "x.txt", []byte("x"), http.StatusForbidden, "MISSING_PERMISSION")
}

func TestUploadLimit(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	_, err := env.Pool.Exec(context.Background(), `UPDATE instance_settings SET max_upload_bytes = 1048576`)
	require.NoError(t, err)
	alice.UploadFail(ch, "big.bin", make([]byte, 1048577), http.StatusRequestEntityTooLarge, "TOO_LARGE")
	alice.Upload(ch, "fits.bin", make([]byte, 1048576), http.StatusCreated)
}

func TestBadUploads(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	path := "/api/attachments?channel_id=" + ch.String()
	_, raw := alice.Raw(http.MethodPost, path, strings.NewReader("{}"), "application/json", http.StatusBadRequest)
	require.Equal(t, "VALIDATION_FAILED", errorCode(t, raw))

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	require.NoError(t, mw.WriteField("other", "value"))
	require.NoError(t, mw.Close())
	_, raw = alice.Raw(http.MethodPost, path, &buf, mw.FormDataContentType(), http.StatusBadRequest)
	require.Equal(t, "MISSING_FILE", errorCode(t, raw))
}

func TestIdenticalUploadsShareStorage(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "a.bin", []byte("same bytes"), http.StatusCreated)
	b := alice.Upload(ch, "b.bin", []byte("same bytes"), http.StatusCreated)
	require.NotEqual(t, a.ID, b.ID)
	require.Equal(t, 1, blobCount(t, env))
}

func TestSweepRemovesUnsentUploads(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "draft.png", pngImage(1000, 500, false), http.StatusCreated) // one blob
	require.Equal(t, 1, blobCount(t, env))

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK) // still fresh

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(25*time.Hour)))
	alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound)
	require.Equal(t, 0, blobCount(t, env))
}

func backdateBlobs(t *testing.T, env *apptest.Env) {
	old := time.Now().Add(-48 * time.Hour)
	entries, err := os.ReadDir(filepath.Join(env.DataDir, "files"))
	require.NoError(t, err)
	for _, e := range entries {
		if files.ValidSum(e.Name()) {
			require.NoError(t, os.Chtimes(filepath.Join(env.DataDir, "files", e.Name()), old, old))
		}
	}
}

func TestSweepKeepsAgedBlobsStillReferenced(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "draft.png", pngImage(1000, 500, false), http.StatusCreated) // one blob
	backdateBlobs(t, env)

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	require.Equal(t, 1, blobCount(t, env))
	alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
}

func TestSweepRemovesAgedOrphanBlobs(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	alice.Upload(ch, "draft.png", pngImage(1000, 500, false), http.StatusCreated)
	_, err := env.Pool.Exec(context.Background(), `DELETE FROM attachments`)
	require.NoError(t, err)
	require.Equal(t, 1, blobCount(t, env))

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	require.Equal(t, 1, blobCount(t, env), "fresh orphans are kept")
	backdateBlobs(t, env)
	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now()))
	require.Equal(t, 0, blobCount(t, env))
}

func TestHugeImagesAreDownloads(t *testing.T) {
	_, alice, _, _, ch := setup(t)
	huge := alice.Upload(ch, "huge.png", pngClaiming(7000, 6000), http.StatusCreated)
	require.False(t, huge.Inline, "over MaxDecodePixels: no client should decode it")
	require.Equal(t, 7000, *huge.Width)
	require.Empty(t, huge.ThumbnailURL)
	resp, _ := alice.Raw(http.MethodGet, huge.URL, nil, "", http.StatusOK)
	require.Equal(t, "application/octet-stream", resp.Header.Get("Content-Type"))
	require.Equal(t, "attachment; filename=huge.png", resp.Header.Get("Content-Disposition"))

	big := alice.Upload(ch, "big.gif", gifClaiming(5000, 5000), http.StatusCreated)
	require.False(t, big.Inline, "GIFs over 4096x4096 pixels are downloads")
	resp, _ = alice.Raw(http.MethodGet, big.URL, nil, "", http.StatusOK)
	require.Equal(t, "attachment; filename=big.gif", resp.Header.Get("Content-Disposition"))

	ok := alice.Upload(ch, "ok.gif", gifClaiming(4096, 4096), http.StatusCreated)
	require.True(t, ok.Inline)
}

func TestDownloadNeedsChannelAccess(t *testing.T) {
	env, alice, bob, c, ch := setup(t)
	a := alice.Upload(ch, "wide.png", pngImage(1000, 500, false), http.StatusCreated)
	alice.SendWith(ch, "", a.ID)
	var dm struct {
		ID id.ID `json:"id"`
	}
	alice.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{bob.User.ID.String()}}, http.StatusOK, &dm) // while they share the server
	can := func(u *apptest.Client, want int) {
		t.Helper()
		u.Raw(http.MethodGet, a.URL, nil, "", want)
		u.Raw(http.MethodGet, a.URL+"?w=64", nil, "", want)
	}
	can(bob, http.StatusOK)
	can(env.Outsider("eve"), http.StatusNotFound)

	ov := "/api/channels/" + ch.String() + "/overrides/role/" + c.ID.String()
	alice.Do(http.MethodPut, ov, map[string]any{"allow": 0, "deny": uint64(perms.ReadHistory)}, http.StatusOK, nil)
	can(bob, http.StatusNotFound)
	alice.Do(http.MethodDelete, ov, nil, http.StatusNoContent, nil)
	can(bob, http.StatusOK)

	alice.Do(http.MethodDelete, "/api/server/members/"+bob.User.ID.String(), nil, http.StatusNoContent, nil)
	can(bob, http.StatusNotFound)

	a = alice.Upload(dm.ID, "wide.png", pngImage(1000, 500, false), http.StatusCreated)
	alice.SendWith(dm.ID, "", a.ID)
	can(alice, http.StatusOK)
	can(bob, http.StatusOK)
	can(env.Register("carol"), http.StatusNotFound)
}

func TestStaleUploadCannotBeSent(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "old.txt", []byte("old"), http.StatusCreated)
	_, err := env.Pool.Exec(context.Background(), `UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = $1`, a.ID)
	require.NoError(t, err)
	alice.Fail(http.MethodPost, "/api/channels/"+ch.String()+"/messages",
		map[string]any{"content": "late", "attachment_ids": []string{a.ID.String()}}, http.StatusBadRequest, "ATTACHMENT_INVALID")
}

func TestStartSweepsImmediately(t *testing.T) {
	env, alice, _, _, ch := setup(t)
	a := alice.Upload(ch, "old.txt", []byte("old"), http.StatusCreated)
	_, err := env.Pool.Exec(context.Background(), `UPDATE attachments SET created_at = now() - interval '25 hours' WHERE id = $1`, a.ID)
	require.NoError(t, err)
	store, err := files.NewLocalStore(filepath.Join(env.DataDir, "files"))
	require.NoError(t, err)
	svc := files.NewService(env.Pool, store, nil, nil)
	svc.Start()
	t.Cleanup(svc.Close)
	require.Eventually(t, func() bool {
		var n int
		err := env.Pool.QueryRow(context.Background(), `SELECT count(*) FROM attachments WHERE id = $1`, a.ID).Scan(&n)
		return err == nil && n == 0
	}, 5*time.Second, 50*time.Millisecond)
}

func TestSweepKeepsServerImages(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	alice.UploadTo(http.MethodPut, "/api/server/icon", "icon.png", pngImage(64, 64, false), http.StatusOK)
	backdateBlobs(t, env)

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(48*time.Hour)))
	require.Equal(t, 1, blobCount(t, env))
	env.Anon().Raw(http.MethodGet, "/api/server/icon", nil, "", http.StatusOK)
}

func TestSweepKeepsEmoji(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	require.NoError(t, mw.WriteField("name", "blob"))
	fw, err := mw.CreateFormFile("file", "blob.png")
	require.NoError(t, err)
	_, _ = fw.Write(pngImage(32, 32, false))
	require.NoError(t, mw.Close())
	_, raw := alice.Raw(http.MethodPost, "/api/server/emoji", &body, mw.FormDataContentType(), http.StatusCreated)
	var e struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal(raw, &e))
	backdateBlobs(t, env)

	require.NoError(t, env.App.Files.Sweep(context.Background(), time.Now().Add(48*time.Hour)))
	require.Equal(t, 1, blobCount(t, env))
	env.Anon().Raw(http.MethodGet, e.URL, nil, "", http.StatusOK)
}

func TestUploadRefusesWelcomeChannel(t *testing.T) {
	_, alice, _, _, _ := setup(t)
	var welcomeID id.ID
	for _, ch := range alice.Channels() {
		if ch.Type == "welcome" {
			welcomeID = ch.ID
		}
	}
	require.NotZero(t, welcomeID)
	alice.UploadFail(welcomeID, "x.txt", []byte("x"), http.StatusBadRequest, "NO_MESSAGES_HERE")
}

// An album upload has no message but is not an abandoned upload: the sweep keeps it.
func TestSweepKeepsAlbumUploads(t *testing.T) {
	env := apptest.New(t)
	alice := env.Register("alice")
	ctx := context.Background()
	albumID := id.New()
	_, err := env.Pool.Exec(ctx, `INSERT INTO albums (id, owner_id, title) VALUES ($1, $2, 'Trip')`, albumID, alice.User.ID)
	require.NoError(t, err)
	attID := id.New()
	_, err = env.Pool.Exec(ctx, `INSERT INTO attachments (id, album_id, uploader_id, filename, content_type, size, sha256, created_at)
		VALUES ($1, $2, $3, 'a.txt', 'text/plain', 1, 'deadbeef', now() - interval '2 days')`, attID, albumID, alice.User.ID)
	require.NoError(t, err)

	require.NoError(t, env.App.Files.Sweep(ctx, time.Now()))

	var n int
	require.NoError(t, env.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments WHERE id = $1`, attID).Scan(&n))
	require.Equal(t, 1, n)
}
