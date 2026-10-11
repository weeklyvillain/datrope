# Image proxy: sized, cached image variants

Date: 2026-10-11
Status: approved design, pending plan

## Goal

Serve every stored image at the size it is displayed, in a modern format, without doing the image
work in the Go server:

- **Bandwidth / load time.** Avatars, emoji, banners, icons and covers are served full size today
  and scaled by CSS. Serve small WebP variants instead.
- **Sharp on HiDPI.** Clients ask for 1x/2x variants (`srcset`) instead of one fixed 400 px thumbnail.
- **Server CPU.** Resizing and encoding move to a bundled imgproxy (libvips) container. The Go
  server keeps auth and a disk cache of results.

Out of scope: proxying third-party images (Spotify covers, Klipy, 7TV previews), AVIF output,
a size cap on the variant cache.

## Current state

- Blobs are content-addressed files in `DataDir/files/<sha256>` (`files.LocalStore`).
- Uploads are cleaned (`files.Clean`: metadata strip, EXIF rotate) and get one 400 px JPEG/PNG
  thumbnail (`files.Thumbnail`, stored as `attachments.thumb_sha256`). GIF attachments get none.
- Attachments are served by `files.Service.download` (`GET /api/attachments/{id}` and
  `/thumbnail`). Every other stored image (avatars, banners, server icon/banner/page images, emoji,
  role icons, music covers, webhook avatars) goes through `files.Service.serveBlob`
  (`ServeBlob` / `ServePrivateBlob`).
- No cgo on the dev machine, so libvips cannot be linked into the Go binary.

## Decisions

### Deploy

- New `imgproxy` service in `deploy/docker-compose.yml`, image `ghcr.io/imgproxy/imgproxy:v4.0.17` (latest
  release, 2026-09-30; v4 keeps the v3 URL format and the options used here). It runs as uid 65532,
  the server's user, because stored blobs are mode 0600. It mounts the `files` volume read-only at `/data`
  and publishes no ports: only `server` reaches it on the compose network.
- imgproxy env:
  - `IMGPROXY_LOCAL_FILESYSTEM_ROOT=/data/files`
  - `IMGPROXY_ALLOWED_SOURCES=local://` (it can never fetch from the network)
  - `IMGPROXY_MAX_SRC_RESOLUTION=40` (megapixels, matches `files.MaxDecodePixels`)
  - `IMGPROXY_MAX_ANIMATION_FRAMES=256` (animated GIF/WebP are resized frame by frame). imgproxy loads
    only that many frames and drops the rest, so the server never sends it a GIF with more frames
    (`maxVariantFrames`); those are served as the original.
  - `IMGPROXY_MAX_ANIMATION_FRAME_RESOLUTION=16.8` (megapixels per frame, matches `maxGIFPixels`,
    4096 x 4096). Without it imgproxy checks the sum of all frames against `MAX_SRC_RESOLUTION`;
    with it only each frame is checked, so the server caps a GIF's frames x width x height at
    `maxVariantGIFPixels` (64 Mi pixels) before asking.
  - metadata stripping left at its default (on)
- URLs are not signed (no key/salt): imgproxy is not reachable from outside the compose network.
- Server config: `DATROPE_IMGPROXY_URL` (compose sets `http://imgproxy:8080`). Empty means the
  feature is off; that is the default for local dev and Go tests.
- No Caddy or CSP change: everything stays under `/api/*`.

### Variant requests

- Any image route served by `serveBlob`, and `GET /api/attachments/{id}`, accept `?w=N`.
- `N` snaps up to the next bucket of `32, 64, 128, 256, 512, 1024, 1600`; anything above 1600 uses
  1600. Invalid or missing `w` means the original, exactly as today.
- The variant fits in `bucket x bucket` (imgproxy `rs:fit:B:B:0`, never enlarged).
- Format: WebP when the request's `Accept` header contains `image/webp`, otherwise the source format.
  Animated sources stay animated.
- Only image content types (`image/jpeg`, `image/png`, `image/webp`, `image/gif`) get variants; any
  other type ignores `w`. Attachments get variants only when `Inline` is set.
- Response headers: the route's usual Cache-Control, CSP, nosniff and CORP headers, plus
  `Vary: Accept`, ETag `"<sum>-<bucket>-<fmt>"`, and the variant's own Content-Type.

### Variant cache (`server/internal/files/variants.go`)

- Path: `DataDir/variants/<sum>/<bucket>.<fmt>` (`fmt` is `webp` or `orig`).
- Hit: serve the file with `http.ServeContent`.
- Miss: `GET {imgproxy}/insecure/rs:fit:B:B:0/plain/local:///<sum>[@webp]`, with a 30 s timeout,
  then write to a temp file in `DataDir/variants/tmp` and rename it into place.
- Concurrent misses for the same key share one upstream request (`golang.org/x/sync/singleflight`).
  Upstream calls are capped by a semaphore (the size of the existing `imageSlots`).
- Failure (imgproxy unreachable, non-2xx, timeout): log at info level, serve the original instead,
  and don't cache anything.
- When a blob is removed from the store, its `variants/<sum>` directory is removed too.

### Upload path and thumbnails

- Uploads no longer generate thumbnails. `files.Thumbnail`, its call in `processImage` and its tests
  are removed. `Clean` and `Info` stay: metadata is still stripped before anything is stored.
- `thumbnail_url` stays in the API:
  - imgproxy on: `<url>?w=512` for every inline image attachment (old rows included).
  - imgproxy off: `<url>/thumbnail` when the row has a legacy `thumb_sha256`, otherwise omitted
    (clients already fall back to `url`).
- `GET /api/attachments/{id}/thumbnail` keeps serving legacy thumbnails.
- No DB migration; `thumb_sha256` stays for existing rows and is no longer written.

### Web client

- New helper `sizedImage(url, cssPx)` in `clients/web/src/lib/` returns `{ src, srcSet }`: `src` at
  the 1x bucket, `srcSet` with the 1x and 2x buckets. It appends `w` correctly whether or not the
  URL already has a query (`?v=`). URLs from other origins come back unchanged.
- Used by: `UserAvatar`, `WebhookAvatar`, message image attachments, gallery tiles and item panel,
  the image viewer filmstrip, custom emoji (picker, reactions, inline in messages), user and server
  banners, server icon, role icons, local music covers.
- The full-size image viewer keeps loading the original.

## Testing

- Go (`files` package), against a fake imgproxy (`httptest.Server`):
  - bucket snapping and the requested imgproxy path/format;
  - a cache hit makes no upstream call, and N concurrent misses make one;
  - upstream 500 and timeout fall back to the original;
  - imgproxy off ignores `w`;
  - the `Vary` and ETag headers;
  - removing a blob removes its variants;
  - non-image blobs and non-inline attachments ignore `w`.
- Existing upload tests are updated: no thumbnail is generated. `thumbnail_url` follows the rules above.
- Web: vitest for `sizedImage` (buckets, existing query, other origins).
- Manual: `docker compose up` with real imgproxy, then check in the network panel that avatars and
  message images come back as small WebP and that GIFs stay animated.
