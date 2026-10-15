package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"runtime"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

type Settings interface {
	Settings(ctx context.Context) (auth.Settings, error)
}

// Attachment is an uploaded file. URLs are relative to the server.
type Attachment struct {
	ID           id.ID  `json:"id"`
	ChannelID    *id.ID `json:"channel_id,omitempty" doc:"Where it was posted"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type" doc:"Detected from the contents, not the name"`
	Size         int64  `json:"size"`
	Width        *int   `json:"width,omitempty"`
	Height       *int   `json:"height,omitempty"`
	Inline       bool   `json:"inline" doc:"An image the client may show in the message"`
	GIF          bool   `json:"gif,omitempty" doc:"Posted with /gif: clients play it muted and looped, without controls, like an image"`
	URL          string `json:"url"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`

	uploaderID id.ID
	messageID  *id.ID
	sum        string
	thumbSum   string
}

// setURLs fills the URLs. With variants on, inline images get a resized
// thumbnail; otherwise only rows from before that keep their stored one.
func (a *Attachment) setURLs(variants bool) {
	a.URL = "/api/attachments/" + a.ID.String()
	switch {
	case variants && a.Inline && !a.GIF && variantTypes[a.ContentType]:
		a.ThumbnailURL = a.URL + "?w=512"
	case a.thumbSum != "":
		a.ThumbnailURL = a.URL + "/thumbnail"
	}
}

// UploaderID is who uploaded the file.
func (a Attachment) UploaderID() id.ID { return a.uploaderID }

// MessageID is the message the file was sent with; nil while unsent.
func (a Attachment) MessageID() *id.ID { return a.messageID }

const (
	unsentTTL     = 24 * time.Hour // unsent uploads and unreferenced blobs live this long
	maxImageBytes = 64 << 20       // larger images are stored as plain files
)

type Service struct {
	active   func() bool // nil: always live; see SetActive
	db       *pgxpool.Pool
	store    Store
	channels Channels
	settings Settings
	server   Server
	// blobTables are the tables, besides attachments, whose rows keep blobs alive.
	blobTables []blobTable
	// imageSlots bounds concurrent image processing: each job holds the whole
	// file plus a decoded copy (up to ~160 MB), so unbounded parallel uploads
	// could exhaust memory.
	imageSlots chan struct{}
	variants   *variants // resized copies of images; nil until SetVariants
	appIcons   appIconCache
	done       chan struct{}
	stop       sync.Once
}

func NewService(pool *pgxpool.Pool, store Store, ch Channels, st Settings) *Service {
	s := &Service{db: pool, store: store, channels: ch, settings: st, imageSlots: make(chan struct{}, runtime.GOMAXPROCS(0)), done: make(chan struct{})}
	s.AddBlobTable("server_images", "sha256")
	return s
}

// Start runs the hourly cleanup until Close.
func (s *Service) Start() {
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		sweep := func(now time.Time) {
			if !s.isActive() {
				return
			}
			if err := s.Sweep(context.Background(), now); err != nil {
				slog.Error("files: sweep", "err", err)
			}
		}
		sweep(time.Now()) // catch up after downtime
		for {
			select {
			case <-s.done:
				return
			case now := <-t.C:
				sweep(now)
			}
		}
	}()
}

func (s *Service) Close() { s.stop.Do(func() { close(s.done) }) }

const attachmentCols = `id, channel_id, uploader_id, message_id, filename, content_type, size, sha256, width, height, thumb_sha256, inline, gif`

func scanAttachment(row pgx.Row, variants bool) (*Attachment, error) {
	var a Attachment
	var ch, msg *int64
	var thumb *string
	if err := row.Scan(&a.ID, &ch, &a.uploaderID, &msg, &a.Filename, &a.ContentType, &a.Size,
		&a.sum, &a.Width, &a.Height, &thumb, &a.Inline, &a.GIF); err != nil {
		return nil, err
	}
	a.ChannelID, a.messageID = id.FromNullable(ch), id.FromNullable(msg)
	if thumb != nil {
		a.thumbSum = *thumb
	}
	a.setURLs(variants)
	return &a, nil
}

func (s *Service) get(ctx context.Context, attachmentID id.ID) (*Attachment, error) {
	a, err := scanAttachment(s.db.QueryRow(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE id = $1`, attachmentID), s.variantsOn())
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("attachment")
	}
	return a, err
}

// authorized loads an attachment the caller may download: their own unsent
// upload, or a sent one in a channel whose history they can read.
func (s *Service) authorized(ctx context.Context, raw string) (*Attachment, error) {
	aid, err := httpx.ParseID(raw, "attachment")
	if err != nil {
		return nil, err
	}
	a, err := s.get(ctx, aid)
	if err != nil {
		return nil, err
	}
	me := auth.Current(ctx).User.ID
	if a.messageID == nil {
		if a.uploaderID != me {
			return nil, httpx.NotFound("attachment")
		}
		return a, nil
	}
	if _, _, err := s.channels.Access(ctx, me, *a.ChannelID, perms.ReadHistory); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil, httpx.NotFound("attachment") // do not reveal files in channels you cannot read
		}
		return nil, err
	}
	return a, nil
}

// save processes a staged upload and records it. Images get their metadata
// stripped and their size measured.
// home is where an upload goes: a channel, where it is sent later with a message.
type home struct {
	channelID *id.ID
}

func (s *Service) save(ctx context.Context, h home, uploaderID id.ID, filename string, staged *Staged, gif *gifSize) (*Attachment, error) {
	defer func() { s.store.Discard(staged) }() // reads staged at return: processImage swaps it; a no-op once committed

	f, err := staged.Open()
	if err != nil {
		return nil, err
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	_ = f.Close()
	ct, kind := Sniff(head[:n])
	a := &Attachment{ID: id.New(), ChannelID: h.channelID, Filename: filename, ContentType: ct, uploaderID: uploaderID}

	if kind != "" && staged.Size <= maxImageBytes {
		select {
		case s.imageSlots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		err := func() error {
			defer func() { <-s.imageSlots }() // released even if a decoder panics
			return s.processImage(kind, a, &staged)
		}()
		if err != nil {
			slog.InfoContext(ctx, "files: keeping image as a plain file", "attachment_id", a.ID, "err", err)
		}
	}
	if gif != nil {
		a.GIF = true
		if a.Width == nil && gif.width > 0 && gif.height > 0 {
			a.Width, a.Height = &gif.width, &gif.height
		}
	}
	a.Size, a.sum = staged.Size, staged.Sum

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, a.sum); err != nil {
		return nil, err
	}
	if err := s.store.Commit(staged); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO attachments (id, channel_id, uploader_id, filename, content_type, size, sha256, width, height, inline, gif)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		a.ID, a.ChannelID, uploaderID, a.Filename, a.ContentType, a.Size, a.sum, a.Width, a.Height, a.Inline, a.GIF); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	a.setURLs(s.variantsOn())
	return a, nil
}

// processImage swaps *staged for a metadata-free copy and records the
// image's size. On error nothing changes and the upload is kept as a plain file.
func (s *Service) processImage(kind Kind, a *Attachment, staged **Staged) error {
	data, err := (*staged).Bytes()
	if err != nil {
		return err
	}
	clean, err := Clean(kind, data)
	if err != nil {
		return err
	}
	w, h, err := Info(clean)
	if err != nil {
		return err
	}
	cleaned, err := s.store.Stage(bytes.NewReader(clean), int64(len(clean)))
	if err != nil {
		return err
	}
	s.store.Discard(*staged)
	*staged = cleaned
	a.Width, a.Height, a.Inline = &w, &h, showable(kind, w, h)
	return nil
}

// lockBlobs serialises everyone saving or deleting these blobs until the
// transaction ends, so the collector never deletes a blob being saved.
func lockBlobs(ctx context.Context, tx pgx.Tx, sums ...string) error {
	sorted := slices.Sorted(slices.Values(sums))
	for _, sum := range slices.Compact(sorted) {
		if sum == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, sum); err != nil {
			return err
		}
	}
	return nil
}

// Sweep deletes uploads not sent within 24 hours of now, then blob files
// nothing references (such as those left by deleting a channel) once they
// are 24 hours old, then abandoned staging files.
func (s *Service) Sweep(ctx context.Context, now time.Time) error {
	rows, err := s.db.Query(ctx, `
		DELETE FROM attachments WHERE message_id IS NULL AND created_at < $1
		RETURNING sha256, thumb_sha256`, now.Add(-unsentTTL))
	if err != nil {
		return err
	}
	sums, err := collectSums(rows)
	if err != nil {
		return err
	}
	if err := s.store.Walk(func(sum string, mod time.Time) error {
		if now.Sub(mod) > unsentTTL {
			sums = append(sums, sum)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := s.removeUnreferenced(ctx, sums); err != nil {
		return err
	}
	if err := s.variants.removeStaleTemp(now.Add(-time.Hour)); err != nil {
		return err
	}
	return s.store.RemoveStaleTemp(now.Add(-time.Hour))
}

// collectSums reads (sha256, thumb_sha256) rows.
func collectSums(rows pgx.Rows) ([]string, error) {
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sum string
		var thumb *string
		if err := rows.Scan(&sum, &thumb); err != nil {
			return nil, err
		}
		out = append(out, sum)
		if thumb != nil {
			out = append(out, *thumb)
		}
	}
	return out, rows.Err()
}

// removeUnreferenced deletes the blob files no attachment or registered blob table points at.
func (s *Service) removeUnreferenced(ctx context.Context, sums []string) error {
	slices.Sort(sums)
	for _, sum := range slices.Compact(sums) {
		if err := s.removeIfUnused(ctx, sum); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) removeIfUnused(ctx context.Context, sum string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := lockBlobs(ctx, tx, sum); err != nil {
		return err
	}
	q := `SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 = $1 OR thumb_sha256 = $1)`
	for _, bt := range s.blobTables {
		q += ` OR EXISTS (SELECT 1 FROM ` + bt.table + ` WHERE ` + bt.column + ` = $1)`
	}
	var used bool
	if err := tx.QueryRow(ctx, q, sum).Scan(&used); err != nil {
		return err
	}
	if !used {
		if err := s.store.Remove(sum); err != nil {
			return err
		}
		if err := s.variants.remove(sum); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
