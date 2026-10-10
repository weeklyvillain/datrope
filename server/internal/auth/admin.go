package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
)

type UpdateSettingsRequest struct {
	RegistrationMode *string `json:"registration_mode,omitempty" enum:"invite_only,open,admin_only"`
	MaxUploadBytes   *int64  `json:"max_upload_bytes,omitempty" minimum:"1048576" maximum:"10737418240"`
	KlipyAPIKey      *string `json:"klipy_api_key,omitempty" maxLength:"200" doc:"Write-only: responses report klipy_configured instead. Empty removes the key."`

	// App credentials, write-only like the Klipy key. A client ID and secret are set together; empty removes both.
	Twitch  *AppCredentials `json:"twitch,omitempty" doc:"Twitch app credentials (stream alerts, Twitch connections)"`
	Spotify *AppCredentials `json:"spotify,omitempty" doc:"Spotify app credentials (Spotify connections)"`
}

type AppCredentials struct {
	ClientID     string `json:"client_id" maxLength:"200"`
	ClientSecret string `json:"client_secret" maxLength:"200"`
}

type CreateUserRequest struct {
	Username    string  `json:"username" minLength:"2" maxLength:"32" pattern:"^[A-Za-z0-9_.-]+$"`
	Password    string  `json:"password" minLength:"8" maxLength:"256"`
	Email       *string `json:"email,omitempty" format:"email" maxLength:"254"`
	DisplayName string  `json:"display_name,omitempty" maxLength:"32"`
}

func requireAdmin(ctx context.Context) (*Principal, error) {
	p := Current(ctx)
	if !p.User.IsAdmin {
		return nil, httpx.MissingPermission()
	}
	return p, nil
}

func registerAdmin(api huma.API, s *Service) {
	tags := []string{"admin"}
	huma.Register(api, huma.Operation{OperationID: "admin-get-settings", Method: http.MethodGet,
		Path: "/api/admin/settings", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body Settings }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			set, err := s.store.Settings(ctx)
			return &struct{ Body Settings }{set}, err
		})
	huma.Register(api, huma.Operation{OperationID: "admin-update-settings", Method: http.MethodPatch,
		Path: "/api/admin/settings", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body UpdateSettingsRequest }) (*struct{ Body Settings }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			set, err := s.store.Settings(ctx)
			if err != nil {
				return nil, err
			}
			if in.Body.RegistrationMode != nil {
				set.RegistrationMode = *in.Body.RegistrationMode
			}
			if in.Body.MaxUploadBytes != nil {
				set.MaxUploadBytes = *in.Body.MaxUploadBytes
			}
			if err := s.store.UpdateSettings(ctx, set); err != nil {
				return nil, err
			}
			if in.Body.KlipyAPIKey != nil {
				key := strings.TrimSpace(*in.Body.KlipyAPIKey)
				if err := s.store.SetKlipyKey(ctx, key); err != nil {
					return nil, err
				}
				set.KlipyConfigured = key != ""
			}
			for provider, c := range map[string]*AppCredentials{"twitch": in.Body.Twitch, "spotify": in.Body.Spotify} {
				if c == nil {
					continue
				}
				id, secret := strings.TrimSpace(c.ClientID), strings.TrimSpace(c.ClientSecret)
				if (id == "") != (secret == "") {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "set both the client ID and the client secret, or neither")
				}
				if err := s.store.SetAppCredentials(ctx, provider, id, secret); err != nil {
					return nil, err
				}
			}
			if set, err = s.store.Settings(ctx); err != nil {
				return nil, err
			}
			return &struct{ Body Settings }{set}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "admin-list-users", Method: http.MethodGet,
		Path: "/api/admin/users", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body []User }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			users, err := s.store.ListUsers(ctx)
			return &struct{ Body []User }{users}, err
		})
	huma.Register(api, huma.Operation{OperationID: "admin-create-user", Method: http.MethodPost,
		Path: "/api/admin/users", Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusCreated},
		func(ctx context.Context, in *struct{ Body CreateUserRequest }) (*struct{ Body *User }, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			b := in.Body
			display := b.DisplayName
			if display == "" {
				display = b.Username
			}
			u, err := s.createUser(ctx, b.Username, b.Email, display, b.Password)
			if err != nil {
				return nil, err
			}
			if s.joiner != nil {
				if err := s.joiner.Join(ctx, "", u.ID); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *User }{u}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "admin-reset-password", Method: http.MethodPut,
		Path: "/api/admin/users/{id}/password", Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Password string `json:"password" minLength:"8" maxLength:"256"`
			}
		}) (*struct{}, error) {
			if _, err := requireAdmin(ctx); err != nil {
				return nil, err
			}
			uid, err := httpx.ParseID(in.ID, "user")
			if err != nil {
				return nil, err
			}
			hash, err := HashPassword(in.Body.Password)
			if err != nil {
				return nil, err
			}
			if err := s.store.SetPassword(ctx, uid, hash); err != nil {
				return nil, notFoundOr(err)
			}
			return nil, s.revokeAll(ctx, uid)
		})
	huma.Register(api, huma.Operation{OperationID: "admin-set-disabled", Method: http.MethodPut,
		Path: "/api/admin/users/{id}/disabled", Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body struct {
				Disabled bool `json:"disabled"`
			}
		}) (*struct{ Body *User }, error) {
			p, err := requireAdmin(ctx)
			if err != nil {
				return nil, err
			}
			uid, err := httpx.ParseID(in.ID, "user")
			if err != nil {
				return nil, err
			}
			if uid == p.User.ID && in.Body.Disabled {
				return nil, httpx.BadRequest("CANNOT_DISABLE_SELF", "you cannot disable your own account")
			}
			if err := s.store.SetDisabled(ctx, uid, in.Body.Disabled); err != nil {
				return nil, notFoundOr(err)
			}
			if in.Body.Disabled {
				if err := s.revokeAll(ctx, uid); err != nil {
					return nil, err
				}
			}
			u, err := s.store.UserByID(ctx, uid)
			return &struct{ Body *User }{u}, err
		})
}

func notFoundOr(err error) error {
	if errors.Is(err, ErrNotFound) {
		return httpx.NotFound("user")
	}
	return err
}
