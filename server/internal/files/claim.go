package files

import (
	"cmp"
	"context"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// Claim attaches uploads to a new message, inside the message's transaction.
// Every ID must be an unsent upload by uploaderID to channelID, younger than
// unsentTTL (older ones are about to be swept).
func (s *Service) Claim(ctx context.Context, tx pgx.Tx, messageID, channelID, uploaderID id.ID, ids []id.ID) ([]Attachment, error) {
	out := []Attachment{}
	if len(ids) == 0 {
		return out, nil
	}
	unique := slices.Compact(slices.Sorted(slices.Values(ids)))
	rows, err := tx.Query(ctx, `
		UPDATE attachments SET message_id = $1
		WHERE id = ANY($2) AND channel_id = $3 AND uploader_id = $4 AND message_id IS NULL
		  AND created_at > now() - make_interval(secs => $5)
		RETURNING `+attachmentCols, messageID, id.Int64s(unique), channelID, uploaderID, unsentTTL.Seconds())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) != len(unique) {
		return nil, httpx.BadRequest("ATTACHMENT_INVALID", "an attachment is missing, already sent, or was uploaded elsewhere")
	}
	slices.SortFunc(out, func(a, b Attachment) int { return cmp.Compare(a.ID, b.ID) }) // upload order
	return out, nil
}

// ForMessages returns the attachments of the given messages, in upload order.
func (s *Service) ForMessages(ctx context.Context, messageIDs []id.ID) (map[id.ID][]Attachment, error) {
	out := map[id.ID][]Attachment{}
	if len(messageIDs) == 0 {
		return out, nil
	}
	rows, err := s.db.Query(ctx, `SELECT `+attachmentCols+` FROM attachments WHERE message_id = ANY($1) ORDER BY id`,
		id.Int64s(messageIDs))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		a, err := scanAttachment(rows)
		if err != nil {
			return nil, err
		}
		out[*a.messageID] = append(out[*a.messageID], *a)
	}
	return out, rows.Err()
}

// DeleteForMessage removes a deleted message's attachment rows inside tx and
// returns the blob sums to pass to RemoveBlobs after the commit.
func (s *Service) DeleteForMessage(ctx context.Context, tx pgx.Tx, messageID id.ID) ([]string, error) {
	rows, err := tx.Query(ctx, `DELETE FROM attachments WHERE message_id = $1 RETURNING sha256, thumb_sha256`, messageID)
	if err != nil {
		return nil, err
	}
	return collectSums(rows)
}

// RemoveBlobs deletes the given blobs that nothing references any more.
func (s *Service) RemoveBlobs(ctx context.Context, sums []string) error {
	return s.removeUnreferenced(ctx, sums)
}
