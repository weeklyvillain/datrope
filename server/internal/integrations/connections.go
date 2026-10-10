package integrations

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// Connection is an account a user linked (the tokens are never returned).
type Connection struct {
	Provider     string `json:"provider" enum:"twitch,spotify"`
	AccountName  string `json:"account_name"`
	ShowActivity bool   `json:"show_activity" doc:"Others see when you are live or what you are listening to"`
}

type ConnectStart struct {
	URL string `json:"url" doc:"Send the browser here to sign in with the provider"`
}

type UpdateConnectionRequest struct {
	ShowActivity bool `json:"show_activity"`
}

// oauthState is a sign-in under way: who started it and with which provider.
type oauthState struct {
	userID   id.ID
	provider string
	until    time.Time
}

const stateTTL = 10 * time.Minute

var providers = map[string]struct{ authorize, scope string }{
	"twitch":  {authorize: "/oauth2/authorize", scope: ""},
	"spotify": {authorize: "/authorize", scope: "user-read-currently-playing user-read-playback-state"},
}

func (s *Service) redirectURI(provider string) string {
	return s.publicURL + "/api/connections/" + provider + "/callback"
}

func (s *Service) authBase(provider string) string {
	if provider == "twitch" {
		return s.ep.TwitchAuth
	}
	return s.ep.SpotifyAuth
}

func registerConnections(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	type providerPath struct {
		Provider string `path:"provider" enum:"twitch,spotify"`
	}
	huma.Register(api, op("list-connections", http.MethodGet, "/api/users/@me/connections", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []Connection }, error) {
			rows, err := s.db.Query(ctx, `SELECT provider, account_name, show_activity FROM connections WHERE user_id = $1 ORDER BY provider`,
				auth.Current(ctx).User.ID)
			if err != nil {
				return nil, err
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Connection, error) {
				var c Connection
				return c, r.Scan(&c.Provider, &c.AccountName, &c.ShowActivity)
			})
			if list == nil {
				list = []Connection{}
			}
			return &struct{ Body []Connection }{list}, err
		})

	huma.Register(api, op("start-connection", http.MethodPost, "/api/users/@me/connections/{provider}", 0),
		func(ctx context.Context, in *providerPath) (*struct{ Body ConnectStart }, error) {
			clientID, _, err := s.credentials(ctx, in.Provider)
			if err != nil {
				return nil, err
			}
			if clientID == "" {
				return nil, httpx.BadRequest("NOT_CONFIGURED", "an instance admin has to add "+in.Provider+" credentials first")
			}
			if s.publicURL == "" {
				return nil, httpx.BadRequest("NOT_CONFIGURED", "the server's public URL (DATROPE_PUBLIC_URL) is not set")
			}
			b := make([]byte, 24)
			_, _ = rand.Read(b)
			state := base64.RawURLEncoding.EncodeToString(b)
			s.mu.Lock()
			for k, v := range s.states {
				if time.Now().After(v.until) {
					delete(s.states, k)
				}
			}
			s.states[state] = oauthState{userID: auth.Current(ctx).User.ID, provider: in.Provider, until: time.Now().Add(stateTTL)}
			s.mu.Unlock()
			p := providers[in.Provider]
			q := url.Values{"client_id": {clientID}, "redirect_uri": {s.redirectURI(in.Provider)}, "response_type": {"code"}, "state": {state}}
			if p.scope != "" {
				q.Set("scope", p.scope)
			}
			return &struct{ Body ConnectStart }{ConnectStart{URL: s.authBase(in.Provider) + p.authorize + "?" + q.Encode()}}, nil
		})

	huma.Register(api, op("update-connection", http.MethodPatch, "/api/users/@me/connections/{provider}", 0),
		func(ctx context.Context, in *struct {
			Provider string `path:"provider" enum:"twitch,spotify"`
			Body     UpdateConnectionRequest
		}) (*struct{ Body Connection }, error) {
			me := auth.Current(ctx).User.ID
			var c Connection
			err := s.db.QueryRow(ctx, `UPDATE connections SET show_activity = $3 WHERE user_id = $1 AND provider = $2
				RETURNING provider, account_name, show_activity`, me, in.Provider, in.Body.ShowActivity).
				Scan(&c.Provider, &c.AccountName, &c.ShowActivity)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("connection")
			}
			if err == nil && !c.ShowActivity {
				s.clearActivity(me, in.Provider)
			}
			return &struct{ Body Connection }{c}, err
		})

	huma.Register(api, op("delete-connection", http.MethodDelete, "/api/users/@me/connections/{provider}", http.StatusNoContent),
		func(ctx context.Context, in *providerPath) (*struct{}, error) {
			me := auth.Current(ctx).User.ID
			tag, err := s.db.Exec(ctx, `DELETE FROM connections WHERE user_id = $1 AND provider = $2`, me, in.Provider)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("connection")
			}
			s.clearActivity(me, in.Provider)
			return nil, nil
		})
}

// clearActivity drops a user's activity if it came from provider.
func (s *Service) clearActivity(userID id.ID, provider string) {
	s.mu.Lock()
	a, ok := s.activities[userID]
	s.mu.Unlock()
	if ok && a.Platform == provider {
		s.setActivity(userID, nil)
	}
}

// CallbackHandler serves GET /api/connections/{provider}/callback, where the
// provider sends the browser back after sign-in. The state names the user,
// so it needs no session; it redirects to the app's connection settings.
func (s *Service) CallbackHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		provider := r.PathValue("provider")
		back := func(result string) {
			http.Redirect(w, r, s.publicURL+"/?connection="+url.QueryEscape(provider)+"&result="+result, http.StatusFound)
		}
		q := r.URL.Query()
		s.mu.Lock()
		st, ok := s.states[q.Get("state")]
		delete(s.states, q.Get("state"))
		s.mu.Unlock()
		if !ok || st.provider != provider || time.Now().After(st.until) {
			back("expired")
			return
		}
		if q.Get("code") == "" {
			back("cancelled")
			return
		}
		if err := s.finishConnect(r.Context(), st.userID, provider, q.Get("code")); err != nil {
			slog.WarnContext(r.Context(), "integrations: connecting an account", "provider", provider, "err", err)
			back("failed")
			return
		}
		back("ok")
	})
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

// token calls a provider's token endpoint with form (a code or a refresh token).
func (s *Service) token(ctx context.Context, provider string, form url.Values) (*tokenResponse, error) {
	clientID, secret, err := s.credentials(ctx, provider)
	if err != nil {
		return nil, err
	}
	if clientID == "" {
		return nil, ErrNotConfigured
	}
	endpoint := s.ep.SpotifyAuth + "/api/token"
	if provider == "twitch" {
		endpoint = s.ep.TwitchAuth + "/oauth2/token"
		form.Set("client_id", clientID)
		form.Set("client_secret", secret)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if provider == "spotify" {
		req.SetBasicAuth(clientID, secret)
	}
	var t tokenResponse
	if _, err := s.do(req, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Service) finishConnect(ctx context.Context, userID id.ID, provider, code string) error {
	t, err := s.token(ctx, provider, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {s.redirectURI(provider)}})
	if err != nil {
		return err
	}
	var accountID, name string
	if provider == "twitch" {
		clientID, _, err := s.credentials(ctx, "twitch")
		if err != nil {
			return err
		}
		var res struct {
			Data []twitchUser `json:"data"`
		}
		if _, err := s.getJSON(ctx, s.ep.TwitchAPI+"/helix/users", twitchHeader(clientID, t.AccessToken), &res); err != nil {
			return err
		}
		if len(res.Data) == 0 {
			return errors.New("twitch returned no user")
		}
		accountID, name = res.Data[0].ID, res.Data[0].DisplayName
	} else {
		var me struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		}
		if _, err := s.getJSON(ctx, s.ep.SpotifyAPI+"/v1/me", http.Header{"Authorization": {"Bearer " + t.AccessToken}}, &me); err != nil {
			return err
		}
		accountID, name = me.ID, me.DisplayName
		if name == "" {
			name = me.ID
		}
	}
	_, err = s.db.Exec(ctx, `
		INSERT INTO connections (user_id, provider, account_id, account_name, access_token, refresh_token, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (user_id, provider) DO UPDATE SET account_id = $3, account_name = $4, access_token = $5,
			refresh_token = $6, expires_at = $7`,
		userID, provider, accountID, name, t.AccessToken, t.RefreshToken, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second))
	return err
}

// pollTwitchActivities shows "live on Twitch" for linked accounts that are streaming.
func (s *Service) pollTwitchActivities(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT user_id, account_id FROM connections WHERE provider = 'twitch' AND show_activity`)
	if err != nil {
		return err
	}
	type conn struct {
		user    id.ID
		account string
	}
	conns, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (conn, error) {
		var c conn
		return c, r.Scan(&c.user, &c.account)
	})
	if err != nil || len(conns) == 0 {
		return err
	}
	ids := make([]string, len(conns))
	for i, c := range conns {
		ids[i] = c.account
	}
	streams, err := s.twitchLive(ctx, "user_id", ids)
	if err != nil {
		return err
	}
	live := map[string]twitchStream{}
	for _, st := range streams {
		live[st.UserID] = st
	}
	for _, c := range conns {
		if st, ok := live[c.account]; ok {
			s.setActivity(c.user, &Activity{UserID: c.user, Type: "streaming", Platform: "twitch", Title: st.Title, Detail: st.GameName,
				URL: "https://www.twitch.tv/" + strings.ToLower(st.UserLogin)})
		} else {
			s.clearActivity(c.user, "twitch")
		}
	}
	return nil
}

// pollSpotify shows what linked Spotify accounts are playing.
func (s *Service) pollSpotify(ctx context.Context) error {
	clientID, _, err := s.credentials(ctx, "spotify")
	if err != nil || clientID == "" {
		return err
	}
	rows, err := s.db.Query(ctx, `SELECT user_id, access_token, refresh_token, expires_at FROM connections WHERE provider = 'spotify' AND show_activity`)
	if err != nil {
		return err
	}
	type conn struct {
		user            id.ID
		access, refresh string
		expires         time.Time
	}
	conns, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (conn, error) {
		var c conn
		return c, r.Scan(&c.user, &c.access, &c.refresh, &c.expires)
	})
	if err != nil {
		return err
	}
	var errs []error
	for _, c := range conns {
		if time.Until(c.expires) < time.Minute {
			t, err := s.token(ctx, "spotify", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.refresh}})
			if err != nil {
				errs = append(errs, err)
				continue
			}
			if t.RefreshToken != "" {
				c.refresh = t.RefreshToken
			}
			c.access = t.AccessToken
			if _, err := s.db.Exec(ctx, `UPDATE connections SET access_token = $3, refresh_token = $4, expires_at = $5 WHERE user_id = $1 AND provider = $2`,
				c.user, "spotify", c.access, c.refresh, time.Now().Add(time.Duration(t.ExpiresIn)*time.Second)); err != nil {
				return err
			}
		}
		var now struct {
			IsPlaying bool `json:"is_playing"`
			Item      *struct {
				Name         string            `json:"name"`
				ExternalURLs map[string]string `json:"external_urls"`
				Artists      []struct {
					Name string `json:"name"`
				} `json:"artists"`
				Show *struct {
					Name string `json:"name"`
				} `json:"show"`
			} `json:"item"`
		}
		got, err := s.getJSON(ctx, s.ep.SpotifyAPI+"/v1/me/player/currently-playing?additional_types=episode",
			http.Header{"Authorization": {"Bearer " + c.access}}, &now)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		if !got || !now.IsPlaying || now.Item == nil {
			s.clearActivity(c.user, "spotify")
			continue
		}
		var by []string
		for _, a := range now.Item.Artists {
			by = append(by, a.Name)
		}
		if now.Item.Show != nil {
			by = append(by, now.Item.Show.Name)
		}
		s.setActivity(c.user, &Activity{UserID: c.user, Type: "listening", Platform: "spotify", Title: now.Item.Name,
			Detail: strings.Join(by, ", "), URL: now.Item.ExternalURLs["spotify"]})
	}
	return errors.Join(errs...)
}
