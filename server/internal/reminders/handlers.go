package reminders

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"reminders"}
	huma.Register(api, huma.Operation{OperationID: "create-reminder", Method: http.MethodPost, Path: "/api/reminders",
		DefaultStatus: http.StatusCreated, Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body CreateReminderRequest }) (*struct{ Body *Reminder }, error) {
			r, err := s.create(ctx, auth.Current(ctx).User.ID, in.Body)
			return &struct{ Body *Reminder }{r}, err
		})
	huma.Register(api, huma.Operation{OperationID: "list-reminders", Method: http.MethodGet, Path: "/api/reminders",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body ReminderList }, error) {
			rs, err := s.list(ctx, auth.Current(ctx).User.ID)
			return &struct{ Body ReminderList }{ReminderList{Reminders: rs}}, err
		})
	huma.Register(api, huma.Operation{OperationID: "delete-reminder", Method: http.MethodDelete, Path: "/api/reminders/{id}",
		DefaultStatus: http.StatusNoContent, Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			rid, err := httpx.ParseID(in.ID, "reminder")
			if err != nil {
				return nil, err
			}
			return nil, s.delete(ctx, auth.Current(ctx).User.ID, rid)
		})
}
