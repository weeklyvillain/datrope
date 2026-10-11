package system

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/updater"
)

func requireAdmin(ctx context.Context) error {
	if !auth.Current(ctx).User.IsAdmin {
		return httpx.MissingPermission()
	}
	return nil
}

func (s *Service) needUpdater() error {
	if s.up == nil {
		return httpx.E(http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED", "set DATROPE_UPDATER_TOKEN to update the server from here")
	}
	return nil
}

// updaterErr turns an updater failure into the API error; what names the missing thing on a 404.
func updaterErr(err error, what string) error {
	var up *upstreamError
	switch {
	case errors.Is(err, errUpdaterDown):
		return httpx.E(http.StatusServiceUnavailable, "UPDATER_UNREACHABLE", "Updater unreachable")
	case errors.As(err, &up) && up.status == http.StatusConflict:
		return httpx.E(http.StatusConflict, "UPDATE_RUNNING", "an update is already running")
	case errors.As(err, &up) && up.status == http.StatusNotFound:
		return httpx.NotFound(what)
	default:
		return httpx.E(http.StatusBadGateway, "UPDATER_ERROR", err.Error())
	}
}

func Register(api huma.API, s *Service) {
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: []string{"admin"}, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("admin-system-stats", http.MethodGet, "/api/admin/system/stats", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemStats }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemStats }{s.stats(ctx)}, nil
		})

	huma.Register(api, op("admin-system-updates", http.MethodGet, "/api/admin/system/updates", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemUpdates }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemUpdates }{s.updates(ctx, false)}, nil
		})

	huma.Register(api, op("admin-system-check-updates", http.MethodPost, "/api/admin/system/updates/check", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body SystemUpdates }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body SystemUpdates }{s.updates(ctx, true)}, nil
		})

	huma.Register(api, op("admin-system-update-server", http.MethodPost, "/api/admin/system/updates/server", http.StatusAccepted),
		func(ctx context.Context, _ *struct{}) (*struct{ Body UpdateStarted }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			id, err := s.up.update(ctx)
			if err != nil {
				return nil, updaterErr(err, "update")
			}
			return &struct{ Body UpdateStarted }{UpdateStarted{JobID: id}}, nil
		})

	huma.Register(api, op("admin-system-update-ytdlp", http.MethodPost, "/api/admin/system/updates/ytdlp", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body YtDlpStatus }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.yt.Update(ctx); err != nil {
				if errors.Is(err, ErrPinned) {
					return nil, httpx.E(http.StatusConflict, "YTDLP_PINNED", err.Error())
				}
				return nil, httpx.E(http.StatusBadGateway, "YTDLP_UPDATE_FAILED", err.Error())
			}
			return &struct{ Body YtDlpStatus }{s.yt.Status()}, nil
		})

	huma.Register(api, op("admin-system-job", http.MethodGet, "/api/admin/system/jobs/{id}", 0),
		func(ctx context.Context, in *struct {
			ID    string `path:"id" pattern:"^[0-9]{1,20}$"`
			After int    `query:"after" minimum:"0"`
		}) (*struct{ Body updater.UpdateJobLog }, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			l, err := s.up.job(ctx, in.ID, in.After)
			if err != nil {
				return nil, updaterErr(err, "job")
			}
			return &struct{ Body updater.UpdateJobLog }{l}, nil
		})

	huma.Register(api, op("admin-system-restart", http.MethodPost, "/api/admin/system/containers/{service}/restart", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			Service string `path:"service" pattern:"^[a-z0-9][a-z0-9_.-]{0,62}$"`
		}) (*struct{}, error) {
			if err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			if err := s.needUpdater(); err != nil {
				return nil, err
			}
			if err := s.up.restart(ctx, in.Service); err != nil {
				return nil, updaterErr(err, "service")
			}
			return nil, nil
		})
}
