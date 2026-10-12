package channels

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type Category struct {
	ID       id.ID  `json:"id"`
	Name     string `json:"name"`
	Position int    `json:"position"`
}

type CategoryDeleted struct {
	ID id.ID `json:"id"`
}

type CategoryRequest struct {
	Name     *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Position *int    `json:"position,omitempty" minimum:"0"`
}

type queryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (s *Service) Categories(ctx context.Context, serverID id.ID) ([]Category, error) {
	rows, err := s.db.Query(ctx, `SELECT id, name, position FROM categories WHERE community_id = $1 ORDER BY position, id`, serverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Category{}
	for rows.Next() {
		var c Category
		if err := rows.Scan(&c.ID, &c.Name, &c.Position); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// requireManage returns the server ID when the caller may manage channels.
func (s *Service) requireManage(ctx context.Context) (id.ID, error) {
	sid, err := s.serverID(ctx)
	if err != nil {
		return 0, err
	}
	m, err := s.communities.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, communities.ErrNotMember) {
		return 0, errNotMember()
	}
	if err != nil {
		return 0, err
	}
	if m.Gated || !perms.Base(m.Perms).Has(perms.ManageChannels) {
		return 0, httpx.MissingPermission()
	}
	return sid, nil
}

// category loads a category of the server by its raw ID; 404 if unknown.
func (s *Service) category(ctx context.Context, q queryRower, serverID id.ID, raw string) (*Category, error) {
	cid, err := httpx.ParseID(raw, "category")
	if err != nil {
		return nil, err
	}
	var c Category
	err = q.QueryRow(ctx, `SELECT id, name, position FROM categories WHERE id = $1 AND community_id = $2`, cid, serverID).
		Scan(&c.ID, &c.Name, &c.Position)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("category")
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (s *Service) publishCategory(typ string, serverID id.ID, data any) {
	s.bus.Publish(events.Event{Type: typ, Data: data, Scope: events.Scope{CommunityID: serverID}})
}

func registerCategories(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-categories", http.MethodGet, "/api/server/categories", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Category }, error) {
			sid, err := s.serverID(ctx)
			if err != nil {
				return nil, err
			}
			m, err := s.communities.PermMember(ctx, sid, auth.Current(ctx).User.ID)
			if errors.Is(err, communities.ErrNotMember) {
				return nil, errNotMember()
			}
			if err != nil {
				return nil, err
			}
			if m.Gated { // as in READY: a member held at the rules gate sees no categories
				return &struct{ Body []Category }{[]Category{}}, nil
			}
			cs, err := s.Categories(ctx, sid)
			return &struct{ Body []Category }{cs}, err
		})

	huma.Register(api, op("create-category", http.MethodPost, "/api/server/categories", http.StatusCreated),
		func(ctx context.Context, in *struct {
			Body struct {
				Name string `json:"name" minLength:"1" maxLength:"100"`
			}
		}) (*struct{ Body *Category }, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			c := &Category{ID: id.New(), Name: strings.TrimSpace(in.Body.Name)}
			if c.Name == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "a category needs a name")
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, sid); err != nil {
				return nil, err
			}
			if err := tx.QueryRow(ctx, `
				INSERT INTO categories (id, community_id, name, position)
				VALUES ($1, $2, $3, (SELECT COALESCE(max(position), -1) + 1 FROM categories WHERE community_id = $2))
				RETURNING position`, c.ID, sid, c.Name).Scan(&c.Position); err != nil {
				return nil, err
			}
			if err := audit.Record(ctx, tx, audit.CategoryCreate, c.ID, audit.LogDetails{Name: c.Name}); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishCategory("CATEGORY_CREATE", sid, c)
			return &struct{ Body *Category }{c}, nil
		})

	huma.Register(api, op("update-category", http.MethodPatch, "/api/server/categories/{categoryID}", 0),
		func(ctx context.Context, in *struct {
			CategoryID string `path:"categoryID"`
			Body       CategoryRequest
		}) (*struct{ Body *Category }, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, sid); err != nil {
				return nil, err
			}
			c, err := s.category(ctx, tx, sid, in.CategoryID)
			if err != nil {
				return nil, err
			}
			old := *c
			if in.Body.Name != nil {
				c.Name = strings.TrimSpace(*in.Body.Name)
				if c.Name == "" {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "a category needs a name")
				}
				if _, err := tx.Exec(ctx, `UPDATE categories SET name = $2 WHERE id = $1`, c.ID, c.Name); err != nil {
					return nil, err
				}
			}
			if in.Body.Position != nil {
				rows, err := tx.Query(ctx, `SELECT id FROM categories WHERE community_id = $1 AND id <> $2 ORDER BY position, id`, sid, c.ID)
				if err != nil {
					return nil, err
				}
				others, err := pgx.CollectRows(rows, pgx.RowTo[id.ID])
				if err != nil {
					return nil, err
				}
				pos := max(0, min(*in.Body.Position, len(others)))
				ordered := append(append(append([]id.ID{}, others[:pos]...), c.ID), others[pos:]...)
				for i, cid := range ordered {
					if _, err := tx.Exec(ctx, `UPDATE categories SET position = $2 WHERE id = $1`, cid, i); err != nil {
						return nil, err
					}
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			all, err := s.Categories(ctx, sid)
			if err != nil {
				return nil, err
			}
			for _, x := range all {
				if x.ID == c.ID {
					*c = x
				}
				if in.Body.Position != nil || x.ID == c.ID {
					s.publishCategory("CATEGORY_UPDATE", sid, x)
				}
			}
			cs := audit.Diff(nil, "name", old.Name, c.Name)
			cs = audit.Diff(cs, "position", strconv.Itoa(old.Position), strconv.Itoa(c.Position))
			if len(cs) > 0 {
				if err := audit.Record(ctx, s.db, audit.CategoryUpdate, c.ID, audit.LogDetails{Name: c.Name, Changes: cs}); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Category }{c}, nil
		})

	huma.Register(api, op("delete-category", http.MethodDelete, "/api/server/categories/{categoryID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			CategoryID string `path:"categoryID"`
		}) (*struct{}, error) {
			sid, err := s.requireManage(ctx)
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if err := lockOrder(ctx, tx, sid); err != nil {
				return nil, err
			}
			c, err := s.category(ctx, tx, sid, in.CategoryID)
			if err != nil {
				return nil, err
			}
			// The channels of the category go to the end of the uncategorised list, in their order.
			uncategorised, err := groupIDs(ctx, tx, sid, nil, 0)
			if err != nil {
				return nil, err
			}
			members, err := groupIDs(ctx, tx, sid, &c.ID, 0)
			if err != nil {
				return nil, err
			}
			for i, cid := range members {
				if _, err := tx.Exec(ctx, `UPDATE channels SET category_id = NULL, position = $2 WHERE id = $1`, cid, len(uncategorised)+i); err != nil {
					return nil, err
				}
			}
			if _, err := tx.Exec(ctx, `DELETE FROM categories WHERE id = $1`, c.ID); err != nil {
				return nil, err
			}
			if err := audit.Record(ctx, tx, audit.CategoryDelete, c.ID, audit.LogDetails{Name: c.Name}); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE categories SET position = o.n - 1
				FROM (SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM categories WHERE community_id = $1) o
				WHERE categories.id = o.id`, sid); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishCategory("CATEGORY_DELETE", sid, CategoryDeleted{ID: c.ID})
			rest, err := s.Categories(ctx, sid)
			if err != nil { // already committed: log rather than fail
				slog.WarnContext(ctx, "announce categories after delete", "err", err)
			}
			for _, x := range rest { // their positions closed the gap
				s.publishCategory("CATEGORY_UPDATE", sid, x)
			}
			s.announceMoved(ctx, members, 0)
			return nil, nil
		})
}
