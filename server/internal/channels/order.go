package channels

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// lockOrder serialises everything that changes channel or category order
// for a server; take it first in the transaction.
func lockOrder(ctx context.Context, tx pgx.Tx, serverID id.ID) error {
	_, err := tx.Exec(ctx, `SELECT 1 FROM communities WHERE id = $1 FOR UPDATE`, serverID)
	return err
}

// groupIDs returns the channel IDs of one group (a category, or nil for
// uncategorised) in order, excluding exclude.
func groupIDs(ctx context.Context, tx pgx.Tx, serverID id.ID, categoryID *id.ID, exclude id.ID) ([]id.ID, error) {
	rows, err := tx.Query(ctx, `
		SELECT id FROM channels
		WHERE community_id = $1 AND type <> 'thread' AND id <> $3
		  AND (($2::bigint IS NULL AND category_id IS NULL) OR category_id = $2)
		ORDER BY (type = 'welcome') DESC, position, id`, serverID, categoryID, exclude)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

// fromVisibleIndex turns a position the caller chose among the channels of a
// group they can see (chID excluded) into an index in the whole group: right
// after the visible predecessor, or before the first visible channel.
func (s *Service) fromVisibleIndex(ctx context.Context, tx pgx.Tx, serverID, chID id.ID, categoryID *id.ID, visibleIdx int) (int, error) {
	group, err := groupIDs(ctx, tx, serverID, categoryID, chID)
	if err != nil || len(group) == 0 {
		return 0, err
	}
	m, err := s.communities.PermMember(ctx, serverID, auth.Current(ctx).User.ID)
	if err != nil {
		return 0, err
	}
	chs, err := s.query(ctx, `SELECT `+channelCols+` FROM channels WHERE id = ANY($1)`, id.Int64s(group))
	if err != nil {
		return 0, err
	}
	visible := map[id.ID]bool{}
	for _, c := range chs {
		visible[c.ID] = effective(m, c).Has(perms.ViewChannel)
	}
	var idx []int // indexes in group of the visible channels
	for i, cid := range group {
		if visible[cid] {
			idx = append(idx, i)
		}
	}
	switch v := max(0, min(visibleIdx, len(idx))); {
	case v > 0:
		return idx[v-1] + 1, nil
	case len(idx) > 0:
		return idx[0], nil
	default:
		return 0, nil
	}
}

// placeChannel puts channel chID into group newCategory at index pos
// (clamped) and renumbers both the old and the new group densely. It returns
// every channel whose category or position may have changed.
func placeChannel(ctx context.Context, tx pgx.Tx, serverID, chID id.ID, oldCategory, newCategory *id.ID, pos int) ([]id.ID, error) {
	target, err := groupIDs(ctx, tx, serverID, newCategory, chID)
	if err != nil {
		return nil, err
	}
	pos = max(0, min(pos, len(target)))
	ordered := append(append(append([]id.ID{}, target[:pos]...), chID), target[pos:]...)
	changed := map[id.ID]bool{}
	for i, cid := range ordered {
		if _, err := tx.Exec(ctx, `UPDATE channels SET category_id = $2, position = $3 WHERE id = $1`, cid, newCategory, i); err != nil {
			return nil, err
		}
		changed[cid] = true
	}
	if !sameCategory(oldCategory, newCategory) {
		old, err := groupIDs(ctx, tx, serverID, oldCategory, chID)
		if err != nil {
			return nil, err
		}
		for i, cid := range old {
			if _, err := tx.Exec(ctx, `UPDATE channels SET position = $2 WHERE id = $1`, cid, i); err != nil {
				return nil, err
			}
			changed[cid] = true
		}
	}
	out := make([]id.ID, 0, len(changed))
	for cid := range changed {
		out = append(out, cid)
	}
	return out, nil
}

// renumberGroup closes gaps in one group (welcome first, then by position)
// and returns the channels whose position changed.
func renumberGroup(ctx context.Context, tx pgx.Tx, serverID id.ID, categoryID *id.ID) ([]id.ID, error) {
	rows, err := tx.Query(ctx, `
		UPDATE channels ch SET position = o.n - 1
		FROM (SELECT id, row_number() OVER (ORDER BY (type = 'welcome') DESC, position, id) AS n
		      FROM channels
		      WHERE community_id = $1 AND type <> 'thread'
		        AND (($2::bigint IS NULL AND category_id IS NULL) OR category_id = $2)) o
		WHERE ch.id = o.id AND ch.position <> o.n - 1
		RETURNING ch.id`, serverID, categoryID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

// announceMoved sends CHANNEL_UPDATE for channels whose order changed, except
// skip. The change is already committed, so failures are only logged.
func (s *Service) announceMoved(ctx context.Context, ids []id.ID, skip id.ID) {
	for _, cid := range ids {
		if cid == skip {
			continue
		}
		if err := s.publishVisibility(ctx, cid, nil); err != nil {
			slog.WarnContext(ctx, "announce moved channel", "channel_id", cid, "err", err)
		}
	}
}

func sameCategory(a, b *id.ID) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
