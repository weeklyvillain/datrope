// Package app wires the packages into one HTTP handler.
package app

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/voice"
)

type App struct {
	Handler  http.Handler
	API      huma.API
	Bus      *events.Bus
	Files    *files.Service // nil when built without a database
	Voice    *voice.Service // nil when built without a database
	Messages *messages.Service
	closers  []func()
}

// Close stops background work (the gateway).
func (a *App) Close() {
	for _, c := range a.closers {
		c()
	}
}

// New builds the app. pool may be nil when only the OpenAPI document is
// needed (datrope openapi).
func New(pool *pgxpool.Pool, cfg Config) *App {
	mux := http.NewServeMux()
	api := humago.New(mux, apiConfig())
	a := &App{API: api, Bus: &events.Bus{}}

	authSvc := auth.NewService(pool, a.Bus)
	api.UseMiddleware(authSvc.Middleware(api)) // must come before any huma.Register
	auth.Register(api, authSvc)

	commSvc := communities.NewService(pool, a.Bus, authSvc)
	authSvc.SetJoiner(commSvc)
	communities.Register(api, commSvc)

	chanSvc := channels.NewService(pool, a.Bus, commSvc, authSvc)
	commSvc.SetChannelSeeder(chanSvc)
	if pool != nil { // nil only for `datrope openapi`
		// An instance upgraded with users but no communities gets its server now.
		if err := commSvc.EnsureServer(context.Background()); err != nil {
			panic(fmt.Errorf("server: %w", err))
		}
	}
	channels.Register(api, chanSvc)

	var filesSvc *files.Service
	if pool != nil { // nil only for `datrope openapi`
		store, err := files.NewLocalStore(filepath.Join(cfg.DataDir, "files"))
		if err != nil {
			panic(fmt.Errorf("files: cannot use %s: %w", cfg.DataDir, err)) // startup misconfiguration
		}
		filesSvc = files.NewService(pool, store, chanSvc, authSvc)
		mux.Handle("POST /api/attachments", authSvc.RequireHTTP(filesSvc.UploadHandler()))
		mux.Handle("GET /api/attachments/{id}", authSvc.RequireHTTP(filesSvc.DownloadHandler(false)))
		mux.Handle("GET /api/attachments/{id}/thumbnail", authSvc.RequireHTTP(filesSvc.DownloadHandler(true)))
		filesSvc.SetServer(commSvc)
		commSvc.SetImages(filesSvc)
		for _, kind := range []string{"icon", "banner"} {
			mux.Handle("PUT /api/server/"+kind, authSvc.RequireHTTP(filesSvc.ServerImageUpload(kind)))
			mux.Handle("DELETE /api/server/"+kind, authSvc.RequireHTTP(filesSvc.ServerImageDelete(kind)))
			mux.Handle("GET /api/server/"+kind, filesSvc.ServerImageDownload())
		}
		mux.Handle("POST /api/server/images", authSvc.RequireHTTP(filesSvc.ServerImageUpload("page")))
		mux.Handle("GET /api/server/images/{id}", filesSvc.ServerImageDownload())
		filesSvc.AddBlobTable("emoji", "sha256") // before Start: the first sweep must know every blob table
		filesSvc.AddBlobTable("sounds", "sha256")
		authSvc.SetBlobs(filesSvc)
		filesSvc.AddBlobTable("users", "avatar_sha256")
		mux.Handle("PUT /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarUploadHandler()))
		mux.Handle("DELETE /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarDeleteHandler()))
		mux.Handle("GET /api/avatars/{userID}", authSvc.AvatarHandler())
		filesSvc.Start()
		a.closers = append(a.closers, filesSvc.Close)
		a.Files = filesSvc
	}

	// filesSvc is nil when built without a database; messages never calls it then.
	msgSvc := messages.NewService(pool, a.Bus, chanSvc, authSvc, filesSvc, commSvc)
	messages.Register(api, msgSvc)
	if pool != nil { // nil only for `datrope openapi`
		msgSvc.SetPreviews(linkpreview.New(pool))
	}
	a.Messages = msgSvc
	a.closers = append(a.closers, msgSvc.Wait)

	exprSvc := expressions.NewService(pool, a.Bus, commSvc, filesSvc, msgSvc)
	msgSvc.SetCustomEmoji(exprSvc)
	msgSvc.SetThreads(chanSvc)
	expressions.Register(api, exprSvc)
	if pool != nil { // nil only for `datrope openapi`
		mux.Handle("POST /api/server/emoji", authSvc.RequireHTTP(exprSvc.UploadHandler()))
		mux.Handle("GET /api/emoji/{id}", exprSvc.ImageHandler())
		mux.Handle("POST /api/server/sounds", authSvc.RequireHTTP(exprSvc.UploadSoundHandler()))
		mux.Handle("GET /api/sounds/{id}", exprSvc.SoundFileHandler())
	}

	voiceSvc := voice.NewService(cfg.LiveKit, a.Bus, chanSvc, commSvc)
	voiceSvc.SetSounds(exprSvc)
	voice.Register(api, voiceSvc)
	if pool != nil { // nil only for `datrope openapi`
		if cfg.LiveKit.Enabled() {
			// LiveKit signs its webhooks; there is no session to check.
			mux.Handle("POST /api/voice/webhook", voiceSvc.WebhookHandler())
		}
		voiceSvc.Start()
		a.closers = append(a.closers, voiceSvc.Close)
		a.Voice = voiceSvc
	}

	registerEventSchemas(api)
	if pool != nil { // nil only for `datrope openapi`
		gw := gateway.New(gateway.Deps{
			Auth:         authSvc,
			Audience:     audience{communities: commSvc, channels: chanSvc},
			Ready:        readyBuilder{communities: commSvc, channels: chanSvc, messages: msgSvc, voice: voiceSvc, expressions: exprSvc},
			Bus:          a.Bus,
			PublicOrigin: cfg.PublicURL,
		}, cfg.Gateway)
		mux.Handle("GET /ws", gw)
		a.closers = append(a.closers, gw.Close)
	}

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})

	a.Handler = httpx.Chain(mux, httpx.RequestID, httpx.ClientIP(cfg.TrustProxy), httpx.Logger, httpx.Recover)
	return a
}

func apiConfig() huma.Config {
	c := huma.DefaultConfig("Datrope API", "0.1.0")
	c.OpenAPIPath = "/api/openapi" // serves /api/openapi.json and /api/openapi.yaml
	c.DocsPath = ""
	c.SchemasPath = ""
	c.CreateHooks = nil // no schema links in response bodies
	c.Components.SecuritySchemes = map[string]*huma.SecurityScheme{
		"session": {
			Type: "http", Scheme: "bearer",
			Description: "Session token. Web clients send the datrope_session cookie (plus X-Datrope-CSRF: 1 on writes) instead.",
		},
	}
	return c
}
