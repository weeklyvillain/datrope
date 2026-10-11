package files

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"fmt"
	"image/gif"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sync/singleflight"
)

// variantBuckets are the sizes clients may ask for with ?w=. A variant fits
// in bucket x bucket; fixed sizes keep the cache small and stop anyone
// requesting every width.
var variantBuckets = []int{32, 64, 128, 256, 512, 1024, 1600}

// variantTimeout bounds making one variant, waiting for a slot included (a variable for tests).
var variantTimeout = 30 * time.Second

// variantSlots, when set by tests, replaces GOMAXPROCS as the number of concurrent imgproxy requests.
var variantSlots int

// imgproxy loads at most IMGPROXY_MAX_ANIMATION_FRAMES frames and silently
// drops the rest, and with IMGPROXY_MAX_ANIMATION_FRAME_RESOLUTION set it
// checks only each frame's size. So GIFs with more frames, or more pixels in
// all (imgproxy holds every frame, 4 bytes a pixel), are not sent to it: their
// originals are served instead of a cut-short or memory-hungry variant.
const (
	maxVariantFrames    = 256      // IMGPROXY_MAX_ANIMATION_FRAMES in deploy/docker-compose.yml
	maxVariantGIFPixels = 64 << 20 // frames x width x height
)

// variantTypes are the stored image types imgproxy resizes.
var variantTypes = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true, "image/gif": true}

// bucket snaps a requested width up to a bucket; ok is false for a missing or invalid one.
func bucket(raw string) (int, bool) {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, false
	}
	for _, b := range variantBuckets {
		if n <= b {
			return b, true
		}
	}
	return variantBuckets[len(variantBuckets)-1], true
}

// variants makes resized copies of stored images with imgproxy and keeps
// them in dir/<sum>/<bucket>.<webp|orig>.
type variants struct {
	dir      string
	upstream string // imgproxy's base URL; "" turns variants off
	store    Store
	client   *http.Client
	slots    chan struct{} // bounds concurrent imgproxy requests
	group    singleflight.Group
}

// variant is a cached resized copy, ready to serve.
type variant struct{ path, contentType, etag string }

// SetVariants keeps resized images under dir, made by the imgproxy at
// imgproxyURL. With "" originals are served, but dir is still cleaned up.
func (s *Service) SetVariants(dir, imgproxyURL string) error {
	if err := os.MkdirAll(filepath.Join(dir, "tmp"), 0o750); err != nil {
		return err
	}
	s.variants = &variants{
		dir:      dir,
		upstream: strings.TrimSuffix(imgproxyURL, "/"),
		store:    s.store,
		client:   &http.Client{},
		slots:    make(chan struct{}, cmp.Or(variantSlots, runtime.GOMAXPROCS(0))),
	}
	return nil
}

func (s *Service) variantsOn() bool { return s.variants != nil && s.variants.upstream != "" }

// variantFor returns the variant of a stored image that r asks for with ?w=.
// asked is false when r asks for none (or variants are off); v is nil when
// one was asked for but could not be made.
func (s *Service) variantFor(r *http.Request, sum, contentType string) (v *variant, asked bool) {
	if !s.variantsOn() || !variantTypes[contentType] || !ValidSum(sum) {
		return nil, false
	}
	b, ok := bucket(r.URL.Query().Get("w"))
	if !ok {
		return nil, false
	}
	format, ct := "orig", contentType
	if strings.Contains(r.Header.Get("Accept"), "image/webp") {
		format, ct = "webp", "image/webp"
	}
	vs := s.variants
	out := &variant{
		path:        filepath.Join(vs.dir, sum, strconv.Itoa(b)+"."+format),
		contentType: ct,
		etag:        fmt.Sprintf(`"%s-%d-%s"`, sum, b, format),
	}
	if _, err := os.Stat(out.path); err == nil {
		return out, true
	}
	_, err, _ := vs.group.Do(out.path, func() (any, error) {
		// Shared by everyone waiting on this variant, so one viewer leaving does
		// not cancel it. The deadline covers waiting for a slot too.
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), variantTimeout)
		defer cancel()
		return nil, vs.make(ctx, sum, contentType, b, format, out.path)
	})
	if err != nil {
		slog.InfoContext(r.Context(), "files: serving the original image", "sum", sum, "w", b, "err", err)
		return nil, true
	}
	return out, true
}

// make asks imgproxy for a variant and stores it at dst.
func (vs *variants) make(ctx context.Context, sum, contentType string, b int, format, dst string) error {
	if _, err := os.Stat(dst); err == nil {
		return nil // made while this request waited
	}
	select {
	case vs.slots <- struct{}{}:
		defer func() { <-vs.slots }()
	case <-ctx.Done():
		return ctx.Err()
	}
	if contentType == "image/gif" {
		if err := vs.checkGIF(sum); err != nil {
			return err
		}
	}
	src := "local:///" + sum
	if format == "webp" {
		src += "@webp"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("%s/insecure/rs:fit:%d:%d:0/plain/%s", vs.upstream, b, b, src), nil)
	if err != nil {
		return err
	}
	resp, err := vs.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("imgproxy: %s", resp.Status)
	}
	f, err := os.CreateTemp(filepath.Join(vs.dir, "tmp"), "variant-*")
	if err != nil {
		return err
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, maxImageBytes+1))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	switch {
	case err != nil:
	case n == 0:
		err = errors.New("imgproxy: empty response")
	case n > maxImageBytes:
		err = ErrTooLarge
	default:
		if err = os.MkdirAll(filepath.Dir(dst), 0o750); err == nil {
			err = os.Rename(f.Name(), dst)
		}
	}
	if err != nil {
		_ = os.Remove(f.Name())
	}
	return err
}

// checkGIF fails for a GIF imgproxy would cut short or need too much memory for.
func (vs *variants) checkGIF(sum string) error {
	f, err := vs.store.Open(sum)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxImageBytes+1))
	if err != nil {
		return err
	}
	frames, err := gifFrames(data)
	if err != nil {
		return err
	}
	cfg, err := gif.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return err
	}
	if frames > maxVariantFrames || frames*cfg.Width*cfg.Height > maxVariantGIFPixels {
		return fmt.Errorf("gif too big to resize: %d frames of %dx%d", frames, cfg.Width, cfg.Height)
	}
	return nil
}

// remove deletes a blob's variants. It is safe on a nil receiver.
func (vs *variants) remove(sum string) error {
	if vs == nil || !ValidSum(sum) {
		return nil
	}
	return os.RemoveAll(filepath.Join(vs.dir, sum))
}

// removeStaleTemp deletes partial variants left by crashes. It is safe on a nil receiver.
func (vs *variants) removeStaleTemp(before time.Time) error {
	if vs == nil {
		return nil
	}
	tmp := filepath.Join(vs.dir, "tmp")
	entries, err := os.ReadDir(tmp)
	if errors.Is(err, os.ErrNotExist) {
		return nil // nothing to clean up
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.ModTime().Before(before) {
			continue // removed meanwhile, or still being written
		}
		if err := os.Remove(filepath.Join(tmp, e.Name())); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// openImage opens a stored image, or the variant of it that r asks for with
// ?w=, and sets Vary when the response depends on Accept. It returns the
// Content-Type and ETag to serve; failed means a variant was asked for but
// the original is served instead.
func (s *Service) openImage(w http.ResponseWriter, r *http.Request, sum, contentType string) (f io.ReadSeekCloser, ct, etag string, failed bool, err error) {
	v, asked := s.variantFor(r, sum, contentType)
	if asked {
		w.Header().Set("Vary", "Accept")
	}
	if v != nil {
		if vf, err := os.Open(v.path); err == nil {
			return vf, v.contentType, v.etag, false, nil
		} // removed meanwhile: serve the original
	}
	f, err = s.store.Open(sum)
	return f, contentType, `"` + sum + `"`, asked, err
}
