package gifs

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"gifs"}
	huma.Register(api, huma.Operation{OperationID: "list-trending-gifs", Method: http.MethodGet, Path: "/api/gifs/trending",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			Pos string `query:"pos" maxLength:"10" doc:"next from the previous page"`
		}) (*struct{ Body *GIFPage }, error) {
			p, err := s.List(ctx, auth.Current(ctx).User.ID, "", in.Pos)
			return &struct{ Body *GIFPage }{p}, err
		})
	huma.Register(api, huma.Operation{OperationID: "search-gifs", Method: http.MethodGet, Path: "/api/gifs/search",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			Q   string `query:"q" required:"true" minLength:"1" maxLength:"100"`
			Pos string `query:"pos" maxLength:"10" doc:"next from the previous page"`
		}) (*struct{ Body *GIFPage }, error) {
			q := strings.TrimSpace(in.Q)
			if q == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "q cannot be blank")
			}
			p, err := s.List(ctx, auth.Current(ctx).User.ID, q, in.Pos)
			return &struct{ Body *GIFPage }{p}, err
		})
	huma.Register(api, huma.Operation{OperationID: "attach-gif", Method: http.MethodPost, Path: "/api/gifs/{id}/attach",
		Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusCreated,
		Description: "Stores the GIF on this server as an unsent attachment; send it with attachment_ids."},
		func(ctx context.Context, in *struct {
			ID        string `path:"id" maxLength:"200" doc:"A GIF's id from trending or search"`
			ChannelID string `query:"channel_id" required:"true"`
		}) (*struct{ Body *files.Attachment }, error) {
			channelID, err := httpx.ParseID(in.ChannelID, "channel")
			if err != nil {
				return nil, err
			}
			a, err := s.Attach(ctx, auth.Current(ctx).User.ID, channelID, in.ID)
			return &struct{ Body *files.Attachment }{a}, err
		})
}
