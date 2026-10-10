package linkpreview

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestBlocked(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
		"0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "fd12::1", "::", "ff02::1",
		"::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "198.18.0.1", "192.0.0.1", "::7f00:1",
		"2001::1", "2001:0:4136:e378::1", "2002:7f00:1::1", "2002::1"}
	for _, s := range blocked {
		require.True(t, Blocked(net.ParseIP(s)), s)
	}
	for _, s := range []string{"1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		require.False(t, Blocked(net.ParseIP(s)), s)
	}
}

func allowAll(net.IP) bool { return true }

func TestFetchLimits(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/text", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("<title>not html</title>"))
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><head><title>Big page</title>"))
		_, _ = w.Write([]byte(strings.Repeat("<!-- padding -->", (2<<20)/16)))
		_, _ = w.Write([]byte(`<meta name="description" content="past the limit"></head></html>`))
	})
	mux.HandleFunc("/redirect/{n}", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.PathValue("n"))
		if n == 0 {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write([]byte("<title>Landed</title>"))
			return
		}
		http.Redirect(w, r, "/redirect/"+strconv.Itoa(n-1), http.StatusFound)
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(6 * time.Second):
		case <-r.Context().Done():
		}
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := t.Context()

	_, err := fetchWith(ctx, srv.URL+"/text", allowAll)
	require.ErrorContains(t, err, "not HTML")

	p, err := fetchWith(ctx, srv.URL+"/big", allowAll)
	require.NoError(t, err)
	require.Equal(t, "Big page", p.Title)
	require.Empty(t, p.Description) // beyond the first 1 MB
	require.Equal(t, srv.URL+"/big", p.URL)

	p, err = fetchWith(ctx, srv.URL+"/redirect/3", allowAll)
	require.NoError(t, err)
	require.Equal(t, "Landed", p.Title)
	require.Equal(t, srv.URL+"/redirect/3", p.URL) // the link as written
	_, err = fetchWith(ctx, srv.URL+"/redirect/4", allowAll)
	require.ErrorContains(t, err, "too many redirects")

	start := time.Now()
	_, err = fetchWith(ctx, srv.URL+"/slow", allowAll)
	require.Error(t, err)
	require.Less(t, time.Since(start), 6*time.Second)
}

// A redirect target is dialled, and so checked, again.
func TestFetchChecksRedirects(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<title>secret</title>"))
	}))
	defer target.Close()
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer front.Close()
	dials := 0
	allowFirst := func(net.IP) bool { dials++; return dials == 1 } // the front server only
	_, err := fetchWith(t.Context(), front.URL, allowFirst)
	require.ErrorIs(t, err, ErrBlockedAddress)
	require.Equal(t, 2, dials)
}
