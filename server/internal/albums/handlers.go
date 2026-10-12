package albums

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type albumPath struct {
	AlbumID string `path:"albumID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"albums"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }

	huma.Register(api, op("list-albums", http.MethodGet, "/api/albums", 0),
		func(ctx context.Context, in *struct {
			Contains string `query:"contains" doc:"An attachment ID: say whether each album holds it"`
		}) (*struct{ Body []Album }, error) {
			var c *id.ID
			if in.Contains != "" {
				v, err := httpx.ParseID(in.Contains, "attachment")
				if err != nil {
					return nil, err
				}
				c = &v
			}
			out, err := s.list(ctx, me(ctx), c)
			return &struct{ Body []Album }{out}, err
		})

	huma.Register(api, op("create-album", http.MethodPost, "/api/albums", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body AlbumCreate }) (*struct{ Body *Album }, error) {
			a, err := s.create(ctx, me(ctx), in.Body)
			return &struct{ Body *Album }{a}, err
		})

	huma.Register(api, op("get-album", http.MethodGet, "/api/albums/{albumID}", 0),
		func(ctx context.Context, in *albumPath) (*struct{ Body *Album }, error) {
			aid, err := httpx.ParseID(in.AlbumID, "album")
			if err != nil {
				return nil, err
			}
			a, err := s.get(ctx, me(ctx), aid)
			return &struct{ Body *Album }{a}, err
		})

	huma.Register(api, op("update-album", http.MethodPatch, "/api/albums/{albumID}", 0),
		func(ctx context.Context, in *struct {
			AlbumID string `path:"albumID"`
			Body    AlbumUpdate
		}) (*struct{ Body *Album }, error) {
			aid, err := httpx.ParseID(in.AlbumID, "album")
			if err != nil {
				return nil, err
			}
			a, err := s.update(ctx, me(ctx), aid, in.Body)
			return &struct{ Body *Album }{a}, err
		})

	huma.Register(api, op("delete-album", http.MethodDelete, "/api/albums/{albumID}", http.StatusNoContent),
		func(ctx context.Context, in *albumPath) (*struct{}, error) {
			aid, err := httpx.ParseID(in.AlbumID, "album")
			if err != nil {
				return nil, err
			}
			return nil, s.remove(ctx, me(ctx), aid)
		})

	type memberPath struct {
		AlbumID string `path:"albumID"`
		UserID  string `path:"userID"`
	}
	ids := func(in *memberPath) (id.ID, id.ID, error) {
		aid, err := httpx.ParseID(in.AlbumID, "album")
		if err != nil {
			return 0, 0, err
		}
		uid, err := httpx.ParseID(in.UserID, "user")
		return aid, uid, err
	}
	huma.Register(api, op("add-album-member", http.MethodPut, "/api/albums/{albumID}/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			aid, uid, err := ids(in)
			if err != nil {
				return nil, err
			}
			return nil, s.addMember(ctx, me(ctx), aid, uid)
		})
	huma.Register(api, op("remove-album-member", http.MethodDelete, "/api/albums/{albumID}/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *memberPath) (*struct{}, error) {
			aid, uid, err := ids(in)
			if err != nil {
				return nil, err
			}
			return nil, s.removeMember(ctx, me(ctx), aid, uid)
		})

	registerItems(api, s, op, me)
}
