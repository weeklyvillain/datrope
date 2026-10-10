package gifs

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/id"
)

func file(u string, size int64) klipyFile { return klipyFile{URL: u, Width: 10, Height: 8, Size: size} }

func TestRendition(t *testing.T) {
	it := klipyItem{File: map[string]map[string]klipyFile{
		"hd": {"mp4": file("hd.mp4", 9<<20), "webp": file("hd.webp", 1<<20), "gif": file("hd.gif", 5<<20)},
		"md": {"mp4": file("md.mp4", 2<<20)},
		"sm": {"mp4": file("sm.mp4", 0)}, // size unknown: tried, the download cap still applies
	}}
	f, format, ok := rendition(it, 8<<20)
	require.True(t, ok)
	require.Equal(t, "md.mp4", f.URL, "the largest MP4 that fits")
	require.Equal(t, "mp4", format)

	f, _, ok = rendition(it, 1<<20)
	require.True(t, ok)
	require.Equal(t, "sm.mp4", f.URL)

	noMP4 := klipyItem{File: map[string]map[string]klipyFile{
		"hd": {"webp": file("hd.webp", 3<<20), "gif": file("hd.gif", 1<<20), "mp4": file("", 10)},
	}}
	f, format, ok = rendition(noMP4, 8<<20)
	require.True(t, ok)
	require.Equal(t, "hd.webp", f.URL, "WebP before GIF; an empty URL does not count")
	require.Equal(t, "webp", format)

	onlyGIF := klipyItem{File: map[string]map[string]klipyFile{"xs": {"gif": file("xs.gif", 100)}}}
	_, format, ok = rendition(onlyGIF, 8<<20)
	require.True(t, ok)
	require.Equal(t, "gif", format)

	_, _, ok = rendition(noMP4, 1000)
	require.False(t, ok, "nothing fits")
	_, _, ok = rendition(klipyItem{}, 8<<20)
	require.False(t, ok)
}

func TestPreview(t *testing.T) {
	it := klipyItem{File: map[string]map[string]klipyFile{
		"hd": {"webp": file("hd.webp", 1)},
		"sm": {"webp": file("sm.webp", 1), "gif": file("sm.gif", 1)},
		"xs": {"webp": file("xs.webp", 1)},
	}}
	f, ok := preview(it)
	require.True(t, ok)
	require.Equal(t, "sm.webp", f.URL)

	delete(it.File["sm"], "webp")
	f, _ = preview(it)
	require.Equal(t, "xs.webp", f.URL)

	f, _ = preview(klipyItem{File: map[string]map[string]klipyFile{"sm": {"gif": file("sm.gif", 1)}}})
	require.Equal(t, "sm.gif", f.URL)

	_, ok = preview(klipyItem{File: map[string]map[string]klipyFile{"hd": {"mp4": file("hd.mp4", 1)}}})
	require.False(t, ok, "no image preview: the entry is dropped")
}

func TestIsGIF(t *testing.T) {
	require.True(t, isGIF(klipyItem{Type: "gif", Slug: "hello-hi-662"}))
	require.True(t, isGIF(klipyItem{Slug: "no-type-1"}), "an entry without a type is treated as a GIF")
	require.False(t, isGIF(klipyItem{Type: "ad"}))
	require.False(t, isGIF(klipyItem{Type: "sticker", Slug: "s-1"}))
	require.False(t, isGIF(klipyItem{Type: "gif", Slug: "a,b"}), "slugs are looked up in a comma list")
	require.False(t, isGIF(klipyItem{Type: "gif", Slug: ""}))
}

func TestCustomerID(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	a := customerID(secret, id.ID(12345))
	require.Regexp(t, `^[0-9a-f]{64}$`, a)
	require.NotContains(t, a, "12345")
	require.Equal(t, a, customerID(secret, id.ID(12345)), "stable per user")
	require.NotEqual(t, a, customerID(secret, id.ID(12346)))
	require.NotEqual(t, a, customerID([]byte("another secret"), id.ID(12345)))

	m := hmac.New(sha256.New, secret)
	m.Write([]byte("12345"))
	require.Equal(t, hex.EncodeToString(m.Sum(nil)), a)
}

func TestRedactDropsTheURL(t *testing.T) {
	err := &url.Error{Op: "Get", URL: "https://api.klipy.com/api/v1/secret-key/gifs/trending", Err: errors.New("connection refused")}
	require.NotContains(t, redact(err).Error(), "secret-key")
	require.Equal(t, "connection refused", redact(err).Error())
	plain := errors.New("plain")
	require.Equal(t, plain, redact(plain))
}

func TestUpstreamErrorsDoNotLeakTheKey(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	base := srv.URL
	srv.Close() // connection refused from here on
	k := &klipy{base: base, client: http.DefaultClient}

	_, err := k.list(context.Background(), "SECRETKEY123", "trending", url.Values{"q": {"x"}})
	require.Error(t, err)
	require.ErrorIs(t, err, errUpstream)
	require.NotContains(t, err.Error(), "SECRETKEY123")

	_, err = k.download(context.Background(), base+"/media/SECRETKEY123/a.mp4")
	require.Error(t, err)
	require.ErrorIs(t, err, errUpstream)
	require.NotContains(t, err.Error(), "SECRETKEY123")
}
