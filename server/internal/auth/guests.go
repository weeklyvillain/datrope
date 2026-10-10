package auth

import (
	"context"
	"crypto/rand"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type GuestJoinRequest struct {
	Nick       string `json:"nick" maxLength:"200" doc:"Shown as the guest's name; 1-32 characters after trimming"`
	DeviceName string `json:"device_name" minLength:"1" maxLength:"64"`
	Client     string `json:"client" enum:"web,native"`
}

// GuestForbidden is returned when a guest calls something only full accounts may use.
func GuestForbidden() *httpx.Error {
	return httpx.E(http.StatusForbidden, "GUEST_FORBIDDEN", "guests cannot do this")
}

// IsGuest reports whether the signed-in user of ctx is a guest.
func IsGuest(ctx context.Context) bool {
	p := Current(ctx)
	return p != nil && p.User.GuestExpiresAt != nil
}

func registerGuest(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{OperationID: "join-as-guest", Method: http.MethodPost,
		Path: "/api/invites/{code}/guest", Tags: []string{"server"}},
		func(ctx context.Context, in *struct {
			Code          string `path:"code"`
			Authorization string `header:"Authorization"`
			Cookie        string `header:"Cookie"`
			Body          GuestJoinRequest
		}) (*authOutput, error) {
			return s.joinAsGuest(ctx, in.Code, in.Authorization, in.Cookie, in.Body)
		})
}

func validNick(raw string) (string, bool) {
	n := strings.TrimSpace(raw)
	if n == "" || utf8.RuneCountInString(n) > 32 {
		return "", false
	}
	for _, r := range n {
		if unicode.IsControl(r) {
			return "", false
		}
	}
	return n, true
}

func (s *Service) joinAsGuest(ctx context.Context, code, authorization, cookie string, b GuestJoinRequest) (*authOutput, error) {
	if !s.guestByIP.Allow(httpx.ClientIPFrom(ctx)) {
		return nil, httpx.RateLimited()
	}
	token := strings.TrimPrefix(authorization, "Bearer ")
	if authorization == "" {
		token = cookieValue(cookie)
	}
	if token != "" {
		if _, err := s.Authenticate(ctx, token); err == nil {
			return nil, httpx.E(http.StatusConflict, "ALREADY_SIGNED_IN", "you are signed in; join with your account instead")
		}
	}
	nick, ok := validNick(b.Nick)
	if !ok {
		return nil, httpx.BadRequest("INVALID_NICK", "a nickname is 1-32 characters with no control characters")
	}
	if s.joiner == nil {
		return nil, httpx.NotFound("invite")
	}
	ttl, err := s.joiner.GuestTTL(ctx, code)
	if err != nil {
		return nil, err
	}
	hash, err := HashPassword(rand.Text()) // nobody knows it: guests cannot log in with a password
	if err != nil {
		return nil, err
	}
	expires := time.Now().Add(ttl)
	u := &User{ID: id.New(), Username: "guest-" + strings.ToLower(rand.Text()[:10]), DisplayName: nick,
		PasswordHash: hash, GuestExpiresAt: &expires}
	if err := s.store.CreateUser(ctx, u); err != nil {
		return nil, err
	}
	if err := s.joiner.JoinGuest(ctx, code, u.ID); err != nil {
		// The link was used up or deleted a moment ago; drop the empty account.
		if derr := s.store.DeleteUser(ctx, u.ID); derr != nil {
			slog.ErrorContext(ctx, "deleting a guest whose join failed", "user_id", u.ID, "err", derr)
		}
		return nil, err
	}
	return s.startSession(ctx, u, b.DeviceName, b.Client)
}

// RetireUser disables an account and signs it out everywhere (a guest whose
// time is up, or who was kicked or banned).
func (s *Service) RetireUser(ctx context.Context, userID id.ID) error {
	if err := s.store.SetDisabled(ctx, userID, true); err != nil {
		return err
	}
	return s.revokeAll(ctx, userID)
}

// ExpiredGuests lists up to limit guests whose time ran out before now and
// who are not retired yet.
func (s *Service) ExpiredGuests(ctx context.Context, now time.Time, limit int) ([]id.ID, error) {
	rows, err := s.store.db.Query(ctx, `
		SELECT id FROM users WHERE guest_expires_at <= $1 AND NOT disabled
		ORDER BY guest_expires_at LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []id.ID
	for rows.Next() {
		var uid id.ID
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		out = append(out, uid)
	}
	return out, rows.Err()
}
