package files

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/image/draw"

	"github.com/datrope/datrope/server/internal/httpx"
)

// appIcons are the PNGs the PWA manifest lists for the server icon. Android
// builds its installed app (a WebAPK) from them, and fails silently when an
// icon is huge or its sizes are wrong, so they are exact squares.
var appIcons = map[string]struct {
	size     int
	maskable bool
}{
	"192.png":          {192, false},
	"512.png":          {512, false},
	"maskable-512.png": {512, true},
}

// appIconBackground fills maskable icons; it is --background in clients/web/src/styles.css.
var appIconBackground = color.RGBA{0x13, 0x13, 0x13, 0xff}

// maskableScale keeps the icon inside a maskable icon's safe zone.
const maskableScale = 0.8

// appIconCache holds the current icon's resized PNGs, keyed by name.
type appIconCache struct {
	mu   sync.Mutex
	sum  string
	pngs map[string][]byte
}

// ServerAppIcon serves GET /api/server/icon/{name}: the server icon resized
// for the PWA manifest. It needs no session, like the icon itself.
func (s *Service) ServerAppIcon() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		spec, ok := appIcons[r.PathValue("name")]
		if !ok {
			httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
			return
		}
		var sum string
		err := s.db.QueryRow(ctx, `SELECT sha256 FROM server_images WHERE kind = 'icon'`).Scan(&sum)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.WriteHTTPError(w, r, httpx.NotFound("image"))
			return
		}
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		data, err := s.appIcon(sum, r.PathValue("name"), spec.size, spec.maskable)
		if err != nil {
			httpx.WriteHTTPError(w, r, err)
			return
		}
		cache := "public, max-age=60"
		if r.URL.Query().Has("v") {
			cache = "public, max-age=31536000, immutable"
		}
		h := w.Header()
		h.Set("Content-Type", "image/png")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
		h.Set("Cache-Control", cache)
		h.Set("ETag", `"`+sum+`-`+r.PathValue("name")+`"`)
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(data))
	})
}

// appIcon returns the icon blob sum resized to name, making it on first use.
func (s *Service) appIcon(sum, name string, size int, maskable bool) ([]byte, error) {
	c := &s.appIcons
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.sum != sum {
		c.sum, c.pngs = sum, map[string][]byte{}
	}
	if data, ok := c.pngs[name]; ok {
		return data, nil
	}
	f, err := s.store.Open(sum)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, maxServerImageBytes+1))
	if err != nil {
		return nil, err
	}
	if w, h, err := Info(raw); err != nil || w*h > MaxDecodePixels {
		return nil, errBadImage
	}
	src, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	data, err := squareIcon(src, size, maskable)
	if err != nil {
		return nil, err
	}
	c.pngs[name] = data
	return data, nil
}

// squareIcon crops src to its centre square and scales it to size x size. A
// maskable icon is shrunk into the safe zone on an opaque background.
func squareIcon(src image.Image, size int, maskable bool) ([]byte, error) {
	b := src.Bounds()
	side := min(b.Dx(), b.Dy())
	crop := image.Rect(0, 0, side, side).Add(b.Min).Add(image.Pt((b.Dx()-side)/2, (b.Dy()-side)/2))
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	target := dst.Bounds()
	if maskable {
		draw.Draw(dst, target, image.NewUniform(appIconBackground), image.Point{}, draw.Src)
		inner := int(float64(size) * maskableScale)
		off := (size - inner) / 2
		target = image.Rect(off, off, off+inner, off+inner)
	}
	draw.CatmullRom.Scale(dst, target, src, crop, draw.Over, nil)
	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
