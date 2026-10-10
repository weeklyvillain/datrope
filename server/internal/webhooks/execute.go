package webhooks

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

// Discord's JSON error codes, which Discord webhook clients understand.
const (
	codeUnknownWebhook = 10015
	codeTooLarge       = 40005
	codeEmptyMessage   = 50006
	codeInvalidToken   = 50027
	codeInvalidBody    = 50035
	codeInvalidJSON    = 50109
)

const (
	maxBody    = 1 << 20 // far above what the limits allow
	retryAfter = 2       // seconds: one request's worth of the 30-a-minute budget
)

// discordError is the error body Discord's API sends.
type discordError struct {
	Code       int     `json:"code"`
	Message    string  `json:"message"`
	RetryAfter float64 `json:"retry_after,omitempty"`
}

// executeBody is what Discord's execute-webhook call takes, as far as
// Datrope uses it. Other fields (tts, allowed_mentions, components, ...)
// are ignored.
type executeBody struct {
	Content   string                  `json:"content"`
	Username  string                  `json:"username"`
	AvatarURL string                  `json:"avatar_url"`
	Embeds    []messages.WebhookEmbed `json:"embeds"`
}

func writeDiscordError(w http.ResponseWriter, status, code int, message string) {
	httpx.WriteJSON(w, status, discordError{Code: code, Message: message})
}

// ExecuteHandler serves POST /api/webhooks/{id}/{token}, Discord's
// execute-webhook call. There is no session: the token in the URL is the
// credential. It answers 204, or 200 with the message for ?wait=true.
// It is a plain handler, not a Huma operation, because Huma would reject
// Discord's many extra fields and answer with Datrope's error shape.
func (s *Service) ExecuteHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		unknown := func() { writeDiscordError(w, http.StatusNotFound, codeUnknownWebhook, "Unknown Webhook") }
		internal := func(err error) {
			slog.ErrorContext(ctx, "webhook execute", "request_id", httpx.RequestIDFrom(ctx), "err", err)
			writeDiscordError(w, http.StatusInternalServerError, 0, "Internal Server Error")
		}
		wid, err := id.Parse(r.PathValue("id"))
		if err != nil {
			unknown()
			return
		}
		var channelID id.ID
		var hash []byte
		err = s.db.QueryRow(ctx, `SELECT channel_id, token_hash FROM webhooks WHERE id = $1`, wid).Scan(&channelID, &hash)
		if errors.Is(err, pgx.ErrNoRows) {
			unknown()
			return
		}
		if err != nil {
			internal(err)
			return
		}
		// Hash the given token and compare hashes in constant time, as sessions do.
		if subtle.ConstantTimeCompare(auth.HashToken(r.PathValue("token")), hash) != 1 {
			writeDiscordError(w, http.StatusUnauthorized, codeInvalidToken, "Invalid Webhook Token")
			return
		}
		// After the token check, so strangers cannot use up a webhook's budget.
		if !s.limit.Allow(wid.String()) {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			httpx.WriteJSON(w, http.StatusTooManyRequests, discordError{Message: "You are being rate limited.", RetryAfter: retryAfter})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBody)
		var body executeBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				writeDiscordError(w, http.StatusRequestEntityTooLarge, codeTooLarge, "Request entity too large")
				return
			}
			writeDiscordError(w, http.StatusBadRequest, codeInvalidJSON, "The request body contains invalid JSON.")
			return
		}
		body.Content, body.Username = strings.TrimSpace(body.Content), strings.TrimSpace(body.Username)
		if problem := validate(&body); problem != "" {
			writeDiscordError(w, http.StatusBadRequest, codeInvalidBody, "Invalid Form Body: "+problem)
			return
		}
		post := messages.WebhookPost{WebhookID: wid, ChannelID: channelID, Username: body.Username,
			Content: body.Content, AvatarURL: body.AvatarURL, Embeds: body.Embeds}
		if post.Content == "" && len(post.Embeds) == 0 {
			writeDiscordError(w, http.StatusBadRequest, codeEmptyMessage, "Cannot send an empty message")
			return
		}
		post.Images = s.images.fetchAll(ctx, post.ImageURLs()) // failures are dropped; the message still posts
		m, err := s.messages.PostWebhook(ctx, post)
		if errors.Is(err, messages.ErrWebhookGone) {
			unknown()
			return
		}
		if errors.Is(err, messages.ErrEmptyWebhookMessage) { // every embed emptied by dropped images
			writeDiscordError(w, http.StatusBadRequest, codeEmptyMessage, "Cannot send an empty message")
			return
		}
		if err != nil {
			internal(err)
			return
		}
		if r.URL.Query().Get("wait") == "true" {
			httpx.WriteJSON(w, http.StatusOK, m)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
