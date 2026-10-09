package httpx

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

type ctxKey int

const (
	ridKey ctxKey = iota
	ipKey
)

// Chain wraps h in middleware; the first one listed is the outermost.
func Chain(h http.Handler, mws ...func(http.Handler) http.Handler) http.Handler {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}

func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 8)
		_, _ = rand.Read(b)
		rid := hex.EncodeToString(b)
		w.Header().Set("X-Request-ID", rid)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ridKey, rid)))
	})
}

func RequestIDFrom(ctx context.Context) string {
	s, _ := ctx.Value(ridKey).(string)
	return s
}

// ClientIP records the caller's IP. Behind our reverse proxy (trustProxy),
// the last X-Forwarded-For entry is the address the proxy saw.
func ClientIP(trustProxy bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				ip = r.RemoteAddr
			}
			if xff := r.Header.Get("X-Forwarded-For"); trustProxy && xff != "" {
				parts := strings.Split(xff, ",")
				ip = strings.TrimSpace(parts[len(parts)-1])
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ipKey, ip)))
		})
	}
}

func ClientIPFrom(ctx context.Context) string {
	s, _ := ctx.Value(ipKey).(string)
	return s
}

func Logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.InfoContext(r.Context(), "http", "method", r.Method, "path", r.URL.Path, "status", sw.status,
			"duration_ms", time.Since(start).Milliseconds(), "request_id", RequestIDFrom(r.Context()))
	})
}

func Recover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			rid := RequestIDFrom(r.Context())
			slog.ErrorContext(r.Context(), "panic", "request_id", rid, "panic", v, "stack", string(debug.Stack()))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_ = json.NewEncoder(w).Encode(&Error{Code: "INTERNAL", Message: "internal error",
				Details: map[string]any{"request_id": rid}})
		}()
		next.ServeHTTP(w, r)
	})
}

// statusWriter records the status code. It passes Hijack and Flush
// through so WebSocket upgrades keep working.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(s int) {
	if !w.wrote {
		w.status, w.wrote = s, true
	}
	w.ResponseWriter.WriteHeader(s)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	w.wrote = true
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.status = http.StatusSwitchingProtocols
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (w *statusWriter) Flush() { _ = http.NewResponseController(w.ResponseWriter).Flush() }
