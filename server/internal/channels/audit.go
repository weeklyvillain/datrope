package channels

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// permsText is a permission mask as audit text: decimal; the client names the flags.
func permsText(p perms.Perms) string { return strconv.FormatUint(uint64(p), 10) }

// channelChanges lists what an update changed, for the audit log.
// Categories are named; "" is no category.
func (s *Service) channelChanges(ctx context.Context, old, new *Channel) ([]audit.LogChange, error) {
	cs := audit.Diff(nil, "name", old.Name, new.Name)
	cs = audit.Diff(cs, "topic", old.Topic, new.Topic)
	if !sameCategory(old.CategoryID, new.CategoryID) {
		from, err := s.categoryName(ctx, old.CategoryID)
		if err != nil {
			return nil, err
		}
		to, err := s.categoryName(ctx, new.CategoryID)
		if err != nil {
			return nil, err
		}
		cs = append(cs, audit.LogChange{Field: "category", Old: from, New: to})
	} else {
		cs = audit.Diff(cs, "position", strconv.Itoa(old.Position), strconv.Itoa(new.Position))
	}
	cs = audit.Diff(cs, "tags", strings.Join(old.Tags, ", "), strings.Join(new.Tags, ", "))
	return audit.Diff(cs, "require_tag", strconv.FormatBool(old.RequireTag), strconv.FormatBool(new.RequireTag)), nil
}

func (s *Service) categoryName(ctx context.Context, catID *id.ID) (string, error) {
	if catID == nil {
		return "", nil
	}
	var name string
	err := s.db.QueryRow(ctx, `SELECT name FROM categories WHERE id = $1`, *catID).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// auditOverride records an override change. A member override targets the
// member; a role override names the role.
func (s *Service) auditOverride(ctx context.Context, action audit.Action, c *Channel, targetType string, target id.ID, cs []audit.LogChange) error {
	d := audit.LogDetails{Channel: &audit.LogRef{ID: c.ID, Name: c.Name}, Changes: cs}
	if targetType == "member" {
		return audit.Record(ctx, s.db, action, target, d)
	}
	role := audit.LogRef{ID: target}
	if err := s.db.QueryRow(ctx, `SELECT name FROM roles WHERE id = $1`, target).Scan(&role.Name); err != nil {
		return err
	}
	d.Role = &role
	return audit.Record(ctx, s.db, action, 0, d)
}
