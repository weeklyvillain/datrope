package httpx_test

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

// captureLogs sends slog's output to a buffer for the rest of the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

func TestLoggerHidesSecretsInPaths(t *testing.T) {
	logs := captureLogs(t)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/webhooks/{id}/{token}", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/channels/{id}/messages", func(w http.ResponseWriter, r *http.Request) {})
	h := httpx.Chain(mux, httpx.RequestID, httpx.ClientIP(false), httpx.Logger, httpx.Recover)

	const token = "s3cr3t-T0ken_abcdefghijklmnopqrstuvwxyz0123"
	for _, tc := range []struct {
		name, method, path string
		status             int
	}{
		{"matched", http.MethodPost, "/api/webhooks/123/" + token + "?wait=true", http.StatusNoContent},
		{"wrong method", http.MethodGet, "/api/webhooks/123/" + token, http.StatusMethodNotAllowed},
		{"suffix", http.MethodPost, "/api/webhooks/123/" + token + "/github", http.StatusNotFound},
		{"trailing slash", http.MethodPost, "/api/webhooks/123/" + token + "/", http.StatusNotFound},
		{"redirected", http.MethodGet, "/api//webhooks/123/" + token, http.StatusMovedPermanently},
	} {
		logs.Reset()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, nil))
		require.Equal(t, tc.status, rec.Code, tc.name)
		require.NotContains(t, logs.String(), token, tc.name)
		require.Contains(t, logs.String(), "/api/webhooks/123/…", tc.name)
	}

	// A path whose first segment is not a numeric ID may itself be a token: nothing after the prefix is logged.
	// The prefix matches in any case.
	for _, tc := range []struct{ path, want string }{
		{"/api/webhooks//" + token, "path=/api/webhooks/… "},
		{"/api/webhooks/" + token, "path=/api/webhooks/… "},
		{"/api/webhooks/" + token + "/x", "path=/api/webhooks/… "},
		{"/API/WEBHOOKS/123/" + token, "path=/api/webhooks/123/… "},
		{"/Api/Webhooks/" + token, "path=/api/webhooks/… "},
		{"/api/webhooks/123", "path=/api/webhooks/123 "},
	} {
		logs.Reset()
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, tc.path, nil))
		require.NotContains(t, logs.String(), token, tc.path)
		require.Contains(t, logs.String(), tc.want, tc.path)
	}

	// Other paths are logged as they are, IDs and all.
	logs.Reset()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/channels/42/messages", nil))
	require.Contains(t, logs.String(), "path=/api/channels/42/messages")
}
