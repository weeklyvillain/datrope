package communities

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

// registerSelfRoles adds the welcome page's role picker: members give
// themselves, or drop, roles an admin marked self-assignable.
func registerSelfRoles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	set := func(add bool) func(context.Context, *rolePath) (*struct{}, error) {
		return func(ctx context.Context, in *rolePath) (*struct{}, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			if a.Member.Gated {
				return nil, errGated()
			}
			if auth.IsGuest(ctx) {
				return nil, httpx.MissingPermission()
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			r, err := lockedRole(ctx, tx, a.CommunityID, in.RoleID)
			if err != nil {
				return nil, err
			}
			if !r.SelfAssignable {
				return nil, httpx.E(http.StatusForbidden, "NOT_SELF_ASSIGNABLE", "only moderators can give or take this role")
			}
			sql := `DELETE FROM member_roles WHERE community_id = $1 AND user_id = $2 AND role_id = $3`
			if add {
				sql = `INSERT INTO member_roles (community_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`
			}
			tag, err := tx.Exec(ctx, sql, a.CommunityID, a.Member.UserID, r.ID)
			if err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, nil // already so
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, a.Member.UserID)
		}
	}
	huma.Register(api, op("add-my-role", http.MethodPut, "/api/server/me/roles/{roleID}", http.StatusNoContent), set(true))
	huma.Register(api, op("remove-my-role", http.MethodDelete, "/api/server/me/roles/{roleID}", http.StatusNoContent), set(false))
}
