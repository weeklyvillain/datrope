// Package integrations connects the server to Twitch, YouTube and Spotify:
// stream alerts posted into channels, and accounts people link so others see
// when they are live or what they are listening to.
package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

// Endpoints are the services' base URLs; tests point them at fakes.
type Endpoints struct {
	TwitchAuth  string
	TwitchAPI   string
	YouTube     string
	SpotifyAuth string
	SpotifyAPI  string
}

// DefaultEndpoints are the real services.
var DefaultEndpoints = Endpoints{
	TwitchAuth: "https://id.twitch.tv", TwitchAPI: "https://api.twitch.tv", YouTube: "https://www.youtube.com",
	SpotifyAuth: "https://accounts.spotify.com", SpotifyAPI: "https://api.spotify.com",
}

func (e Endpoints) withDefaults() Endpoints {
	d := DefaultEndpoints
	for _, p := range []struct{ v, def *string }{
		{&e.TwitchAuth, &d.TwitchAuth}, {&e.TwitchAPI, &d.TwitchAPI}, {&e.YouTube, &d.YouTube},
		{&e.SpotifyAuth, &d.SpotifyAuth}, {&e.SpotifyAPI, &d.SpotifyAPI},
	} {
		if *p.v == "" {
			*p.v = *p.def
		}
	}
	return e
}

// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

// Poster posts a message under a bare name (messages.Service.PostAs).
type Poster interface {
	PostAs(ctx context.Context, channelID id.ID, name, content string) (*messages.Message, error)
}

// Activity is what someone is doing on a linked account, shown to the
// people who share the server with them.
type Activity struct {
	UserID   id.ID  `json:"user_id"`
	Type     string `json:"type" enum:"streaming,listening"`
	Platform string `json:"platform" enum:"twitch,spotify"`
	Title    string `json:"title" doc:"The stream title, or the track name"`
	Detail   string `json:"detail,omitempty" doc:"The game being streamed, or the artists"`
	URL      string `json:"url" doc:"Where to watch or listen"`
}

// ActivityUpdate is the ACTIVITY_UPDATE payload; a nil Activity means the
// user is doing nothing anymore.
type ActivityUpdate struct {
	UserID   id.ID     `json:"user_id"`
	Activity *Activity `json:"activity"`
}

type Service struct {
	db        *pgxpool.Pool
	bus       *events.Bus
	channels  Channels
	poster    Poster
	ep        Endpoints
	publicURL string
	http      *http.Client
	app       appToken // Spotify's, for the music bot's catalog lookups

	mu         sync.Mutex
	activities map[id.ID]Activity
	states     map[string]oauthState // pending OAuth sign-ins by state
	appToken   string                // Twitch app access token
	appExpiry  time.Time
	appFor     string // the client ID appToken belongs to
	ticks      int

	stop chan struct{}
	done sync.WaitGroup
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, poster Poster, publicURL string, ep Endpoints) *Service {
	return &Service{
		db: pool, bus: bus, channels: ch, poster: poster, ep: ep.withDefaults(), publicURL: publicURL,
		http:       &http.Client{Timeout: 15 * time.Second},
		activities: map[id.ID]Activity{}, states: map[string]oauthState{}, stop: make(chan struct{}),
	}
}

// pollEvery is the base tick: Spotify every tick, Twitch every second,
// YouTube every tenth.
const pollEvery = 30 * time.Second

// Start runs the poll loop until Close.
func (s *Service) Start() {
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		t := time.NewTicker(pollEvery)
		defer t.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-t.C:
				ctx, cancel := context.WithTimeout(context.Background(), pollEvery)
				if err := s.Poll(ctx); err != nil {
					slog.WarnContext(ctx, "integrations: poll", "err", err)
				}
				cancel()
			}
		}
	}()
}

func (s *Service) Close() {
	close(s.stop)
	s.done.Wait()
}

// Poll runs one round of checks. Tests call it directly.
func (s *Service) Poll(ctx context.Context) error {
	s.mu.Lock()
	tick := s.ticks
	s.ticks++
	s.mu.Unlock()
	var errs []string
	note := func(what string, err error) {
		if err != nil {
			errs = append(errs, what+": "+err.Error())
		}
	}
	note("spotify", s.pollSpotify(ctx))
	if tick%2 == 0 {
		note("twitch", s.pollTwitch(ctx))
	}
	if tick%10 == 0 {
		note("youtube", s.pollYouTube(ctx))
	}
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	return nil
}

// Activities returns what the given users are doing, for READY.
func (s *Service) Activities(userIDs []id.ID) []Activity {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []Activity{}
	for _, u := range userIDs {
		if a, ok := s.activities[u]; ok {
			out = append(out, a)
		}
	}
	return out
}

// setActivity records a user's activity (nil: none) and tells the people
// who share the server with them, when it changed.
func (s *Service) setActivity(userID id.ID, a *Activity) {
	s.mu.Lock()
	old, had := s.activities[userID]
	switch {
	case a == nil && !had, a != nil && had && old == *a:
		s.mu.Unlock()
		return
	case a == nil:
		delete(s.activities, userID)
	default:
		s.activities[userID] = *a
	}
	s.mu.Unlock()
	s.bus.Publish(events.Event{Type: "ACTIVITY_UPDATE", Data: ActivityUpdate{UserID: userID, Activity: a},
		Scope: events.Scope{CoMembersOf: userID, UserIDs: []id.ID{userID}}})
}

// getJSON fetches a URL into out. A 204 leaves out alone and returns false.
func (s *Service) getJSON(ctx context.Context, url string, header http.Header, out any) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	return s.do(req, out)
}

func (s *Service) do(req *http.Request, out any) (bool, error) {
	resp, err := s.http.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return false, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return false, err
	}
	if resp.StatusCode >= 300 {
		return false, &httpError{status: resp.StatusCode, body: string(body)}
	}
	return true, json.Unmarshal(body, out)
}

type httpError struct {
	status int
	body   string
}

func (e *httpError) Error() string {
	b := e.body
	if len(b) > 200 {
		b = b[:200]
	}
	return fmt.Sprintf("HTTP %d: %s", e.status, b)
}

// credentials returns a provider's client ID and secret ("" when unset).
func (s *Service) credentials(ctx context.Context, provider string) (clientID, secret string, err error) {
	col := map[string]string{"twitch": "twitch", "spotify": "spotify"}[provider]
	err = s.db.QueryRow(ctx, `SELECT coalesce(`+col+`_client_id, ''), coalesce(`+col+`_client_secret, '') FROM instance_settings`).
		Scan(&clientID, &secret)
	return clientID, secret, err
}
