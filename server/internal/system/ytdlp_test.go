package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/music"
)

// fakeGitHub serves a latest release whose yt-dlp asset is body; sums is its SHA2-256SUMS file.
func fakeGitHub(t *testing.T, tag string, body []byte, sums string) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/yt-dlp/yt-dlp/releases/latest":
			fmt.Fprintf(w, `{"tag_name":%q,"assets":[{"name":"yt-dlp","browser_download_url":"%s/dl/yt-dlp"},{"name":"yt-dlp.exe","browser_download_url":"%s/dl/exe"},{"name":"SHA2-256SUMS","browser_download_url":"%s/dl/sums"}]}`, tag, srv.URL, srv.URL, srv.URL)
		case "/dl/yt-dlp":
			_, _ = w.Write(body)
		case "/dl/sums":
			_, _ = w.Write([]byte(sums))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// fakeVersion: a file containing "good-<v>" reports version v; anything else fails like a broken binary.
func fakeVersion(_ context.Context, path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var v string
	if _, err := fmt.Sscanf(string(b), "good-%s", &v); err != nil {
		return "", fmt.Errorf("exec format error")
	}
	return v, nil
}

func newTestYtDlp(t *testing.T, api string) (*YtDlp, *music.YtDlpPath, string) {
	dir := t.TempDir()
	old := filepath.Join(dir, "image-yt-dlp")
	require.NoError(t, os.WriteFile(old, []byte("good-2026.01.01"), 0o755))
	p := music.NewYtDlpPath(old)
	return NewYtDlp(YtDlpOptions{Path: p, Managed: ManagedYtDlp(dir), API: api, Version: fakeVersion}), p, old
}

func TestYtDlpCheck(t *testing.T) {
	gh := fakeGitHub(t, "2026.10.01", nil, "")
	y, _, _ := newTestYtDlp(t, gh.URL)
	require.NoError(t, y.Check(context.Background()))
	st := y.Status()
	require.Equal(t, "2026.01.01", st.Installed)
	require.Equal(t, "2026.10.01", st.Latest)
	require.True(t, st.Available)
	require.NotNil(t, st.CheckedAt)
}

func TestYtDlpUpdate(t *testing.T) {
	bin := []byte("good-2026.10.01")
	gh := fakeGitHub(t, "2026.10.01", bin, sum([]byte("other"))+"  yt-dlp.exe\n"+sum(bin)+"  yt-dlp\n")
	y, p, _ := newTestYtDlp(t, gh.URL)
	require.NoError(t, y.Update(context.Background()))

	managed := y.opts.Managed
	require.Equal(t, managed, p.Get(), "music now uses the updated copy")
	got, err := os.ReadFile(managed)
	require.NoError(t, err)
	require.Equal(t, bin, got)
	require.Equal(t, "2026.10.01", y.Status().Installed)
	_, err = os.Stat(managed + ".tmp")
	require.True(t, os.IsNotExist(err))
}

func TestYtDlpUpdateKeepsOldBinaryOnFailure(t *testing.T) {
	cases := map[string]struct {
		body []byte
		sums string
	}{
		"checksum mismatch":       {[]byte("good-2026.10.01"), sum([]byte("tampered")) + "  yt-dlp\n"},
		"not in SHA2-256SUMS":     {[]byte("good-2026.10.01"), sum([]byte("x")) + "  yt-dlp.exe\n"},
		"new binary will not run": {[]byte("garbage"), sum([]byte("garbage")) + "  yt-dlp\n"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			gh := fakeGitHub(t, "2026.10.01", c.body, c.sums)
			y, p, old := newTestYtDlp(t, gh.URL)
			require.Error(t, y.Update(context.Background()))
			require.Equal(t, old, p.Get())
			_, err := os.Stat(y.opts.Managed)
			require.True(t, os.IsNotExist(err), "nothing installed")
			_, err = os.Stat(y.opts.Managed + ".tmp")
			require.True(t, os.IsNotExist(err), "no temp file left behind")
			require.NotEmpty(t, y.Status().Error)
		})
	}
}

func TestYtDlpPinned(t *testing.T) {
	y := NewYtDlp(YtDlpOptions{Path: music.NewYtDlpPath("/opt/yt-dlp"), Pinned: true, Version: fakeVersion})
	require.ErrorIs(t, y.Update(context.Background()), ErrPinned)
	require.True(t, y.Status().Pinned)
}
