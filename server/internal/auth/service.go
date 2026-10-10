package auth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/ratelimit"
)

const (
	CookieName = "datrope_session"
	CSRFHeader = "X-Datrope-CSRF"
)

var ErrInvalidSession = errors.New("invalid session")

// Joiner adds people to the server. The communities package implements it.
type Joiner interface {
	// Check returns an *httpx.Error if the invite cannot be used.
	Check(ctx context.Context, code string) error
	// Join makes a new account a member; code may be empty.
	Join(ctx context.Context, code string, userID id.ID) error
	// GuestTTL returns how long a guest link's guests stay, or an
	// *httpx.Error if the code is not a usable guest link.
	GuestTTL(ctx context.Context, code string) (time.Duration, error)
	// JoinGuest makes a new guest account a member holding the Guest role.
	JoinGuest(ctx context.Context, code string, userID id.ID) error
}

// Principal is the signed-in user of a request.
type Principal struct {
	User      *User
	SessionID id.ID
	ViaCookie bool
}

type ctxKey struct{}

// Current returns the signed-in user. It is non-nil inside every operation
// registered with Security: httpx.Authed.
func Current(ctx context.Context) *Principal {
	p, _ := ctx.Value(ctxKey{}).(*Principal)
	return p
}

type Service struct {
	store        *Store
	bus          *events.Bus
	joiner       Joiner
	blobs        Blobs
	loginByIP    *ratelimit.Limiter
	loginByName  *ratelimit.Limiter
	registerByIP *ratelimit.Limiter
	guestByIP    *ratelimit.Limiter
}

func NewService(pool *pgxpool.Pool, bus *events.Bus) *Service {
	return &Service{
		store:        NewStore(pool),
		bus:          bus,
		loginByIP:    ratelimit.New(10, 10),
		loginByName:  ratelimit.New(5, 5),
		registerByIP: ratelimit.New(5, 5),
		guestByIP:    ratelimit.New(5, 5),
	}
}

func (s *Service) SetJoiner(j Joiner) { s.joiner = j }

// Authenticate resolves a session token.
func (s *Service) Authenticate(ctx context.Context, token string) (*Principal, error) {
	if token == "" {
		return nil, ErrInvalidSession
	}
	sess, u, err := s.store.SessionByTokenHash(ctx, HashToken(token))
	if errors.Is(err, ErrNotFound) {
		return nil, ErrInvalidSession
	}
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, ErrInvalidSession
	}
	if err := s.store.TouchSession(ctx, sess.ID); err != nil {
		return nil, err
	}
	return &Principal{User: u, SessionID: sess.ID}, nil
}

func (s *Service) PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]PublicUser, error) {
	return s.store.PublicUsers(ctx, ids)
}

func (s *Service) UserIDsByUsername(ctx context.Context, names []string) (map[string]id.ID, error) {
	return s.store.UserIDsByUsername(ctx, names)
}

func (s *Service) Settings(ctx context.Context) (Settings, error) { return s.store.Settings(ctx) }

// authenticateRequest applies the rules shared by Huma operations and plain
// handlers: a bearer token wins; otherwise the session cookie is used, and a
// cookie request that changes state must carry the CSRF header.
func (s *Service) authenticateRequest(ctx context.Context, authorization, cookie, method, csrf string) (*Principal, *httpx.Error) {
	token, viaCookie := strings.TrimPrefix(authorization, "Bearer "), false
	if authorization == "" {
		token, viaCookie = cookieValue(cookie), true
	}
	p, err := s.Authenticate(ctx, token)
	if errors.Is(err, ErrInvalidSession) {
		return nil, httpx.Unauthorized()
	}
	if err != nil {
		rid := httpx.RequestIDFrom(ctx)
		slog.ErrorContext(ctx, "authenticate", "request_id", rid, "err", err)
		return nil, &httpx.Error{Status: http.StatusInternalServerError, Code: "INTERNAL",
			Message: "internal error", Details: map[string]any{"request_id": rid}}
	}
	if viaCookie && !safeMethod(method) && csrf != "1" {
		return nil, httpx.E(http.StatusForbidden, "CSRF_FAILED", "missing "+CSRFHeader+" header")
	}
	p.ViaCookie = viaCookie
	return p, nil
}

// Middleware authenticates operations registered with Security: httpx.Authed.
// Native clients send a bearer token. Browsers send the session cookie, and
// must add the CSRF header to anything that changes state.
func (s *Service) Middleware(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if len(ctx.Operation().Security) == 0 {
			next(ctx)
			return
		}
		p, e := s.authenticateRequest(ctx.Context(), ctx.Header("Authorization"), ctx.Header("Cookie"),
			ctx.Method(), ctx.Header(CSRFHeader))
		if e != nil {
			httpx.WriteError(api, ctx, e)
			return
		}
		next(huma.WithValue(ctx, ctxKey{}, p))
	}
}

// RequireHTTP gives a plain net/http handler (file upload and download) the
// same authentication as Huma operations; auth.Current works inside next.
func (s *Service) RequireHTTP(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, e := s.authenticateRequest(r.Context(), r.Header.Get("Authorization"), r.Header.Get("Cookie"),
			r.Method, r.Header.Get(CSRFHeader))
		if e != nil {
			httpx.WriteHTTPError(w, r, e)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, p)))
	})
}

func cookieValue(header string) string {
	cookies, err := http.ParseCookie(header)
	if err != nil {
		return ""
	}
	for _, c := range cookies {
		if c.Name == CookieName {
			return c.Value
		}
	}
	return ""
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// RevokeSessions signs the user out everywhere (a ban does this).
func (s *Service) RevokeSessions(ctx context.Context, userID id.ID) error {
	return s.revokeAll(ctx, userID)
}

// revokeAll signs the user out everywhere and drops their WebSockets.
func (s *Service) revokeAll(ctx context.Context, userID id.ID) error {
	if _, err := s.store.DeleteSessions(ctx, userID); err != nil {
		return err
	}
	s.bus.Publish(events.Event{Type: events.SessionsRevoked, Data: events.SessionsRevokedData{UserID: userID}})
	return nil
}

func (s *Service) revokeOne(userID, sessionID id.ID) {
	s.bus.Publish(events.Event{Type: events.SessionsRevoked,
		Data: events.SessionsRevokedData{UserID: userID, SessionIDs: []id.ID{sessionID}}})
}
