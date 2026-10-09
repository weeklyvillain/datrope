package auth_test

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
)

func TestPassword(t *testing.T) {
	h, err := auth.HashPassword("correct horse")
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$"), h)

	ok, err := auth.VerifyPassword("correct horse", h)
	require.NoError(t, err)
	require.True(t, ok)

	ok, err = auth.VerifyPassword("wrong", h)
	require.NoError(t, err)
	require.False(t, ok)

	h2, err := auth.HashPassword("correct horse")
	require.NoError(t, err)
	require.NotEqual(t, h, h2, "salt must differ")

	_, err = auth.VerifyPassword("x", "$2a$10$bcrypthash")
	require.Error(t, err)
}

func TestToken(t *testing.T) {
	tok, hash, err := auth.NewToken()
	require.NoError(t, err)
	raw, err := base64.RawURLEncoding.DecodeString(tok)
	require.NoError(t, err)
	require.Len(t, raw, 32)
	require.Len(t, hash, 32)
	require.Equal(t, hash, auth.HashToken(tok))
}
