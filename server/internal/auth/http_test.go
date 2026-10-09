package auth_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/pgtest"
)

func TestRequireHTTP(t *testing.T) {
	ctx := context.Background()
	pool := pgtest.New(t)
	svc := auth.NewService(pool, &events.Bus{})
	store := auth.NewStore(pool)
	u := &auth.User{ID: id.New(), Username: "alice", DisplayName: "Alice", PasswordHash: "x"}
	require.NoError(t, store.CreateUser(ctx, u))
	token, hash, err := auth.NewToken()
	require.NoError(t, err)
	require.NoError(t, store.CreateSession(ctx, &auth.Session{ID: id.New(), UserID: u.ID, TokenHash: hash, DeviceName: "test"}))

	h := svc.RequireHTTP(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(auth.Current(r.Context()).User.Username))
	}))
	do := func(method string, headers map[string]string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/upload", nil)
		for k, v := range headers {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}
	code := func(rec *httptest.ResponseRecorder) string {
		var e httpx.Error
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &e))
		return e.Code
	}

	rec := do(http.MethodPost, map[string]string{"Authorization": "Bearer " + token})
	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "alice", rec.Body.String())

	rec = do(http.MethodGet, nil)
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Equal(t, "UNAUTHORIZED", code(rec))

	cookie := auth.CookieName + "=" + token
	require.Equal(t, http.StatusOK, do(http.MethodGet, map[string]string{"Cookie": cookie}).Code)

	rec = do(http.MethodPost, map[string]string{"Cookie": cookie})
	require.Equal(t, http.StatusForbidden, rec.Code)
	require.Equal(t, "CSRF_FAILED", code(rec))

	require.Equal(t, http.StatusOK, do(http.MethodPost, map[string]string{"Cookie": cookie, auth.CSRFHeader: "1"}).Code)
}
