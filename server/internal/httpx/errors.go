// Package httpx holds the REST error type (spec section 9), middleware, and small
// helpers shared by every package's handlers.
package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/id"
)

// Error is the body of every REST error. Clients branch on Code only.
type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *Error) Error() string  { return e.Message }
func (e *Error) GetStatus() int { return e.Status }

func E(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func NotFound(what string) *Error { return E(http.StatusNotFound, "NOT_FOUND", what+" not found") }
func MissingPermission() *Error {
	return E(http.StatusForbidden, "MISSING_PERMISSION", "you do not have permission to do that")
}
func Unauthorized() *Error { return E(http.StatusUnauthorized, "UNAUTHORIZED", "sign in required") }
func RateLimited() *Error {
	return E(http.StatusTooManyRequests, "RATE_LIMITED", "too many requests, slow down")
}
func BadRequest(code, message string) *Error {
	return E(http.StatusBadRequest, code, message)
}

// ParseID parses an ID path parameter. A malformed ID names nothing, so it is a 404.
func ParseID(s, what string) (id.ID, error) {
	v, err := id.Parse(s)
	if err != nil {
		return 0, NotFound(what)
	}
	return v, nil
}

// Authed marks an operation as requiring a signed-in user. The auth
// middleware enforces it.
var Authed = []map[string][]string{{"session": {}}}

func codeFor(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "VALIDATION_FAILED"
	case http.StatusUnauthorized:
		return "UNAUTHORIZED"
	case http.StatusForbidden:
		return "MISSING_PERMISSION"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusConflict:
		return "CONFLICT"
	case http.StatusRequestEntityTooLarge:
		return "TOO_LARGE"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	default:
		return "INTERNAL"
	}
}

func newError(status int, msg string, errs ...error) huma.StatusError {
	if status == http.StatusUnprocessableEntity {
		status = http.StatusBadRequest // spec section 9 uses 400 for validation failures
	}
	if status >= 500 {
		return &Error{Status: status, Code: "INTERNAL", Message: "internal error"}
	}
	e := &Error{Status: status, Code: codeFor(status), Message: msg}
	if len(errs) > 0 {
		list := make([]string, 0, len(errs))
		for _, err := range errs {
			list = append(list, err.Error())
		}
		e.Details = map[string]any{"errors": list}
	}
	return e
}

func init() {
	huma.NewError = newError
	huma.NewErrorWithContext = func(ctx huma.Context, status int, msg string, errs ...error) huma.StatusError {
		if status < 500 {
			return newError(status, msg, errs...)
		}
		rid := RequestIDFrom(ctx.Context())
		slog.ErrorContext(ctx.Context(), "request failed", "request_id", rid, "status", status, "msg", msg, "errors", errs)
		return &Error{Status: status, Code: "INTERNAL", Message: "internal error", Details: map[string]any{"request_id": rid}}
	}
}

// WriteError writes e from inside a Huma middleware.
func WriteError(api huma.API, ctx huma.Context, e *Error) {
	ctx.SetHeader("Content-Type", "application/json")
	ctx.SetStatus(e.Status)
	_ = api.Marshal(ctx.BodyWriter(), "application/json", e)
}

// WriteJSON writes v as the JSON body of a plain net/http handler's response.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteHTTPError writes err from a plain net/http handler. An *Error is
// written as-is; anything else is logged and becomes a 500 that shows only
// the request ID.
func WriteHTTPError(w http.ResponseWriter, r *http.Request, err error) {
	var e *Error
	if !errors.As(err, &e) {
		rid := RequestIDFrom(r.Context())
		slog.ErrorContext(r.Context(), "request failed", "request_id", rid, "err", err)
		e = &Error{Status: http.StatusInternalServerError, Code: "INTERNAL", Message: "internal error",
			Details: map[string]any{"request_id": rid}}
	}
	WriteJSON(w, e.Status, e)
}
