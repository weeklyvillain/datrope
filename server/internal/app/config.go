package app

import (
	"errors"
	"os"
	"strings"

	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/integrations"
	"github.com/datrope/datrope/server/internal/music"
	"github.com/datrope/datrope/server/internal/voice"
)

type Config struct {
	DatabaseURL string
	Addr        string
	// PublicURL is the origin browsers load the web app from, e.g.
	// https://chat.example.com. Cookie-authenticated WebSockets must come from it.
	PublicURL  string
	TrustProxy bool            // read the client IP from X-Forwarded-For (set behind Caddy)
	Gateway    gateway.Options // zero value = production defaults
	DataDir    string          // uploads live in DataDir/files
	LiveKit    voice.Config    // voice is off when LiveKit.URL is empty
	KlipyURL   string          // Klipy's API base; "" is the real one (tests point it at a fake)
	// Integrations are Twitch's, YouTube's and Spotify's base URLs; zero values are the real ones.
	Integrations integrations.Endpoints
	Music        music.Config // ffmpeg and yt-dlp; empty paths are looked up on PATH
}

func ConfigFromEnv() (Config, error) {
	c := Config{
		DatabaseURL: os.Getenv("DATROPE_DATABASE_URL"),
		Addr:        os.Getenv("DATROPE_ADDR"),
		PublicURL:   strings.TrimSuffix(os.Getenv("DATROPE_PUBLIC_URL"), "/"),
		TrustProxy:  os.Getenv("DATROPE_TRUST_PROXY") == "true",
		DataDir:     os.Getenv("DATROPE_DATA_DIR"),
		LiveKit: voice.Config{
			URL:       os.Getenv("DATROPE_LIVEKIT_URL"),
			PublicURL: strings.TrimSuffix(os.Getenv("DATROPE_LIVEKIT_PUBLIC_URL"), "/"),
			APIKey:    os.Getenv("DATROPE_LIVEKIT_API_KEY"),
			APISecret: os.Getenv("DATROPE_LIVEKIT_API_SECRET"),
		},
		Music: music.Config{FFmpeg: os.Getenv("DATROPE_FFMPEG"), YtDlp: os.Getenv("DATROPE_YTDLP")},
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	if c.DataDir == "" {
		c.DataDir = "/data"
	}
	if c.DatabaseURL == "" {
		return c, errors.New("DATROPE_DATABASE_URL is required")
	}
	if c.PublicURL == "" {
		return c, errors.New("DATROPE_PUBLIC_URL is required")
	}
	if c.LiveKit.Enabled() {
		if c.LiveKit.APIKey == "" || len(c.LiveKit.APISecret) < 32 {
			return c, errors.New("DATROPE_LIVEKIT_URL needs DATROPE_LIVEKIT_API_KEY and a DATROPE_LIVEKIT_API_SECRET of at least 32 characters")
		}
		if c.LiveKit.PublicURL == "" { // https://host -> wss://host/livekit (Caddy proxies it)
			c.LiveKit.PublicURL = "ws" + strings.TrimPrefix(c.PublicURL, "http") + "/livekit"
		}
	}
	return c, nil
}
