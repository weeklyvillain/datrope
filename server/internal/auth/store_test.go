package auth_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/pgtest"
)

func TestStore(t *testing.T) {
	ctx := context.Background()
	s := auth.NewStore(pgtest.New(t))

	alice := &auth.User{ID: id.New(), Username: "Alice", DisplayName: "Alice", PasswordHash: "h"}
	require.NoError(t, s.CreateUser(ctx, alice))
	require.True(t, alice.IsAdmin, "the first user is the instance admin")

	email := "Bob@Example.com"
	bob := &auth.User{ID: id.New(), Username: "bob", Email: &email, DisplayName: "Bob", PasswordHash: "h"}
	require.NoError(t, s.CreateUser(ctx, bob))
	require.False(t, bob.IsAdmin)

	dup := &auth.User{ID: id.New(), Username: "ALICE", DisplayName: "x", PasswordHash: "h"}
	require.ErrorIs(t, s.CreateUser(ctx, dup), auth.ErrTaken, "usernames are case-insensitive")

	got, err := s.UserByLogin(ctx, "bob@example.com")
	require.NoError(t, err)
	require.Equal(t, bob.ID, got.ID)
	_, err = s.UserByLogin(ctx, "nobody")
	require.ErrorIs(t, err, auth.ErrNotFound)

	pub, err := s.PublicUsers(ctx, []id.ID{alice.ID, bob.ID})
	require.NoError(t, err)
	require.Equal(t, "Bob", pub[bob.ID].DisplayName)

	n, err := s.CountUsers(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, n)

	_, hash, err := auth.NewToken()
	require.NoError(t, err)
	sess := &auth.Session{ID: id.New(), UserID: bob.ID, TokenHash: hash, DeviceName: "laptop"}
	require.NoError(t, s.CreateSession(ctx, sess))

	gotSess, gotUser, err := s.SessionByTokenHash(ctx, hash)
	require.NoError(t, err)
	require.Equal(t, sess.ID, gotSess.ID)
	require.Equal(t, bob.ID, gotUser.ID)

	list, err := s.ListSessions(ctx, bob.ID)
	require.NoError(t, err)
	require.Len(t, list, 1)

	deleted, err := s.DeleteSession(ctx, alice.ID, sess.ID)
	require.NoError(t, err)
	require.False(t, deleted, "users cannot delete other users' sessions")

	ids, err := s.DeleteSessions(ctx, bob.ID)
	require.NoError(t, err)
	require.Equal(t, []id.ID{sess.ID}, ids)
	_, _, err = s.SessionByTokenHash(ctx, hash)
	require.ErrorIs(t, err, auth.ErrNotFound)

	set, err := s.Settings(ctx)
	require.NoError(t, err)
	require.Equal(t, auth.Settings{RegistrationMode: auth.ModeInviteOnly, MaxUploadBytes: 52428800, UploadTTLRules: []auth.TTLRule{}}, set)
	set.RegistrationMode = auth.ModeOpen
	require.NoError(t, s.UpdateSettings(ctx, set))
	set2, err := s.Settings(ctx)
	require.NoError(t, err)
	require.Equal(t, auth.ModeOpen, set2.RegistrationMode)
}
