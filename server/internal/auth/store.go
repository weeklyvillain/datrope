package auth

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/db"
	"github.com/datrope/datrope/server/internal/id"
)

var (
	ErrNotFound = errors.New("not found")
	ErrTaken    = errors.New("username or email already in use")
)

const (
	ModeInviteOnly = "invite_only"
	ModeOpen       = "open"
	ModeAdminOnly  = "admin_only"
)

// SystemUserID is the System account: it sends reminders and cannot log in. Its ID is one the
// snowflake generator could only have produced in its epoch's first millisecond, so it never
// collides with a real user (or with the small IDs tests seed by hand).
const SystemUserID id.ID = 1<<22 - 1

// User is the full account. Only its owner and admins see it.
type User struct {
	ID           id.ID     `json:"id"`
	Username     string    `json:"username"`
	Email        *string   `json:"email,omitempty"`
	DisplayName  string    `json:"display_name"`
	CustomStatus string    `json:"custom_status"`
	IsAdmin      bool      `json:"is_admin"`
	Disabled     bool      `json:"disabled"`
	CreatedAt    time.Time `json:"created_at"`
	PasswordHash string    `json:"-"`
	Pronouns     string    `json:"pronouns,omitempty" doc:"Up to 40 characters"`
	AboutMe      string    `json:"about_me,omitempty" doc:"Up to 190 characters"`
	AvatarURL    string    `json:"avatar_url,omitempty" doc:"A 256 × 256 image; absent when the user has none, and clients draw initials"`
	BannerURL    string    `json:"banner_url,omitempty" doc:"A 960 × 320 image; absent when the user has none"`
	Links        []string  `json:"links,omitempty" doc:"Up to 5 https:// links"`
	// GuestExpiresAt is set for guests.
	GuestExpiresAt *time.Time `json:"guest_expires_at,omitempty" doc:"Set for guests: when their access ends"`
}

// PublicUser is what other users may see.
type PublicUser struct {
	ID           id.ID    `json:"id"`
	Username     string   `json:"username"`
	DisplayName  string   `json:"display_name"`
	CustomStatus string   `json:"custom_status"`
	Pronouns     string   `json:"pronouns,omitempty" doc:"Up to 40 characters"`
	AboutMe      string   `json:"about_me,omitempty" doc:"Up to 190 characters"`
	AvatarURL    string   `json:"avatar_url,omitempty" doc:"A 256 × 256 image; absent when the user has none, and clients draw initials"`
	BannerURL    string   `json:"banner_url,omitempty" doc:"A 960 × 320 image; absent when the user has none"`
	Links        []string `json:"links,omitempty" doc:"Up to 5 https:// links"`
	// GuestExpiresAt is set for guests.
	GuestExpiresAt *time.Time `json:"guest_expires_at,omitempty" doc:"Set for guests: when their access ends"`
	System         bool       `json:"system,omitempty" doc:"The System account, which sends reminders; it cannot be messaged"`
}

func (u *User) Public() PublicUser {
	return PublicUser{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName, CustomStatus: u.CustomStatus,
		Pronouns: u.Pronouns, AboutMe: u.AboutMe, AvatarURL: u.AvatarURL, BannerURL: u.BannerURL, Links: u.Links,
		GuestExpiresAt: u.GuestExpiresAt}
}

type Session struct {
	ID         id.ID     `json:"id"`
	UserID     id.ID     `json:"-"`
	DeviceName string    `json:"device_name"`
	CreatedAt  time.Time `json:"created_at"`
	LastUsedAt time.Time `json:"last_used_at"`
	Current    bool      `json:"current"`
	TokenHash  []byte    `json:"-"`
}

type Settings struct {
	RegistrationMode  string `json:"registration_mode" enum:"invite_only,open,admin_only"`
	MaxUploadBytes    int64  `json:"max_upload_bytes" doc:"Largest file a user may upload"`
	KlipyConfigured   bool   `json:"klipy_configured" doc:"A Klipy API key is set, so /gif works. The key itself is never returned."`
	TwitchConfigured  bool   `json:"twitch_configured" doc:"Twitch app credentials are set (never returned)"`
	SpotifyConfigured bool   `json:"spotify_configured" doc:"Spotify app credentials are set (never returned)"`
}

type Store struct{ db *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{db: pool} }

const userCols = `u.id, u.username, u.email, u.display_name, u.custom_status, u.is_admin, u.disabled, u.created_at, u.password_hash, u.pronouns, u.about_me, u.avatar_sha256, u.banner_sha256, u.links, u.guest_expires_at`

func scanUser(row pgx.Row, extra ...any) (*User, error) {
	var u User
	var avatar, banner *string
	dest := append(extra, &u.ID, &u.Username, &u.Email, &u.DisplayName, &u.CustomStatus, &u.IsAdmin, &u.Disabled, &u.CreatedAt, &u.PasswordHash,
		&u.Pronouns, &u.AboutMe, &avatar, &banner, &u.Links, &u.GuestExpiresAt)
	err := row.Scan(dest...)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.AvatarURL = avatarKind.imageURL(u.ID, avatar)
	u.BannerURL = bannerKind.imageURL(u.ID, banner)
	return &u, nil
}

// CreateUser inserts u. The first user ever created becomes the instance
// admin; u.IsAdmin and u.CreatedAt are filled in.
func (s *Store) CreateUser(ctx context.Context, u *User) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Serialise sign-ups so exactly one user can be the first.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(1001)`); err != nil {
		return err
	}
	var n int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE NOT is_system`).Scan(&n); err != nil {
		return err
	}
	u.IsAdmin = n == 0
	err = tx.QueryRow(ctx, `
		INSERT INTO users (id, username, email, display_name, password_hash, is_admin, guest_expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING created_at`,
		u.ID, u.Username, u.Email, u.DisplayName, u.PasswordHash, u.IsAdmin, u.GuestExpiresAt).Scan(&u.CreatedAt)
	if db.IsUniqueViolation(err) {
		return ErrTaken
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM users WHERE NOT is_system`).Scan(&n)
	return n, err
}

func (s *Store) UserByID(ctx context.Context, userID id.ID) (*User, error) {
	return scanUser(s.db.QueryRow(ctx, `SELECT `+userCols+` FROM users u WHERE u.id = $1`, userID))
}

// UserByLogin finds a user by username or email, ignoring case.
func (s *Store) UserByLogin(ctx context.Context, login string) (*User, error) {
	return scanUser(s.db.QueryRow(ctx,
		`SELECT `+userCols+` FROM users u WHERE NOT u.is_system AND (lower(u.username) = lower($1) OR lower(u.email) = lower($1))`, login))
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.Query(ctx, `SELECT `+userCols+` FROM users u WHERE NOT u.is_system ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}
	return out, rows.Err()
}

func (s *Store) PublicUsers(ctx context.Context, ids []id.ID) (map[id.ID]PublicUser, error) {
	rows, err := s.db.Query(ctx, `SELECT id, username, display_name, custom_status, pronouns, about_me, avatar_sha256, banner_sha256, links, guest_expires_at, is_system FROM users WHERE id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[id.ID]PublicUser, len(ids))
	for rows.Next() {
		var p PublicUser
		var avatar, banner *string
		if err := rows.Scan(&p.ID, &p.Username, &p.DisplayName, &p.CustomStatus, &p.Pronouns, &p.AboutMe, &avatar, &banner, &p.Links, &p.GuestExpiresAt, &p.System); err != nil {
			return nil, err
		}
		p.AvatarURL = avatarKind.imageURL(p.ID, avatar)
		p.BannerURL = bannerKind.imageURL(p.ID, banner)
		out[p.ID] = p
	}
	return out, rows.Err()
}

// ProfilePatch holds the profile fields to change; nil leaves a field as it is.
type ProfilePatch struct {
	DisplayName, CustomStatus, Pronouns, AboutMe *string
	Links                                        *[]string
}

// UpdateProfile changes the fields that are not nil.
func (s *Store) UpdateProfile(ctx context.Context, userID id.ID, p ProfilePatch) (*User, error) {
	var links []string // nil (SQL NULL) leaves the column as it is
	if p.Links != nil {
		links = *p.Links
		if links == nil {
			links = []string{}
		}
	}
	return scanUser(s.db.QueryRow(ctx, `
		UPDATE users u SET display_name = COALESCE($2, display_name), custom_status = COALESCE($3, custom_status),
		                   pronouns = COALESCE($4, pronouns), about_me = COALESCE($5, about_me), links = COALESCE($6, links)
		WHERE u.id = $1 RETURNING `+userCols, userID, p.DisplayName, p.CustomStatus, p.Pronouns, p.AboutMe, links))
}

// DeleteUser removes an account that has nothing attached yet (a guest
// whose join failed). Accounts with messages cannot be deleted.
func (s *Store) DeleteUser(ctx context.Context, userID id.ID) error {
	return s.execOne(ctx, `DELETE FROM users WHERE id = $1`, userID)
}

func (s *Store) SetPassword(ctx context.Context, userID id.ID, hash string) error {
	return s.execOne(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1 AND NOT is_system`, userID, hash)
}

func (s *Store) SetDisabled(ctx context.Context, userID id.ID, disabled bool) error {
	return s.execOne(ctx, `UPDATE users SET disabled = $2 WHERE id = $1 AND NOT is_system`, userID, disabled)
}

func (s *Store) execOne(ctx context.Context, sql string, args ...any) error {
	tag, err := s.db.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) CreateSession(ctx context.Context, sess *Session) error {
	return s.db.QueryRow(ctx, `
		INSERT INTO sessions (id, user_id, token_hash, device_name) VALUES ($1, $2, $3, $4)
		RETURNING created_at, last_used_at`,
		sess.ID, sess.UserID, sess.TokenHash, sess.DeviceName).Scan(&sess.CreatedAt, &sess.LastUsedAt)
}

func (s *Store) SessionByTokenHash(ctx context.Context, hash []byte) (*Session, *User, error) {
	var sess Session
	u, err := scanUser(s.db.QueryRow(ctx, `
		SELECT s.id, s.user_id, s.device_name, s.created_at, s.last_used_at, `+userCols+`
		FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`, hash),
		&sess.ID, &sess.UserID, &sess.DeviceName, &sess.CreatedAt, &sess.LastUsedAt)
	if err != nil {
		return nil, nil, err
	}
	return &sess, u, nil
}

func (s *Store) ListSessions(ctx context.Context, userID id.ID) ([]Session, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, user_id, device_name, created_at, last_used_at FROM sessions
		WHERE user_id = $1 ORDER BY last_used_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Session{}
	for rows.Next() {
		var x Session
		if err := rows.Scan(&x.ID, &x.UserID, &x.DeviceName, &x.CreatedAt, &x.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// DeleteSession deletes one session of userID and reports whether it existed.
func (s *Store) DeleteSession(ctx context.Context, userID, sessionID id.ID) (bool, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE id = $1 AND user_id = $2`, sessionID, userID)
	return tag.RowsAffected() > 0, err
}

// DeleteSessions deletes all sessions of a user and returns their IDs.
func (s *Store) DeleteSessions(ctx context.Context, userID id.ID) ([]id.ID, error) {
	rows, err := s.db.Query(ctx, `DELETE FROM sessions WHERE user_id = $1 RETURNING id`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[id.ID])
}

func (s *Store) Settings(ctx context.Context) (Settings, error) {
	var x Settings
	err := s.db.QueryRow(ctx, `SELECT registration_mode, max_upload_bytes, klipy_api_key IS NOT NULL,
		twitch_client_id IS NOT NULL, spotify_client_id IS NOT NULL FROM instance_settings`).
		Scan(&x.RegistrationMode, &x.MaxUploadBytes, &x.KlipyConfigured, &x.TwitchConfigured, &x.SpotifyConfigured)
	return x, err
}

func (s *Store) UpdateSettings(ctx context.Context, x Settings) error {
	_, err := s.db.Exec(ctx, `UPDATE instance_settings SET registration_mode = $1, max_upload_bytes = $2`,
		x.RegistrationMode, x.MaxUploadBytes)
	return err
}

// SetKlipyKey stores the Klipy API key; "" removes it (turning /gif off).
func (s *Store) SetKlipyKey(ctx context.Context, key string) error {
	_, err := s.db.Exec(ctx, `UPDATE instance_settings SET klipy_api_key = NULLIF($1, '')`, key)
	return err
}

// SetAppCredentials stores a provider's ("twitch" or "spotify") client ID
// and secret; empty strings remove them.
func (s *Store) SetAppCredentials(ctx context.Context, provider, clientID, secret string) error {
	col := map[string]string{"twitch": "twitch", "spotify": "spotify"}[provider] // never user input in SQL
	_, err := s.db.Exec(ctx, `UPDATE instance_settings SET `+col+`_client_id = NULLIF($1, ''), `+col+`_client_secret = NULLIF($2, '')`, clientID, secret)
	return err
}

// KlipyConfig returns the Klipy API key ("" when unset) and the instance secret.
func (s *Store) KlipyConfig(ctx context.Context) (string, []byte, error) {
	var key string
	var secret []byte
	err := s.db.QueryRow(ctx, `SELECT coalesce(klipy_api_key, ''), instance_secret FROM instance_settings`).Scan(&key, &secret)
	return key, secret, err
}

// TouchSession records use, at most once a minute per session.
func (s *Store) TouchSession(ctx context.Context, sessionID id.ID) error {
	_, err := s.db.Exec(ctx, `
		UPDATE sessions SET last_used_at = now()
		WHERE id = $1 AND last_used_at < now() - interval '1 minute'`, sessionID)
	return err
}

// UserIDsByUsername maps lower-cased usernames to user IDs; unknown names are absent.
func (s *Store) UserIDsByUsername(ctx context.Context, names []string) (map[string]id.ID, error) {
	rows, err := s.db.Query(ctx, `SELECT lower(username), id FROM users WHERE NOT is_system AND lower(username) = ANY($1)`, names)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]id.ID{}
	for rows.Next() {
		var n string
		var uid id.ID
		if err := rows.Scan(&n, &uid); err != nil {
			return nil, err
		}
		out[n] = uid
	}
	return out, rows.Err()
}
