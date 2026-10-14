package push

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

type SubscriptionKeys struct {
	P256dh string `json:"p256dh" minLength:"1" maxLength:"200"`
	Auth   string `json:"auth" minLength:"1" maxLength:"100"`
}

type SubscriptionInput struct {
	Endpoint string           `json:"endpoint" minLength:"1" maxLength:"2000" doc:"The push service URL from PushSubscription.endpoint"`
	Keys     SubscriptionKeys `json:"keys"`
	Level    string           `json:"level" enum:"all,mentions,nothing" doc:"This device's notification level"`
}

type EndpointInput struct {
	Endpoint string `json:"endpoint" minLength:"1" maxLength:"2000"`
}

type PublicKey struct {
	PublicKey string `json:"public_key" doc:"VAPID application server key, base64url"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"push"}
	op := func(oid, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: oid, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}

	huma.Register(api, op("get-push-key", http.MethodGet, "/api/push/key", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body PublicKey }, error) {
			k, err := s.PublicKey(ctx)
			return &struct{ Body PublicKey }{PublicKey{k}}, err
		})

	huma.Register(api, op("put-push-subscription", http.MethodPut, "/api/push/subscription", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body SubscriptionInput }) (*struct{}, error) {
			if !s.allowedEndpoint(in.Body.Endpoint) {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "endpoint is not a known push service")
			}
			p := auth.Current(ctx)
			return nil, s.save(ctx, p.User.ID, p.SessionID, in.Body.Endpoint, in.Body.Keys.P256dh, in.Body.Keys.Auth, in.Body.Level)
		})

	huma.Register(api, op("delete-push-subscription", http.MethodDelete, "/api/push/subscription", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body EndpointInput }) (*struct{}, error) {
			return nil, s.remove(ctx, auth.Current(ctx).User.ID, in.Body.Endpoint)
		})
}

type manifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type,omitempty"`
	Purpose string `json:"purpose,omitempty"`
}

type manifest struct {
	Name            string         `json:"name"`
	ShortName       string         `json:"short_name"`
	StartURL        string         `json:"start_url"`
	Scope           string         `json:"scope"`
	Display         string         `json:"display"`
	BackgroundColor string         `json:"background_color"`
	ThemeColor      string         `json:"theme_color"`
	Icons           []manifestIcon `json:"icons"`
}

// background is --background in clients/web/src/styles.css.
const background = "#131313"

// serverIcons lists the server icon's app sizes (files.ServerAppIcon) in place
// of Datrope's. Android builds the installed app from them; a full-size upload
// listed as "any" is the likely reason it never reached the app drawer.
func serverIcons(iconURL string) []manifestIcon {
	v := iconVersion(iconURL)
	return []manifestIcon{
		{Src: "/api/server/icon/192.png" + v, Sizes: "192x192", Type: "image/png"},
		{Src: "/api/server/icon/512.png" + v, Sizes: "512x512", Type: "image/png"},
		{Src: "/api/server/icon/maskable-512.png" + v, Sizes: "512x512", Type: "image/png", Purpose: "maskable"},
	}
}

// iconVersion is the server icon URL's cache-busting query, for its resized copies.
func iconVersion(iconURL string) string {
	if u, err := url.Parse(iconURL); err == nil {
		return "?v=" + url.QueryEscape(u.Query().Get("v"))
	}
	return ""
}

// ManifestHandler serves the PWA manifest, named after this instance's server
// so two installed servers on one phone stay apart.
func (s *Service) ManifestHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := "Datrope"
		icons := []manifestIcon{
			{Src: "/icons/pwa-192x192.png", Sizes: "192x192", Type: "image/png"},
			{Src: "/icons/pwa-512x512.png", Sizes: "512x512", Type: "image/png"},
			{Src: "/icons/maskable-icon-512x512.png", Sizes: "512x512", Type: "image/png", Purpose: "maskable"},
		}
		if sv, err := s.d.Server.Server(r.Context()); err == nil && sv != nil {
			if sv.Name != "" {
				name = sv.Name
			}
			if sv.IconURL != nil {
				icons = serverIcons(*sv.IconURL)
			}
		}
		w.Header().Set("Content-Type", "application/manifest+json")
		w.Header().Set("Cache-Control", "no-cache")
		_ = json.NewEncoder(w).Encode(manifest{
			Name: name, ShortName: name, StartURL: "/", Scope: "/", Display: "standalone",
			BackgroundColor: background, ThemeColor: background, Icons: icons,
		})
	})
}
