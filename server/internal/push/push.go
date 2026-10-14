// Package push sends Web Push notifications for new messages to browsers
// whose user is not active in Datrope right now (spec: PWA and Web Push).
package push

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"sync"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

// Audience turns an event scope into user IDs (the gateway's resolver).
type Audience interface {
	Resolve(ctx context.Context, s events.Scope) ([]id.ID, error)
}

// Presence says whether someone is using Datrope right now (the gateway).
type Presence interface {
	Active(userID id.ID) bool
}

type Channels interface {
	Get(ctx context.Context, channelID id.ID) (*channels.Channel, error)
}

// ServerInfo gives the manifest the community's name and icon.
type ServerInfo interface {
	Server(ctx context.Context) (*communities.Server, error)
}

type Deps struct {
	Audience  Audience
	Channels  Channels
	Server    ServerInfo
	PublicURL string
}

// DefaultPushHosts are the push services browsers use. A subscription endpoint
// must be one of these domains or a subdomain of one, so the server cannot be
// made to POST to arbitrary hosts.
var DefaultPushHosts = []string{"fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"}

// maxSubscriptionsPerUser caps stored subscriptions per user; the oldest go first.
const maxSubscriptionsPerUser = 10

type Options struct {
	Sender       Sender   // nil: real Web Push
	AllowedHosts []string // nil: DefaultPushHosts
	Inline       bool     // handle MESSAGE_CREATE inside Bus.Publish (tests)
}

type Subscription struct {
	ID       id.ID
	UserID   id.ID
	Endpoint string
	P256dh   string
	Auth     string
	Level    string
}

type vapidKeys struct{ public, private string }

type Service struct {
	db     *pgxpool.Pool
	d      Deps
	o      Options
	sender Sender

	presenceMu sync.RWMutex
	presence   Presence

	keyMu  sync.Mutex
	cached *vapidKeys

	fan *fanout // see fanout.go
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, d Deps, o Options) *Service {
	s := &Service{db: pool, d: d, o: o, sender: o.Sender}
	if s.sender == nil {
		s.sender = webpushSender{keys: s.keys, subscriber: d.PublicURL}
	}
	s.fan = newFanout(s)
	if bus != nil {
		bus.Subscribe(s.fan.onEvent)
	}
	return s
}

// SetPresence is called once the gateway exists (it is built after the services).
func (s *Service) SetPresence(p Presence) {
	s.presenceMu.Lock()
	defer s.presenceMu.Unlock()
	s.presence = p
}

func (s *Service) active(userID id.ID) bool {
	s.presenceMu.RLock()
	defer s.presenceMu.RUnlock()
	return s.presence != nil && s.presence.Active(userID)
}

func (s *Service) Start() { s.fan.start() }
func (s *Service) Close() { s.fan.close() }

// keys loads the VAPID keypair, making it on first use. Concurrent first calls
// on several servers agree through ON CONFLICT DO NOTHING plus a re-read.
func (s *Service) keys(ctx context.Context) (vapidKeys, error) {
	s.keyMu.Lock()
	defer s.keyMu.Unlock()
	if s.cached != nil {
		return *s.cached, nil
	}
	var k vapidKeys
	err := s.db.QueryRow(ctx, `SELECT public_key, private_key FROM vapid_keys`).Scan(&k.public, &k.private)
	if errors.Is(err, pgx.ErrNoRows) {
		priv, pub, gerr := webpush.GenerateVAPIDKeys()
		if gerr != nil {
			return k, gerr
		}
		if _, err = s.db.Exec(ctx, `INSERT INTO vapid_keys (public_key, private_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`, pub, priv); err != nil {
			return k, err
		}
		err = s.db.QueryRow(ctx, `SELECT public_key, private_key FROM vapid_keys`).Scan(&k.public, &k.private)
	}
	if err != nil {
		return k, err
	}
	s.cached = &k
	return k, nil
}

func (s *Service) PublicKey(ctx context.Context) (string, error) {
	k, err := s.keys(ctx)
	return k.public, err
}

// save upserts a subscription by endpoint. An endpoint registered by another
// user moves to this one (the browser profile changed hands).
func (s *Service) save(ctx context.Context, userID, sessionID id.ID, endpoint, p256dh, auth, level string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err = tx.Exec(ctx, `
		INSERT INTO push_subscriptions (id, user_id, session_id, endpoint, p256dh, auth, level)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (endpoint) DO UPDATE SET
			user_id = EXCLUDED.user_id, session_id = EXCLUDED.session_id,
			p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, level = EXCLUDED.level`,
		id.New(), userID, sessionID, endpoint, p256dh, auth, level); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `
		DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (
			SELECT id FROM push_subscriptions WHERE user_id = $1
			ORDER BY created_at DESC, id DESC LIMIT $2)`, userID, maxSubscriptionsPerUser); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// allowedEndpoint reports whether endpoint is an https URL on a known push service.
func (s *Service) allowedEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	hosts := s.o.AllowedHosts
	if hosts == nil {
		hosts = DefaultPushHosts
	}
	for _, h := range hosts {
		h = strings.ToLower(h)
		if host == h || strings.HasSuffix(host, "."+h) {
			return true
		}
	}
	return false
}

func (s *Service) remove(ctx context.Context, userID id.ID, endpoint string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, userID, endpoint)
	return err
}

func (s *Service) removeByID(ctx context.Context, subID id.ID) error {
	_, err := s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, subID)
	return err
}

func (s *Service) touch(ctx context.Context, subID id.ID) error {
	_, err := s.db.Exec(ctx, `UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1`, subID)
	return err
}

// subscriptionsOf lists the subscriptions of these users, skipping level 'nothing'.
func (s *Service) subscriptionsOf(ctx context.Context, userIDs []id.ID) ([]Subscription, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, endpoint, p256dh, auth, level FROM push_subscriptions
		WHERE user_id = ANY($1) AND level <> 'nothing'`, id.Int64s(userIDs))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Subscription, error) {
		var x Subscription
		err := r.Scan(&x.ID, &x.UserID, &x.Endpoint, &x.P256dh, &x.Auth, &x.Level)
		return x, err
	})
}

// roleIDs lists the roles a user holds (one server per instance).
func (s *Service) roleIDs(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT role_id FROM member_roles WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}
