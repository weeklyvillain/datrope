package files

import (
	"context"
	"log/slog"
	"time"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
)

// TTLFor is how long a sent file of `size` bytes lives: the tier with the biggest MinBytes not above size.
func TTLFor(rules []auth.TTLRule, size int64) (time.Duration, bool) {
	best := -1
	for i, r := range rules {
		if r.MinBytes <= size && (best < 0 || r.MinBytes > rules[best].MinBytes) {
			best = i
		}
	}
	if best < 0 {
		return 0, false
	}
	return time.Duration(rules[best].TTLHours) * time.Hour, true
}

// SetOnExpired is told about each message whose files the sweep expired (it publishes MESSAGE_UPDATE).
// Safe to call after Start: the first sweep may already be running.
func (s *Service) SetOnExpired(fn func(ctx context.Context, channelID, messageID id.ID)) {
	s.onExpired.Store(&fn)
}

// Get is an attachment by ID (any state).
func (s *Service) Get(ctx context.Context, attachmentID id.ID) (*Attachment, error) {
	return s.get(ctx, attachmentID)
}

// SetKeep keeps a sent file forever, or lets it expire again by the current rules, counted from now.
func (s *Service) SetKeep(ctx context.Context, a *Attachment, keep bool) error {
	if keep {
		_, err := s.db.Exec(ctx, `UPDATE attachments SET keep = true WHERE id = $1 AND expired_at IS NULL AND message_id IS NOT NULL`, a.ID)
		return err
	}
	set, err := s.settings.Settings(ctx)
	if err != nil {
		return err
	}
	var at *time.Time
	if d, ok := TTLFor(set.UploadTTLRules, a.Size); ok {
		t := time.Now().Add(d)
		at = &t
	}
	_, err = s.db.Exec(ctx, `UPDATE attachments SET keep = false, expires_at = $2 WHERE id = $1 AND expired_at IS NULL AND message_id IS NOT NULL`, a.ID, at)
	return err
}

// ExpireNow removes a sent file's contents at once (its row and message stay, marked expired).
func (s *Service) ExpireNow(ctx context.Context, a *Attachment) error {
	return s.expire(ctx, `UPDATE attachments SET expired_at = now() WHERE id = $1 AND expired_at IS NULL AND message_id IS NOT NULL
		RETURNING channel_id, message_id, sha256, thumb_sha256`, a.ID)
}

// expire marks rows expired with `q`, removes the blobs nothing else references and reports each message.
func (s *Service) expire(ctx context.Context, q string, args ...any) error {
	rows, err := s.db.Query(ctx, q, args...)
	if err != nil {
		return err
	}
	type ref struct{ ch, msg id.ID }
	var refs []ref
	var sums []string
	for rows.Next() {
		var ch, msg int64
		var sum string
		var thumb *string
		if err := rows.Scan(&ch, &msg, &sum, &thumb); err != nil {
			rows.Close()
			return err
		}
		refs = append(refs, ref{id.ID(ch), id.ID(msg)})
		sums = append(sums, sum)
		if thumb != nil {
			sums = append(sums, *thumb)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	// The rows are already expired: tell their messages either way. The orphan walk retries blobs.
	if err := s.removeUnreferenced(ctx, sums); err != nil {
		slog.WarnContext(ctx, "files: removing expired blobs; the sweep will retry", "err", err)
	}
	if fn := s.onExpired.Load(); fn != nil {
		seen := map[ref]bool{}
		for _, r := range refs {
			if !seen[r] {
				seen[r] = true
				(*fn)(ctx, r.ch, r.msg)
			}
		}
	}
	return nil
}
