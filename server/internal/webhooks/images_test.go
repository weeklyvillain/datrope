package webhooks

import (
	"bytes"
	"fmt"
	"image"
	"image/png"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/linkpreview"
)

func testPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2))))
	return b.Bytes()
}

func allowAll(net.IP) bool { return true }

func pngServer(img []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(img)
	}))
}

func TestFetchImage(t *testing.T) {
	img := testPNG(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/a.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(img)
	})
	mux.HandleFunc("/page", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html></html>"))
	})
	mux.HandleFunc("/big.png", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(make([]byte, maxImageBytes+1))
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/a.png", http.StatusFound) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	f := &fetcher{allow: allowAll}
	ctx := t.Context()

	data, err := f.fetchImage(ctx, srv.URL+"/a.png")
	require.NoError(t, err)
	require.Equal(t, img, data)
	data, err = f.fetchImage(ctx, srv.URL+"/redirect")
	require.NoError(t, err)
	require.Equal(t, img, data)
	_, err = f.fetchImage(ctx, srv.URL+"/page")
	require.ErrorContains(t, err, "not an image")
	_, err = f.fetchImage(ctx, srv.URL+"/big.png")
	require.ErrorContains(t, err, "too large")
	_, err = f.fetchImage(ctx, srv.URL+"/missing.png")
	require.ErrorContains(t, err, "status 404")
	_, err = f.fetchImage(ctx, "ftp://example.com/a.png")
	require.ErrorContains(t, err, "unsupported URL")
}

func TestFetchImageRefusesPrivateAddresses(t *testing.T) {
	srv := pngServer(testPNG(t))
	defer srv.Close()
	f := &fetcher{allow: linkpreview.Public} // the default
	for _, u := range []string{
		srv.URL + "/a.png", // 127.0.0.1
		"http://10.0.0.1/a.png", "http://192.168.1.1/a.png", "http://172.16.0.1/a.png",
		"http://169.254.169.254/latest/meta-data", "http://[::1]/a.png", "http://0.0.0.0/a.png",
	} {
		_, err := f.fetchImage(t.Context(), u)
		require.ErrorIs(t, err, linkpreview.ErrBlockedAddress, u)
	}
}

// A redirect target is dialled, and so checked, again.
func TestFetchImageChecksRedirects(t *testing.T) {
	target := pngServer(testPNG(t))
	defer target.Close()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/a.png", http.StatusFound)
	}))
	defer front.Close()
	dials := 0
	f := &fetcher{allow: func(net.IP) bool { dials++; return dials == 1 }} // the front server only
	_, err := f.fetchImage(t.Context(), front.URL)
	require.ErrorIs(t, err, linkpreview.ErrBlockedAddress)
	require.Equal(t, 2, dials)
}

func TestFetchAll(t *testing.T) {
	img := testPNG(t)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(img)
	}))
	defer srv.Close()
	f := &fetcher{allow: allowAll}
	var urls []string
	for i := range 14 {
		urls = append(urls, fmt.Sprintf("%s/%d.png", srv.URL, i))
	}
	got := f.fetchAll(t.Context(), urls)
	require.Len(t, got, maxImages)
	require.Contains(t, got, urls[0])
	require.NotContains(t, got, urls[12], "only the first 12 are fetched")
	require.EqualValues(t, maxImages, hits.Load())
	require.Empty(t, f.fetchAll(t.Context(), []string{srv.URL + "/missing"}))
	require.Empty(t, f.fetchAll(t.Context(), nil))
}
