package files_test

import (
	"bytes"
	"context"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

func TestSaveGIF(t *testing.T) {
	env, alice, bob, c, ch := setup(t)
	ctx := context.Background()
	svc := env.App.Files

	limit, err := svc.UploadLimit(ctx, alice.User.ID, ch)
	require.NoError(t, err)
	require.Equal(t, int64(52428800), limit)

	video := mp4Video(2048)
	a, err := svc.SaveGIF(ctx, ch, alice.User.ID, "Happy cat.mp4", bytes.NewReader(video), limit, 498, 373)
	require.NoError(t, err)
	require.True(t, a.GIF)
	require.Equal(t, "video/mp4", a.ContentType)
	require.Equal(t, "Happy cat.mp4", a.Filename)
	require.False(t, a.Inline)
	require.Equal(t, 498, *a.Width, "an MP4 keeps the provider's size")
	require.Equal(t, 373, *a.Height)

	resp, body := alice.Raw(http.MethodGet, a.URL, nil, "", http.StatusOK)
	require.Equal(t, video, body)
	require.Equal(t, "video/mp4", resp.Header.Get("Content-Type"))
	bob.Raw(http.MethodGet, a.URL, nil, "", http.StatusNotFound) // unsent: private, like any upload

	m := alice.SendWith(ch, "look", a.ID)
	require.Len(t, m.Attachments, 1)
	require.True(t, m.Attachments[0].GIF)
	var history []messages.Message
	bob.Do(http.MethodGet, "/api/channels/"+ch.String()+"/messages", nil, http.StatusOK, &history)
	found := false
	for _, h := range history {
		if h.ID == m.ID {
			require.True(t, h.Attachments[0].GIF, "the flag survives a reload")
			found = true
		}
	}
	require.True(t, found)

	// A WebP/GIF fallback is an image: it is measured, and gets no still thumbnail.
	still := pngImage(600, 500, false)
	img, err := svc.SaveGIF(ctx, ch, alice.User.ID, "Wave.png", bytes.NewReader(still), limit, 99, 99)
	require.NoError(t, err)
	require.True(t, img.GIF)
	require.True(t, img.Inline)
	require.Equal(t, 600, *img.Width, "the measured size wins")
	require.Empty(t, img.ThumbnailURL, "a thumbnail would stop the animation")

	// Over the limit: 413, and nothing is stored.
	_, err = svc.SaveGIF(ctx, ch, alice.User.ID, "big.mp4", bytes.NewReader(mp4Video(2048)), 1024, 1, 1)
	var he *httpx.Error
	require.ErrorAs(t, err, &he)
	require.Equal(t, http.StatusRequestEntityTooLarge, he.Status)
	require.Equal(t, "TOO_LARGE", he.Code)
	var n int
	require.NoError(t, env.Pool.QueryRow(ctx, `SELECT count(*) FROM attachments`).Scan(&n))
	require.Equal(t, 2, n, "only the two saved GIFs")

	// UploadLimit refuses where uploads are refused.
	alice.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.AttachFiles)}, http.StatusOK, nil)
	_, err = svc.UploadLimit(ctx, bob.User.ID, ch)
	require.ErrorAs(t, err, &he)
	require.Equal(t, "MISSING_PERMISSION", he.Code)
}
