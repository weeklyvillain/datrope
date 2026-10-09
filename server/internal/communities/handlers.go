package communities

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type UpdateServerRequest struct {
	Name        *string `json:"name,omitempty" minLength:"1" maxLength:"100"`
	Description *string `json:"description,omitempty" maxLength:"300"`
	Palette     *string `json:"palette,omitempty" enum:"emerald,ocean,violet,amber,rose,mint"`
}

type CreateInviteRequest struct {
	MaxUses          *int `json:"max_uses,omitempty" minimum:"1" maximum:"1000"`
	ExpiresInSeconds *int `json:"expires_in_seconds,omitempty" minimum:"60" maximum:"2592000"`
}

type memberPath struct {
	UserID string `path:"userID"`
}

type codePath struct {
	Code string `path:"code"`
}

// actor is the caller's standing in the server.
type actor struct {
	CommunityID id.ID // the server's ID
	Member      PermMember
	Base        perms.Perms
}

func errNotMember() *httpx.Error {
	return httpx.E(http.StatusForbidden, "NOT_A_MEMBER", "you are not a member of this server; ask for an invite")
}

// requireActor checks that the caller is a member holding need. A member
// held at the rules gate passes only when need is 0, with no base permissions.
func (s *Service) requireActor(ctx context.Context, need perms.Perms) (actor, error) {
	sid, err := s.ServerID(ctx)
	if errors.Is(err, ErrNotFound) {
		return actor{}, errNotMember()
	}
	if err != nil {
		return actor{}, err
	}
	m, err := s.PermMember(ctx, sid, auth.Current(ctx).User.ID)
	if errors.Is(err, ErrNotMember) {
		return actor{}, errNotMember()
	}
	if err != nil {
		return actor{}, err
	}
	if m.Gated {
		if need != 0 {
			return actor{}, errGated()
		}
		return actor{CommunityID: sid, Member: m}, nil
	}
	base := perms.Base(m.Perms)
	if !base.Has(need) {
		return actor{}, httpx.MissingPermission()
	}
	return actor{CommunityID: sid, Member: m, Base: base}, nil
}

func Register(api huma.API, s *Service) {
	tags := []string{"server"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("get-server", http.MethodGet, "/api/server", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *ServerWithRoles }, error) {
			if _, err := s.requireActor(ctx, 0); err != nil {
				return nil, err
			}
			sv, err := s.withRoles(ctx)
			return &struct{ Body *ServerWithRoles }{sv}, err
		})

	huma.Register(api, op("update-server", http.MethodPatch, "/api/server", 0),
		func(ctx context.Context, in *struct{ Body UpdateServerRequest }) (*struct{ Body *Server }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			var name *string
			if in.Body.Name != nil {
				n := strings.TrimSpace(*in.Body.Name)
				if n == "" {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "name cannot be blank")
				}
				name = &n
			}
			if _, err := s.db.Exec(ctx, `
				UPDATE communities SET name = COALESCE($2, name), description = COALESCE($3, description), palette = COALESCE($4, palette)
				WHERE id = $1`, a.CommunityID, name, in.Body.Description, in.Body.Palette); err != nil {
				return nil, err
			}
			sv, err := s.Server(ctx)
			if err != nil {
				return nil, err
			}
			if err := s.PublishServerUpdate(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body *Server }{sv}, nil
		})

	huma.Register(api, op("list-members", http.MethodGet, "/api/server/members", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Member }, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			if a.Member.Gated {
				return nil, errGated()
			}
			ms, err := s.Members(ctx, a.CommunityID)
			return &struct{ Body []Member }{ms}, err
		})

	huma.Register(api, op("remove-member", http.MethodDelete, "/api/server/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			a, err := s.requireActor(ctx, perms.Kick)
			if err != nil {
				return nil, err
			}
			target, err := httpx.ParseID(in.UserID, "member")
			if err != nil {
				return nil, err
			}
			if target == a.Member.UserID {
				return nil, httpx.BadRequest("CANNOT_KICK_SELF", "you cannot kick yourself")
			}
			sv, err := s.Server(ctx)
			if err != nil {
				return nil, err
			}
			if target == sv.OwnerID {
				return nil, httpx.MissingPermission()
			}
			if err := s.canModerate(ctx, a, target); err != nil {
				return nil, err
			}
			ok, err := s.removeMember(ctx, a.CommunityID, target)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.NotFound("member")
			}
			return nil, nil
		})

	huma.Register(api, op("create-invite", http.MethodPost, "/api/server/invites", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body CreateInviteRequest }) (*struct{ Body *Invite }, error) {
			a, err := s.requireActor(ctx, perms.CreateInvite)
			if err != nil {
				return nil, err
			}
			inv, err := s.createInvite(ctx, a.CommunityID, a.Member.UserID, in.Body.MaxUses, in.Body.ExpiresInSeconds)
			return &struct{ Body *Invite }{inv}, err
		})

	huma.Register(api, op("list-invites", http.MethodGet, "/api/server/invites", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Invite }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			list, err := s.listInvites(ctx, a.CommunityID)
			return &struct{ Body []Invite }{list}, err
		})

	huma.Register(api, huma.Operation{OperationID: "get-invite", Method: http.MethodGet, Path: "/api/invites/{code}", Tags: tags},
		func(ctx context.Context, in *codePath) (*struct{ Body *InvitePreview }, error) {
			p, err := s.preview(ctx, in.Code)
			return &struct{ Body *InvitePreview }{p}, err
		})

	huma.Register(api, op("accept-invite", http.MethodPost, "/api/invites/{code}/accept", http.StatusNoContent),
		func(ctx context.Context, in *codePath) (*struct{}, error) {
			return nil, s.join(ctx, in.Code, auth.Current(ctx).User.ID)
		})

	huma.Register(api, op("delete-invite", http.MethodDelete, "/api/invites/{code}", http.StatusNoContent),
		func(ctx context.Context, in *codePath) (*struct{}, error) {
			inv, err := s.invite(ctx, in.Code)
			if err != nil {
				return nil, err
			}
			if inv.CreatorID != auth.Current(ctx).User.ID {
				if _, err := s.requireActor(ctx, perms.ManageServer); err != nil {
					return nil, err
				}
			}
			return nil, s.deleteInvite(ctx, in.Code)
		})

	registerRoles(api, s, op)
	registerWelcome(api, s, op)
}
