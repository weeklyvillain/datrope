package httpx_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/httpx"
)

func assertError(t *testing.T, resp *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	require.Equal(t, status, resp.Code, resp.Body.String())
	var e httpx.Error
	require.NoError(t, json.Unmarshal(resp.Body.Bytes(), &e))
	require.Equal(t, code, e.Code)
}

func TestErrorShape(t *testing.T) {
	_, api := humatest.New(t)
	type validateIn struct {
		Body struct {
			Name string `json:"name" minLength:"3"`
		}
	}
	huma.Register(api, huma.Operation{OperationID: "validate", Method: http.MethodPost, Path: "/v"},
		func(ctx context.Context, in *validateIn) (*struct{}, error) { return nil, nil })
	huma.Register(api, huma.Operation{OperationID: "typed", Method: http.MethodGet, Path: "/typed"},
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			return nil, httpx.E(http.StatusConflict, "USERNAME_TAKEN", "taken")
		})
	huma.Register(api, huma.Operation{OperationID: "boom", Method: http.MethodGet, Path: "/boom"},
		func(ctx context.Context, _ *struct{}) (*struct{}, error) { return nil, errors.New("secret db detail") })

	assertError(t, api.Post("/v", map[string]any{"name": "x"}), http.StatusBadRequest, "VALIDATION_FAILED")
	assertError(t, api.Get("/typed"), http.StatusConflict, "USERNAME_TAKEN")

	resp := api.Get("/boom")
	assertError(t, resp, http.StatusInternalServerError, "INTERNAL")
	require.NotContains(t, resp.Body.String(), "secret", "500s must not leak internals")
}

func TestRequestIDAndClientIP(t *testing.T) {
	var gotIP, gotRID string
	h := httpx.Chain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotIP = httpx.ClientIPFrom(r.Context())
		gotRID = httpx.RequestIDFrom(r.Context())
	}), httpx.RequestID, httpx.ClientIP(true))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "10.0.0.2:5555"
	req.Header.Set("X-Forwarded-For", "1.1.1.1, 203.0.113.9")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, "203.0.113.9", gotIP, "the last hop is the one our proxy added")
	require.NotEmpty(t, gotRID)
	require.Equal(t, gotRID, rec.Header().Get("X-Request-ID"))
}

func TestRecover(t *testing.T) {
	h := httpx.Chain(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("boom") }),
		httpx.RequestID, httpx.Recover)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	assertError(t, rec, http.StatusInternalServerError, "INTERNAL")
}

func TestWriteHTTPError(t *testing.T) {
	rec := httptest.NewRecorder()
	httpx.WriteHTTPError(rec, httptest.NewRequest(http.MethodGet, "/", nil), httpx.E(http.StatusRequestEntityTooLarge, "TOO_LARGE", "too big"))
	assertError(t, rec, http.StatusRequestEntityTooLarge, "TOO_LARGE")
	require.Equal(t, "application/json", rec.Header().Get("Content-Type"))

	rec = httptest.NewRecorder()
	httpx.WriteHTTPError(rec, httptest.NewRequest(http.MethodGet, "/", nil), errors.New("secret db detail"))
	assertError(t, rec, http.StatusInternalServerError, "INTERNAL")
	require.NotContains(t, rec.Body.String(), "secret")
}
