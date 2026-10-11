// Package linkpreview fetches text previews of links (spec §5) without
// letting a message make the server reach private networks.
package linkpreview

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

const (
	maxBody      = 1 << 20
	fetchTimeout = 5 * time.Second
	maxRedirects = 3
)

// ErrBlockedAddress is the error for a URL that resolves (or redirects) to an
// address that is not allowed: private, loopback, link-local and the like.
var ErrBlockedAddress = errors.New("address not allowed")

var blockedNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
		"192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
		"224.0.0.0/4", "240.0.0.0/4",
		"::/96", "::1/128", "64:ff9b::/96", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
	} {
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}()

// Blocked reports whether ip is not a public unicast address.
func Blocked(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		ip = v4 // also catches IPv4-mapped IPv6
	}
	for _, n := range blockedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Public reports whether ip may be dialled for a URL someone else supplied.
func Public(ip net.IP) bool { return !Blocked(ip) }

// LogURL is rawURL cut to its scheme and host, for logs: the path and query
// of a URL someone else supplied can carry signed tokens.
func LogURL(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" {
		return "(invalid URL)"
	}
	return u.Scheme + "://" + u.Host
}

// NewClient returns an HTTP client for URLs someone else supplied. Every
// address it dials must pass allow, checked after DNS resolution and so on
// every redirect. It never uses an environment proxy, follows at most
// maxRedirects http(s) redirects and gives up after timeout.
func NewClient(allow func(net.IP) bool, timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout: timeout,
		Control: func(network, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			if !allow(net.ParseIP(host)) {
				return ErrBlockedAddress
			}
			return nil
		},
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                  nil, // never through an environment proxy: it would dial for us
			DialContext:            dialer.DialContext,
			TLSHandshakeTimeout:    timeout,
			ResponseHeaderTimeout:  timeout,
			MaxResponseHeaderBytes: 64 << 10,
		},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return errors.New("too many redirects")
			}
			if req.URL.Scheme != "http" && req.URL.Scheme != "https" {
				return errors.New("redirect to an unsupported scheme")
			}
			return nil
		},
	}
}

func fetch(ctx context.Context, rawURL string) (*Preview, error) {
	return fetchWith(ctx, rawURL, Public)
}

// fetchWith fetches and parses a page; allow decides every address dialled
// (after DNS resolution, on every redirect).
func fetchWith(ctx context.Context, rawURL string, allow func(net.IP) bool) (*Preview, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("link preview: unsupported URL %q", rawURL)
	}
	u.User = nil // never send credentials from a message
	if isYouTube(u) {
		if p, err := fetchYouTube(ctx, u.String(), allow); err == nil {
			return p, nil
		}
		// Not a video (a channel, a playlist) or oEmbed is down: read the page.
	}
	client := NewClient(allow, fetchTimeout)
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Datrope link preview (+https://github.com/datrope/datrope)")
	req.Header.Set("Accept", "text/html")
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, ErrBlockedAddress) {
			return nil, ErrBlockedAddress
		}
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("link preview: status %d", res.StatusCode)
	}
	if mt, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type")); mt != "text/html" {
		return nil, fmt.Errorf("link preview: not HTML (%s)", mt)
	}
	p, ok := Parse(io.LimitReader(res.Body, maxBody), res.Request.URL)
	if !ok {
		return nil, errors.New("link preview: no title")
	}
	p.URL = rawURL // the link as written, not where it redirected
	return p, nil
}
