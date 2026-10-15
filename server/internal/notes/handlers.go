package notes

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type notePath struct {
	NoteID string `path:"noteID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"notes"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }

	huma.Register(api, op("list-notes", http.MethodGet, "/api/notes", 0),
		func(ctx context.Context, in *struct {
			Q string `query:"q" doc:"Only notes whose title or text contains this"`
		}) (*struct{ Body []NoteSummary }, error) {
			out, err := s.list(ctx, me(ctx), in.Q)
			return &struct{ Body []NoteSummary }{out}, err
		})

	huma.Register(api, op("create-note", http.MethodPost, "/api/notes", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body NoteCreate }) (*struct{ Body *Note }, error) {
			n, err := s.create(ctx, me(ctx), in.Body)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("get-note", http.MethodGet, "/api/notes/{noteID}", 0),
		func(ctx context.Context, in *notePath) (*struct{ Body *Note }, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			n, err := s.get(ctx, me(ctx), nid)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("update-note", http.MethodPatch, "/api/notes/{noteID}", 0),
		func(ctx context.Context, in *struct {
			NoteID string `path:"noteID"`
			Body   NoteUpdate
		}) (*struct{ Body *Note }, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			n, err := s.update(ctx, me(ctx), nid, in.Body)
			return &struct{ Body *Note }{n}, err
		})

	huma.Register(api, op("delete-note", http.MethodDelete, "/api/notes/{noteID}", http.StatusNoContent),
		func(ctx context.Context, in *notePath) (*struct{}, error) {
			nid, err := httpx.ParseID(in.NoteID, "note")
			if err != nil {
				return nil, err
			}
			return nil, s.delete(ctx, me(ctx), nid)
		})
}
