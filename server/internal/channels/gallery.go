package channels

import (
	"context"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// A gallery's sources: which other channels' files it shows besides its own posts.
const (
	SourcesNone     = "none"
	SourcesAll      = "all"
	SourcesSelected = "selected"
)

const maxSources = 100

// sourceTypes are the channel types a gallery can show files from.
var sourceTypes = map[string]bool{TypeText: true, TypeVoice: true, TypeWebhook: true, TypeAnnouncement: true, TypeForum: true, TypeGallery: true}

func errOnlyGalleries() error {
	return httpx.BadRequest("VALIDATION_FAILED", "only galleries have sources")
}

// checkSources validates a gallery's sources and returns its source list, deduplicated (empty
// unless mode is selected). galleryID may not be a source of itself.
func checkSources(ctx context.Context, tx pgx.Tx, communityID, galleryID id.ID, mode string, ids []id.ID) ([]id.ID, error) {
	switch mode {
	case SourcesNone, SourcesAll:
		if len(ids) > 0 {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "source_channel_ids go only with gallery_sources selected")
		}
		return []id.ID{}, nil
	case SourcesSelected:
	default:
		return nil, httpx.BadRequest("VALIDATION_FAILED", "gallery_sources must be none, all or selected")
	}
	uniq := slices.Compact(slices.Sorted(slices.Values(ids)))
	if len(uniq) == 0 {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "pick at least one channel to show files from")
	}
	if len(uniq) > maxSources {
		return nil, httpx.BadRequest("VALIDATION_FAILED", "a gallery can show files from at most 100 channels")
	}
	rows, err := tx.Query(ctx, `SELECT id, type FROM channels WHERE community_id = $1 AND id = ANY($2)`, communityID, id.Int64s(uniq))
	if err != nil {
		return nil, err
	}
	types := map[id.ID]string{}
	for rows.Next() {
		var cid id.ID
		var t string
		if err := rows.Scan(&cid, &t); err != nil {
			rows.Close()
			return nil, err
		}
		types[cid] = t
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, c := range uniq {
		if t, ok := types[c]; !ok || c == galleryID || !sourceTypes[t] {
			return nil, httpx.BadRequest("VALIDATION_FAILED", "a gallery can't show files from channel "+c.String())
		}
	}
	return uniq, nil
}

// setSources stores a gallery's mode and replaces its source list.
func setSources(ctx context.Context, tx pgx.Tx, galleryID id.ID, mode string, ids []id.ID) error {
	if _, err := tx.Exec(ctx, `UPDATE channels SET gallery_sources = $2 WHERE id = $1`, galleryID, mode); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM gallery_source_channels WHERE gallery_id = $1`, galleryID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO gallery_source_channels (gallery_id, channel_id) SELECT $1, unnest($2::bigint[])`,
		galleryID, id.Int64s(ids))
	return err
}

// updateSources validates and stores a gallery's new sources in one transaction.
func (s *Service) updateSources(ctx context.Context, g *Channel, mode string, ids []id.ID) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	checked, err := checkSources(ctx, tx, *g.CommunityID, g.ID, mode, ids)
	if err != nil {
		return err
	}
	if err := setSources(ctx, tx, g.ID, mode, checked); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// loadSources fills SourceChannelIDs for galleries with selected sources.
func (s *Service) loadSources(ctx context.Context, chs []*Channel) error {
	byID := map[id.ID]*Channel{}
	var ids []id.ID
	for _, c := range chs {
		if c.Type == TypeGallery && c.GallerySources == SourcesSelected {
			byID[c.ID] = c
			ids = append(ids, c.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := s.db.Query(ctx, `SELECT gallery_id, channel_id FROM gallery_source_channels WHERE gallery_id = ANY($1) ORDER BY channel_id`,
		id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var g, c id.ID
		if err := rows.Scan(&g, &c); err != nil {
			return err
		}
		byID[g].SourceChannelIDs = append(byID[g].SourceChannelIDs, c)
	}
	return rows.Err()
}

func idList(ids []id.ID) string {
	out := make([]string, len(ids))
	for i, v := range ids {
		out[i] = v.String()
	}
	return strings.Join(out, ", ")
}
