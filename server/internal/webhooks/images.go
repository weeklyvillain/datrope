package webhooks

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/linkpreview"
)

const (
	maxImageBytes = 2 << 20          // per image
	maxImages     = 12               // per message, the avatar included
	imageTimeout  = 5 * time.Second  // per image
	imagesBudget  = 10 * time.Second // for all of a message's images
)

var imageTypes = map[string]bool{"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true}

// fetcher downloads the remote images a webhook message names, through
// linkpreview's guarded client: allow decides every address dialled.
type fetcher struct {
	allow func(net.IP) bool
}

// fetchImage downloads one image: a 200 answer with an image Content-Type
// and at most maxImageBytes of body.
func (f *fetcher) fetchImage(ctx context.Context, rawURL string) ([]byte, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("webhook image: unsupported URL")
	}
	u.User = nil // never send credentials from a message
	client := linkpreview.NewClient(f.allow, imageTimeout)
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Datrope webhook images (+https://github.com/datrope/datrope)")
	req.Header.Set("Accept", "image/png, image/jpeg, image/gif, image/webp")
	res, err := client.Do(req)
	if err != nil {
		var ue *url.Error // it repeats the URL, which can carry a signed token
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return nil, fmt.Errorf("webhook image: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("webhook image: status %d", res.StatusCode)
	}
	if mt, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type")); !imageTypes[mt] {
		return nil, fmt.Errorf("webhook image: not an image (%s)", mt)
	}
	if res.ContentLength > maxImageBytes {
		return nil, errors.New("webhook image: too large")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxImageBytes {
		return nil, errors.New("webhook image: too large")
	}
	return data, nil
}

// fetchAll downloads the first maxImages of urls (distinct, as
// WebhookPost.ImageURLs lists them) at once, within imagesBudget. It returns
// the bytes of those that worked; the others are logged and left out.
func (f *fetcher) fetchAll(ctx context.Context, urls []string) map[string][]byte {
	if len(urls) > maxImages {
		urls = urls[:maxImages]
	}
	out := map[string][]byte{}
	if len(urls) == 0 {
		return out
	}
	ctx, cancel := context.WithTimeout(ctx, imagesBudget)
	defer cancel()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, u := range urls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			data, err := f.fetchImage(ctx, u)
			if err != nil {
				slog.InfoContext(ctx, "webhook image dropped", "url", linkpreview.LogURL(u), "err", err)
				return
			}
			mu.Lock()
			out[u] = data
			mu.Unlock()
		}()
	}
	wg.Wait()
	return out
}
