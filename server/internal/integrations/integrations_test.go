package integrations_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/integrations"
	"github.com/datrope/datrope/server/internal/messages"
)

const ytID = "UCabcdefghijklmnopqrstuv"

// fakes is Twitch, YouTube and Spotify in one server.
type fakes struct {
	mu       sync.Mutex
	live     bool   // the Twitch streamer is live
	newest   string // the YouTube channel's newest video
	playing  bool   // the Spotify account is playing
	srv      *httptest.Server
	tokenFor map[string]string // grant_type seen per token call
}

func newFakes(t *testing.T) *fakes {
	f := &fakes{newest: "vid00000001", tokenFor: map[string]string{}}
	mux := http.NewServeMux()
	j := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("POST /twitch-auth/oauth2/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Form.Get("client_id") != "tw-id" || r.Form.Get("client_secret") != "tw-secret" {
			http.Error(w, "bad client", http.StatusBadRequest)
			return
		}
		j(w, map[string]any{"access_token": "app-token", "expires_in": 3600})
	})
	mux.HandleFunc("GET /twitch-api/helix/users", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("login") == "nobody" {
			j(w, map[string]any{"data": []any{}})
			return
		}
		j(w, map[string]any{"data": []any{map[string]string{"id": "42", "login": "coolstreamer", "display_name": "CoolStreamer"}}})
	})
	mux.HandleFunc("GET /twitch-api/helix/streams", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		live := f.live
		f.mu.Unlock()
		data := []any{}
		if live {
			data = append(data, map[string]string{"user_id": "42", "user_login": "coolstreamer", "user_name": "CoolStreamer",
				"game_name": "Chess", "title": "Speedruns *today*", "type": "live"})
		}
		j(w, map[string]any{"data": data})
	})
	mux.HandleFunc("GET /youtube/@coolchannel", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<html><head><link rel="canonical" href="https://www.youtube.com/channel/%s"></head></html>`, ytID)
	})
	mux.HandleFunc("GET /youtube/feeds/videos.xml", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("channel_id") != ytID {
			http.NotFound(w, r)
			return
		}
		f.mu.Lock()
		newest := f.newest
		f.mu.Unlock()
		fmt.Fprintf(w, `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<title>Cool Channel</title>
<entry><yt:videoId>%s</yt:videoId><title>Newest &amp; best</title></entry>
<entry><yt:videoId>older000001</yt:videoId><title>Older</title></entry></feed>`, newest)
	})
	mux.HandleFunc("POST /spotify-auth/api/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if id, secret, ok := r.BasicAuth(); !ok || id != "sp-id" || secret != "sp-secret" {
			http.Error(w, "bad client", http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		f.tokenFor[r.Form.Get("grant_type")] = r.Form.Get("code") + r.Form.Get("refresh_token")
		f.mu.Unlock()
		j(w, map[string]any{"access_token": "user-token", "refresh_token": "refresh", "expires_in": 3600})
	})
	mux.HandleFunc("GET /spotify-api/v1/me", func(w http.ResponseWriter, r *http.Request) {
		j(w, map[string]string{"id": "sp-user", "display_name": "Listener"})
	})
	mux.HandleFunc("GET /spotify-api/v1/me/player/currently-playing", func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "Bearer user-token", r.Header.Get("Authorization"))
		f.mu.Lock()
		playing := f.playing
		f.mu.Unlock()
		if !playing {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		j(w, map[string]any{"is_playing": true, "item": map[string]any{
			"name": "Song", "external_urls": map[string]string{"spotify": "https://open.spotify.com/track/x"},
			"artists": []map[string]string{{"name": "Band"}, {"name": "Singer"}},
		}})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakes) set(fn func(*fakes)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

func setup(t *testing.T) (*apptest.Env, *fakes, *apptest.Client) {
	f := newFakes(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) {
		c.Integrations = integrations.Endpoints{
			TwitchAuth: f.srv.URL + "/twitch-auth", TwitchAPI: f.srv.URL + "/twitch-api", YouTube: f.srv.URL + "/youtube",
			SpotifyAuth: f.srv.URL + "/spotify-auth", SpotifyAPI: f.srv.URL + "/spotify-api",
		}
	})
	owner := env.Register("alice") // the first user is the instance admin
	return env, f, owner
}

func messagesIn(t *testing.T, c *apptest.Client, channelID id.ID) []messages.Message {
	t.Helper()
	var ms []messages.Message
	c.Do(http.MethodGet, "/api/channels/"+channelID.String()+"/messages", nil, http.StatusOK, &ms)
	return ms
}

func TestStreamAlerts(t *testing.T) {
	env, f, alice := setup(t)
	bob := env.Register("bob")
	general := alice.General()
	alerts := "/api/channels/" + general.String() + "/alerts"
	poll := func() { require.NoError(t, integrations.PollAll(t.Context(), env.App.Integrations)) }

	bob.Fail(http.MethodPost, alerts, map[string]any{"platform": "youtube", "account": "@coolchannel"}, http.StatusForbidden, "MISSING_PERMISSION")
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "twitch", "account": "coolstreamer"}, http.StatusBadRequest, "NOT_CONFIGURED")

	// YouTube needs no credentials. Only videos posted after the alert is added are announced.
	var yt integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "youtube", "account": "https://www.youtube.com/@coolchannel"}, http.StatusCreated, &yt)
	require.Equal(t, ytID, yt.Account)
	require.Equal(t, "Cool Channel", yt.DisplayName)
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "youtube", "account": ytID}, http.StatusConflict, "ALREADY_FOLLOWED")
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "youtube", "account": "https://example.com/x"}, http.StatusBadRequest, "BAD_ACCOUNT")
	poll()
	require.Empty(t, messagesIn(t, alice, general))
	f.set(func(f *fakes) { f.newest = "vid00000002" })
	poll()
	ms := messagesIn(t, alice, general)
	require.Len(t, ms, 1)
	require.Nil(t, ms[0].Author)
	require.Equal(t, "YouTube", ms[0].Webhook.Name)
	require.Contains(t, ms[0].Content, "https://www.youtube.com/watch?v=vid00000002")
	require.Contains(t, ms[0].Content, "Newest & best")
	poll()
	require.Len(t, messagesIn(t, alice, general), 1, "each video once")

	// Twitch: announced once per stream.
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"twitch": map[string]string{"client_id": "tw-id", "client_secret": "tw-secret"}}, http.StatusOK, nil)
	alice.Fail(http.MethodPost, alerts, map[string]any{"platform": "twitch", "account": "nobody"}, http.StatusBadRequest, "BAD_ACCOUNT")
	var tw integrations.StreamAlert
	alice.Do(http.MethodPost, alerts, map[string]any{"platform": "twitch", "account": "https://www.twitch.tv/CoolStreamer"}, http.StatusCreated, &tw)
	require.Equal(t, "coolstreamer", tw.Account)
	f.set(func(f *fakes) { f.live = true })
	poll()
	poll()
	ms = messagesIn(t, alice, general)
	require.Len(t, ms, 2)
	require.Equal(t, "Twitch", ms[0].Webhook.Name)
	require.Equal(t, "🔴 **CoolStreamer** is live on Twitch playing Chess: Speedruns \\*today\\*\nhttps://www.twitch.tv/coolstreamer", ms[0].Content)

	var list []integrations.StreamAlert
	alice.Do(http.MethodGet, alerts, nil, http.StatusOK, &list)
	require.Len(t, list, 2)
	alice.Do(http.MethodDelete, alerts+"/"+tw.ID.String(), nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, alerts, nil, http.StatusOK, &list)
	require.Len(t, list, 1)
}

func TestSpotifyConnection(t *testing.T) {
	env, f, alice := setup(t)
	bob := env.Register("bob")
	bobWS, _ := bob.Connect()
	conns := "/api/users/@me/connections"

	alice.Fail(http.MethodPost, conns+"/spotify", nil, http.StatusBadRequest, "NOT_CONFIGURED")
	alice.Do(http.MethodPatch, "/api/admin/settings", map[string]any{"spotify": map[string]string{"client_id": "sp-id", "client_secret": "sp-secret"}}, http.StatusOK, nil)
	var start integrations.ConnectStart
	alice.Do(http.MethodPost, conns+"/spotify", nil, http.StatusOK, &start)
	u, err := url.Parse(start.URL)
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(start.URL, f.srv.URL+"/spotify-auth/authorize?"))
	require.Equal(t, "sp-id", u.Query().Get("client_id"))
	require.Equal(t, apptest.PublicURL+"/api/connections/spotify/callback", u.Query().Get("redirect_uri"))

	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	callback := func(state string) string {
		resp, err := noFollow.Get(env.Server.URL + "/api/connections/spotify/callback?code=the-code&state=" + url.QueryEscape(state))
		require.NoError(t, err)
		resp.Body.Close()
		require.Equal(t, http.StatusFound, resp.StatusCode)
		return resp.Header.Get("Location")
	}
	require.Contains(t, callback("forged"), "result=expired")
	require.Contains(t, callback(u.Query().Get("state")), "result=ok")
	require.Contains(t, callback(u.Query().Get("state")), "result=expired", "a state works once")

	var list []integrations.Connection
	alice.Do(http.MethodGet, conns, nil, http.StatusOK, &list)
	require.Equal(t, []integrations.Connection{{Provider: "spotify", AccountName: "Listener", ShowActivity: true}}, list)

	f.set(func(f *fakes) { f.playing = true })
	require.NoError(t, integrations.PollAll(t.Context(), env.App.Integrations))
	var up integrations.ActivityUpdate
	bobWS.ExpectDispatch("ACTIVITY_UPDATE", &up)
	require.Equal(t, alice.User.ID, up.UserID)
	require.Equal(t, &integrations.Activity{UserID: alice.User.ID, Type: "listening", Platform: "spotify", Title: "Song",
		Detail: "Band, Singer", URL: "https://open.spotify.com/track/x"}, up.Activity)
	_, ready := bob.Connect()
	require.Len(t, ready.Activities, 1, "READY carries current activities")

	alice.Do(http.MethodPatch, conns+"/spotify", map[string]any{"show_activity": false}, http.StatusOK, nil)
	bobWS.ExpectDispatch("ACTIVITY_UPDATE", &up)
	require.Nil(t, up.Activity, "hiding the activity clears it at once")
	alice.Do(http.MethodDelete, conns+"/spotify", nil, http.StatusNoContent, nil)
	alice.Do(http.MethodGet, conns, nil, http.StatusOK, &list)
	require.Empty(t, list)
}
