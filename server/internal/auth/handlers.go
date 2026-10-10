package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type RegisterRequest struct {
	Username   string  `json:"username" minLength:"2" maxLength:"32" pattern:"^[A-Za-z0-9_.-]+$"`
	Email      *string `json:"email,omitempty" format:"email" maxLength:"254"`
	Password   string  `json:"password" minLength:"8" maxLength:"256"`
	InviteCode string  `json:"invite_code,omitempty" maxLength:"64"`
	DeviceName string  `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string  `json:"client" enum:"web,native"`
}

type LoginRequest struct {
	Login      string `json:"login" minLength:"1" maxLength:"254" doc:"Username or email"`
	Password   string `json:"password" minLength:"1" maxLength:"256"`
	DeviceName string `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string `json:"client" enum:"web,native"`
}

type AuthResult struct {
	User  *User  `json:"user"`
	Token string `json:"token,omitempty" doc:"Session token for native clients. Web clients get a cookie instead."`
}

type authOutput struct {
	SetCookie []http.Cookie `header:"Set-Cookie"`
	Body      AuthResult
}

type InstanceInfo struct {
	RegistrationMode string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	HasUsers         bool   `json:"has_users" doc:"False until the first (admin) account exists"`
	MaxUploadBytes   int64  `json:"max_upload_bytes" doc:"Largest file a user may upload"`
	GIFsEnabled      bool   `json:"gifs_enabled" doc:"A Klipy key is set, so /gif is available"`
	TwitchEnabled    bool   `json:"twitch_enabled" doc:"Twitch credentials are set: stream alerts and Twitch connections work"`
	SpotifyEnabled   bool   `json:"spotify_enabled" doc:"Spotify credentials are set: Spotify connections work"`
}

type UpdateMeRequest struct {
	DisplayName  *string   `json:"display_name,omitempty" minLength:"1" maxLength:"32"`
	CustomStatus *string   `json:"custom_status,omitempty" maxLength:"80" doc:"Shown under your name; empty clears it"`
	Pronouns     *string   `json:"pronouns,omitempty" maxLength:"40" doc:"Empty clears them"`
	AboutMe      *string   `json:"about_me,omitempty" maxLength:"190" doc:"Empty clears it"`
	Links        *[]string `json:"links,omitempty" maxItems:"10" doc:"At most 5 https:// links of 200 characters each, after blanks and duplicates are removed; an empty list clears them"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"auth"}
	huma.Register(api, huma.Operation{OperationID: "register", Method: http.MethodPost, Path: "/api/auth/register", Tags: tags},
		func(ctx context.Context, in *struct{ Body RegisterRequest }) (*authOutput, error) {
			return s.register(ctx, in.Body)
		})
	huma.Register(api, huma.Operation{OperationID: "login", Method: http.MethodPost, Path: "/api/auth/login", Tags: tags},
		func(ctx context.Context, in *struct{ Body LoginRequest }) (*authOutput, error) {
			return s.login(ctx, in.Body)
		})
	huma.Register(api, huma.Operation{OperationID: "logout", Method: http.MethodPost, Path: "/api/auth/logout",
		Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, _ *struct{}) (*struct {
			SetCookie []http.Cookie `header:"Set-Cookie"`
		}, error) {
			p := Current(ctx)
			if _, err := s.store.DeleteSession(ctx, p.User.ID, p.SessionID); err != nil {
				return nil, err
			}
			s.revokeOne(p.User.ID, p.SessionID)
			out := &struct {
				SetCookie []http.Cookie `header:"Set-Cookie"`
			}{}
			if p.ViaCookie { // expire the cookie
				out.SetCookie = []http.Cookie{{Name: CookieName, Value: "", Path: "/", MaxAge: -1,
					HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode}}
			}
			return out, nil
		})
	huma.Register(api, huma.Operation{OperationID: "get-instance", Method: http.MethodGet, Path: "/api/instance", Tags: tags},
		func(ctx context.Context, _ *struct{}) (*struct{ Body InstanceInfo }, error) {
			set, err := s.store.Settings(ctx)
			if err != nil {
				return nil, err
			}
			n, err := s.store.CountUsers(ctx)
			if err != nil {
				return nil, err
			}
			return &struct{ Body InstanceInfo }{InstanceInfo{
				RegistrationMode: set.RegistrationMode, HasUsers: n > 0, MaxUploadBytes: set.MaxUploadBytes,
				GIFsEnabled: set.KlipyConfigured, TwitchEnabled: set.TwitchConfigured, SpotifyEnabled: set.SpotifyConfigured,
			}}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "get-me", Method: http.MethodGet, Path: "/api/users/@me",
		Tags: []string{"users"}, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body *User }, error) {
			return &struct{ Body *User }{Current(ctx).User}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "update-me", Method: http.MethodPatch, Path: "/api/users/@me",
		Tags: []string{"users"}, Security: httpx.Authed},
		func(ctx context.Context, in *struct{ Body UpdateMeRequest }) (*struct{ Body *User }, error) {
			trim := func(p *string) *string {
				if p == nil {
					return nil
				}
				t := strings.TrimSpace(*p)
				return &t
			}
			name := trim(in.Body.DisplayName)
			if name != nil && *name == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "display name cannot be blank")
			}
			var links *[]string
			if in.Body.Links != nil {
				l, err := validateLinks(*in.Body.Links)
				if err != nil {
					return nil, err
				}
				links = &l
			}
			u, err := s.store.UpdateProfile(ctx, Current(ctx).User.ID, ProfilePatch{
				DisplayName: name, CustomStatus: trim(in.Body.CustomStatus),
				Pronouns: trim(in.Body.Pronouns), AboutMe: trim(in.Body.AboutMe), Links: links})
			if err != nil {
				return nil, err
			}
			s.publishUser(u)
			return &struct{ Body *User }{u}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "list-sessions", Method: http.MethodGet, Path: "/api/sessions",
		Tags: tags, Security: httpx.Authed},
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Session }, error) {
			if IsGuest(ctx) {
				return nil, GuestForbidden()
			}
			p := Current(ctx)
			list, err := s.store.ListSessions(ctx, p.User.ID)
			if err != nil {
				return nil, err
			}
			for i := range list {
				list[i].Current = list[i].ID == p.SessionID
			}
			return &struct{ Body []Session }{list}, nil
		})
	huma.Register(api, huma.Operation{OperationID: "delete-session", Method: http.MethodDelete, Path: "/api/sessions/{id}",
		Tags: tags, Security: httpx.Authed, DefaultStatus: http.StatusNoContent},
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{}, error) {
			if IsGuest(ctx) {
				return nil, GuestForbidden()
			}
			sid, err := httpx.ParseID(in.ID, "session")
			if err != nil {
				return nil, err
			}
			p := Current(ctx)
			ok, err := s.store.DeleteSession(ctx, p.User.ID, sid)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.NotFound("session")
			}
			s.revokeOne(p.User.ID, sid)
			return nil, nil
		})
	registerAdmin(api, s)
	registerGuest(api, s)
}

func (s *Service) register(ctx context.Context, b RegisterRequest) (*authOutput, error) {
	if !s.registerByIP.Allow(httpx.ClientIPFrom(ctx)) {
		return nil, httpx.RateLimited()
	}
	set, err := s.store.Settings(ctx)
	if err != nil {
		return nil, err
	}
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return nil, err
	}
	if n > 0 { // the first user can always register and becomes the admin
		switch set.RegistrationMode {
		case ModeAdminOnly:
			return nil, httpx.E(http.StatusForbidden, "REGISTRATION_CLOSED", "registration is closed on this instance")
		case ModeInviteOnly:
			if b.InviteCode == "" || s.joiner == nil {
				return nil, httpx.E(http.StatusForbidden, "INVITE_REQUIRED", "an invite code is required to register")
			}
			if err := s.joiner.Check(ctx, b.InviteCode); err != nil {
				return nil, err
			}
		}
	}
	u, err := s.createUser(ctx, b.Username, b.Email, b.Username, b.Password)
	if err != nil {
		return nil, err
	}
	if s.joiner != nil {
		// The account exists now; failing to join (e.g. the invite was used up
		// a moment ago) should not fail the sign-up: they can join later.
		err := s.joiner.Join(ctx, b.InviteCode, u.ID)
		if err != nil && b.InviteCode != "" && (n == 0 || set.RegistrationMode == ModeOpen) {
			// This sign-up did not need the invite, so a bad one does not matter.
			slog.WarnContext(ctx, "join with invite after registration", "user_id", u.ID, "err", err)
			err = s.joiner.Join(ctx, "", u.ID)
		}
		if err != nil {
			slog.WarnContext(ctx, "join after registration", "user_id", u.ID, "err", err)
		}
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}

func (s *Service) createUser(ctx context.Context, username string, email *string, displayName, password string) (*User, error) {
	hash, err := HashPassword(password)
	if err != nil {
		return nil, err
	}
	if email != nil {
		e := strings.TrimSpace(*email)
		email = &e
	}
	u := &User{ID: id.New(), Username: username, Email: email, DisplayName: displayName, PasswordHash: hash}
	if err := s.store.CreateUser(ctx, u); err != nil {
		if errors.Is(err, ErrTaken) {
			return nil, httpx.E(http.StatusConflict, "USERNAME_TAKEN", "username or email is already in use")
		}
		return nil, err
	}
	return u, nil
}

func (s *Service) login(ctx context.Context, b LoginRequest) (*authOutput, error) {
	if !s.loginByIP.Allow(httpx.ClientIPFrom(ctx)) || !s.loginByName.Allow(strings.ToLower(b.Login)) {
		return nil, httpx.RateLimited()
	}
	invalid := httpx.E(http.StatusUnauthorized, "INVALID_CREDENTIALS", "wrong username or password")
	u, err := s.store.UserByLogin(ctx, b.Login)
	if errors.Is(err, ErrNotFound) {
		_, _ = VerifyPassword(b.Password, dummyHash()) // equalise timing
		return nil, invalid
	}
	if err != nil {
		return nil, err
	}
	ok, err := VerifyPassword(b.Password, u.PasswordHash)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, invalid
	}
	if u.Disabled {
		return nil, httpx.E(http.StatusForbidden, "ACCOUNT_DISABLED", "this account has been disabled")
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}

func (s *Service) startSession(ctx context.Context, u *User, device, client string) (*authOutput, error) {
	token, hash, err := NewToken()
	if err != nil {
		return nil, err
	}
	sess := &Session{ID: id.New(), UserID: u.ID, TokenHash: hash, DeviceName: device}
	if err := s.store.CreateSession(ctx, sess); err != nil {
		return nil, err
	}
	out := &authOutput{Body: AuthResult{User: u}}
	if client == "web" {
		out.SetCookie = []http.Cookie{sessionCookie(token, 400*24*time.Hour)}
	} else {
		out.Body.Token = token
	}
	return out, nil
}

func sessionCookie(value string, maxAge time.Duration) http.Cookie {
	return http.Cookie{
		Name: CookieName, Value: value, Path: "/", MaxAge: int(maxAge.Seconds()),
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode,
	}
}

// publishUser tells co-members (and the user's other sessions) about a profile change.
func (s *Service) publishUser(u *User) {
	s.bus.Publish(events.Event{Type: "USER_UPDATE", Data: u.Public(),
		Scope: events.Scope{CoMembersOf: u.ID, UserIDs: []id.ID{u.ID}}})
}
