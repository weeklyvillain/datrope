// Package app wires the packages into one HTTP handler.
package app

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humago"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/albums"
	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/expressions"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/gifs"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/integrations"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/music"
	"github.com/datrope/datrope/server/internal/push"
	"github.com/datrope/datrope/server/internal/system"
	"github.com/datrope/datrope/server/internal/voice"
	"github.com/datrope/datrope/server/internal/webhooks"
)

type App struct {
	Handler  http.Handler
	API      huma.API
	Bus      *events.Bus
	Files    *files.Service // nil when built without a database
	Voice    *voice.Service // nil when built without a database
	Messages *messages.Service
	Webhooks *webhooks.Service // nil when built without a database
	// Communities runs the guest sweep; tests call SweepGuests directly.
	Communities *communities.Service
	// Integrations polls Twitch, YouTube and Spotify; tests call Poll directly.
	Integrations *integrations.Service
	Music        *music.Service   // nil when built without a database
	Gateway      *gateway.Gateway // nil when built without a database
	Audit        *audit.Service   // nil when built without a database
	Push         *push.Service    // nil when built without a database
	closers      []func()
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
	a.Communities = commSvc

	chanSvc := channels.NewService(pool, a.Bus, commSvc, authSvc)
	commSvc.SetChannelSeeder(chanSvc)
	if pool != nil { // nil only for `datrope openapi`
		// An instance upgraded with users but no communities gets its server now.
		if err := commSvc.EnsureServer(context.Background()); err != nil {
			panic(fmt.Errorf("server: %w", err))
		}
		commSvc.StartGuestSweep()
		a.closers = append(a.closers, commSvc.Close)
	}
	channels.Register(api, chanSvc)

	var filesSvc *files.Service
	if pool != nil { // nil only for `datrope openapi`
		store, err := files.NewLocalStore(filepath.Join(cfg.DataDir, "files"))
		if err != nil {
			panic(fmt.Errorf("files: cannot use %s: %w", cfg.DataDir, err)) // startup misconfiguration
		}
		filesSvc = files.NewService(pool, store, chanSvc, authSvc)
		if err := filesSvc.SetVariants(filepath.Join(cfg.DataDir, "variants"), cfg.ImgproxyURL); err != nil {
			panic(fmt.Errorf("files: cannot use %s: %w", cfg.DataDir, err)) // startup misconfiguration
		}
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
		filesSvc.AddBlobTable("webhooks", "avatar_sha256")
		filesSvc.AddBlobTable("message_images", "sha256")
		filesSvc.AddBlobTable("roles", "icon_sha256")
		filesSvc.AddBlobTable("music_tracks", "sha256")
		filesSvc.AddBlobTable("music_tracks", "cover")
		filesSvc.AddBlobTable("music_playlist_items", "cover")
		commSvc.SetIconBlobs(filesSvc)
		mux.Handle("PUT /api/server/roles/{roleID}/icon", authSvc.RequireHTTP(commSvc.RoleIconUploadHandler()))
		mux.Handle("DELETE /api/server/roles/{roleID}/icon", authSvc.RequireHTTP(commSvc.RoleIconDeleteHandler()))
		mux.Handle("GET /api/role-icons/{roleID}", commSvc.RoleIconHandler())
		authSvc.SetBlobs(filesSvc)
		filesSvc.AddBlobTable("users", "avatar_sha256")
		mux.Handle("PUT /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarUploadHandler()))
		mux.Handle("DELETE /api/users/@me/avatar", authSvc.RequireHTTP(authSvc.AvatarDeleteHandler()))
		mux.Handle("GET /api/avatars/{userID}", authSvc.AvatarHandler())
		filesSvc.AddBlobTable("users", "banner_sha256")
		mux.Handle("PUT /api/users/@me/banner", authSvc.RequireHTTP(authSvc.BannerUploadHandler()))
		mux.Handle("DELETE /api/users/@me/banner", authSvc.RequireHTTP(authSvc.BannerDeleteHandler()))
		mux.Handle("GET /api/banners/{userID}", authSvc.BannerHandler())
		filesSvc.Start()
		a.closers = append(a.closers, filesSvc.Close)
		a.Files = filesSvc
	}

	// filesSvc is nil for `datrope openapi`; the GIF handlers never run then.
	gifs.Register(api, gifs.NewService(authSvc, filesSvc, cfg.KlipyURL))
	// filesSvc is nil when built without a database; messages never calls it then.
	msgSvc := messages.NewService(pool, a.Bus, chanSvc, authSvc, filesSvc, commSvc)
	messages.Register(api, msgSvc)
	if pool != nil { // nil only for `datrope openapi`
		msgSvc.SetPreviews(linkpreview.New(pool))
		msgSvc.SetBlobs(filesSvc)
		mux.Handle("GET /api/messages/{messageID}/images/{sha256}", authSvc.RequireHTTP(msgSvc.ImageHandler()))
	}
	a.Messages = msgSvc
	a.closers = append(a.closers, msgSvc.Wait)

	// filesSvc is nil when built without a database; webhooks never calls it then.
	hookSvc := webhooks.NewService(pool, chanSvc, msgSvc, filesSvc, cfg.PublicURL)
	webhooks.Register(api, hookSvc)
	if pool != nil { // nil only for `datrope openapi`
		// Like the LiveKit webhook, there is no session: the token in the URL is the credential.
		mux.Handle("POST /api/webhooks/{id}/{token}", hookSvc.ExecuteHandler())
		mux.Handle("PUT /api/webhooks/{id}/avatar", authSvc.RequireHTTP(hookSvc.AvatarUploadHandler()))
		mux.Handle("DELETE /api/webhooks/{id}/avatar", authSvc.RequireHTTP(hookSvc.AvatarDeleteHandler()))
		mux.Handle("GET /api/webhooks/{id}/avatar", authSvc.RequireHTTP(hookSvc.AvatarHandler()))
		a.Webhooks = hookSvc
	}

	exprSvc := expressions.NewService(pool, a.Bus, commSvc, filesSvc, msgSvc, cfg.SevenTVURL)
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
		voiceSvc.SetAudit(pool)
		voiceSvc.Start()
		a.closers = append(a.closers, voiceSvc.Close)
		a.Voice = voiceSvc
	}

	intSvc := integrations.NewService(pool, a.Bus, chanSvc, msgSvc, cfg.PublicURL, cfg.Integrations)
	integrations.Register(api, intSvc)
	if pool != nil { // nil only for `datrope openapi`
		mux.Handle("GET /api/connections/{provider}/callback", intSvc.CallbackHandler())
		intSvc.Start()
		a.closers = append(a.closers, intSvc.Close)
		a.Integrations = intSvc
	}

	ytPath, ytPinned := system.YtDlpBinary(cfg.Music.YtDlp, cfg.DataDir)
	ytDlp := music.NewYtDlpPath(ytPath)
	cfg.Music.YtDlpPath = ytDlp
	musicSvc := music.NewService(pool, a.Bus, chanSvc, voiceSvc, cfg.LiveKit, cfg.Music)
	musicSvc.SetCommunity(commSvc)
	musicSvc.SetSpotify(intSvc)
	music.Register(api, musicSvc)
	if pool != nil { // nil only for `datrope openapi`
		musicSvc.SetBlobs(filesSvc)
		mux.Handle("POST /api/server/music", authSvc.RequireHTTP(musicSvc.UploadHandler()))
		mux.Handle("GET /api/music/covers/{sum}", musicSvc.CoverHandler())
		mux.Handle("GET /api/music/tracks/{trackID}/audio", authSvc.RequireHTTP(musicSvc.AudioHandler()))
		a.closers = append(a.closers, musicSvc.Close)
		a.Music = musicSvc
	}

	auditSvc := audit.NewService(pool, commSvc, authSvc)
	audit.Register(api, auditSvc)
	if pool != nil { // nil only for `datrope openapi`
		auditSvc.Start()
		a.closers = append(a.closers, auditSvc.Close)
		a.Audit = auditSvc
	}

	albumSvc := albums.NewService(pool, a.Bus, chanSvc, commSvc, filesSvc, msgSvc)
	albums.Register(api, albumSvc)
	if filesSvc != nil {
		filesSvc.SetAlbums(albumSvc)
	}

	pushSvc := push.NewService(pool, a.Bus, push.Deps{
		Audience: audience{communities: commSvc, channels: chanSvc}, Channels: chanSvc,
		Server: commSvc, PublicURL: cfg.PublicURL,
	}, cfg.Push)
	push.Register(api, pushSvc)
	if pool != nil { // nil only for `datrope openapi`
		pushSvc.Start()
		a.closers = append(a.closers, pushSvc.Close)
		a.Push = pushSvc
		mux.Handle("GET /manifest.webmanifest", pushSvc.ManifestHandler())
	}

	registerEventSchemas(api)
	var gw *gateway.Gateway
	if pool != nil { // nil only for `datrope openapi`
		gw = gateway.New(gateway.Deps{
			Auth:         authSvc,
			Audience:     audience{communities: commSvc, channels: chanSvc},
			Ready:        readyBuilder{communities: commSvc, channels: chanSvc, messages: msgSvc, voice: voiceSvc, expressions: exprSvc, integrations: intSvc},
			Bus:          a.Bus,
			PublicOrigin: cfg.PublicURL,
		}, cfg.Gateway)
		mux.Handle("GET /ws", gw)
		commSvc.SetPresence(gw)
		pushSvc.SetPresence(gw)
		a.Gateway = gw
		a.closers = append(a.closers, gw.Close)
	}

	sysDeps := system.Deps{
		Sources: system.Sources{DataDir: cfg.DataDir, InVoice: voiceSvc.Participants},
		YtDlp: system.YtDlpOptions{
			Path: ytDlp, Managed: system.ManagedYtDlp(cfg.DataDir), Pinned: ytPinned, API: cfg.GitHubAPI,
		},
		UpdaterURL: cfg.UpdaterURL, UpdaterToken: cfg.UpdaterToken,
	}
	if runtime.GOOS == "linux" {
		sysDeps.Sources.Proc = os.DirFS("/proc")
	}
	if pool != nil { // nil only for `datrope openapi`
		sysDeps.Sources.Connections = gw.Connections
		sysDeps.Sources.DatabaseSize = func(ctx context.Context) (n int64, err error) {
			err = pool.QueryRow(ctx, "SELECT pg_database_size(current_database())").Scan(&n)
			return n, err
		}
	}
	sysSvc := system.NewService(sysDeps)
	system.Register(api, sysSvc)
	if pool != nil {
		sysSvc.Start()
		a.closers = append(a.closers, sysSvc.Close)
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
