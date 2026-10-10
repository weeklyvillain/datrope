package integrations

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrNotConfigured: the instance has no credentials for the service.
var ErrNotConfigured = errors.New("integrations: not configured")

type twitchUser struct {
	ID          string `json:"id"`
	Login       string `json:"login"`
	DisplayName string `json:"display_name"`
}

type twitchStream struct {
	UserID    string `json:"user_id"`
	UserLogin string `json:"user_login"`
	UserName  string `json:"user_name"`
	GameName  string `json:"game_name"`
	Title     string `json:"title"`
	Type      string `json:"type"`
}

// twitchApp returns the client ID and a current app access token.
func (s *Service) twitchApp(ctx context.Context) (string, string, error) {
	clientID, secret, err := s.credentials(ctx, "twitch")
	if err != nil {
		return "", "", err
	}
	if clientID == "" {
		return "", "", ErrNotConfigured
	}
	s.mu.Lock()
	tok, exp, forID := s.appToken, s.appExpiry, s.appFor
	s.mu.Unlock()
	if tok != "" && forID == clientID && time.Until(exp) > time.Minute {
		return clientID, tok, nil
	}
	form := url.Values{"client_id": {clientID}, "client_secret": {secret}, "grant_type": {"client_credentials"}}
	var res struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.ep.TwitchAuth+"/oauth2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if _, err := s.do(req, &res); err != nil {
		return "", "", err
	}
	s.mu.Lock()
	s.appToken, s.appExpiry, s.appFor = res.AccessToken, time.Now().Add(time.Duration(res.ExpiresIn)*time.Second), clientID
	s.mu.Unlock()
	return clientID, res.AccessToken, nil
}

func twitchHeader(clientID, token string) http.Header {
	return http.Header{"Client-Id": {clientID}, "Authorization": {"Bearer " + token}}
}

// twitchUsers looks users up by login (key "login") or ID (key "id").
func (s *Service) twitchUsers(ctx context.Context, key string, values []string) ([]twitchUser, error) {
	clientID, tok, err := s.twitchApp(ctx)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	for _, v := range values {
		q.Add(key, v)
	}
	var res struct {
		Data []twitchUser `json:"data"`
	}
	_, err = s.getJSON(ctx, s.ep.TwitchAPI+"/helix/users?"+q.Encode(), twitchHeader(clientID, tok), &res)
	return res.Data, err
}

// twitchLive returns the live streams among the given users (key "user_login"
// or "user_id"), 100 at a time.
func (s *Service) twitchLive(ctx context.Context, key string, values []string) ([]twitchStream, error) {
	clientID, tok, err := s.twitchApp(ctx)
	if err != nil {
		return nil, err
	}
	var out []twitchStream
	for start := 0; start < len(values); start += 100 {
		q := url.Values{"first": {"100"}}
		for _, v := range values[start:min(start+100, len(values))] {
			q.Add(key, v)
		}
		var res struct {
			Data []twitchStream `json:"data"`
		}
		if _, err := s.getJSON(ctx, s.ep.TwitchAPI+"/helix/streams?"+q.Encode(), twitchHeader(clientID, tok), &res); err != nil {
			return nil, err
		}
		for _, st := range res.Data {
			if st.Type == "live" {
				out = append(out, st)
			}
		}
	}
	return out, nil
}

// pollTwitch announces streamers who went live and refreshes the "live on
// Twitch" activity of linked accounts.
func (s *Service) pollTwitch(ctx context.Context) error {
	if _, _, err := s.twitchApp(ctx); errors.Is(err, ErrNotConfigured) {
		return nil
	} else if err != nil {
		return err
	}
	return errors.Join(s.pollTwitchAlerts(ctx), s.pollTwitchActivities(ctx))
}
