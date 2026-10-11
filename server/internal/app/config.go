package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
	PublicURL   string
	TrustProxy  bool            // read the client IP from X-Forwarded-For (set behind Caddy)
	Gateway     gateway.Options // zero value = production defaults
	DataDir     string          // uploads live in DataDir/files
	LiveKit     voice.Config    // voice is off when LiveKit.URL is empty
	KlipyURL    string          // Klipy's API base; "" is the real one (tests point it at a fake)
	SevenTVURL  string          // 7TV's API base; "" is the real one (tests point it at a fake)
	ImgproxyURL string          // imgproxy's base URL for resized images; "" serves originals only
	// Integrations are Twitch's, YouTube's and Spotify's base URLs; zero values are the real ones.
	Integrations integrations.Endpoints
	Music        music.Config // ffmpeg and yt-dlp; empty paths are looked up on PATH
	// UpdaterURL and UpdaterToken reach the updater container (Server settings -> Updates).
	// Without a token the dashboard cannot update or restart the server.
	UpdaterURL   string
	UpdaterToken string
	GitHubAPI    string // GitHub's API base for yt-dlp releases; "" is the real one (tests point it at a fake)
}

// musicFromEnv reads the music bot's sources, cache and library size:
// DATROPE_MUSIC_SOURCES (comma-separated yt-dlp extractors), DATROPE_MUSIC_CACHE_MB
// (0 turns the cache off) and DATROPE_MUSIC_LIBRARY_MB.
func (c *Config) musicFromEnv() error {
	if v := os.Getenv("DATROPE_MUSIC_SOURCES"); v != "" {
		c.Music.Sources = strings.Split(v, ",")
	}
	mb := func(name string, def int64) (int64, error) {
		v := os.Getenv(name)
		if v == "" {
			return def, nil
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			return 0, fmt.Errorf("%s must be a number of megabytes", name)
		}
		return n << 20, nil
	}
	cache, err := mb("DATROPE_MUSIC_CACHE_MB", music.DefaultCacheBytes)
	if err != nil {
		return err
	}
	if cache > 0 {
		c.Music.CacheDir, c.Music.CacheBytes = filepath.Join(c.DataDir, "music-cache"), cache
	}
	c.Music.LibraryBytes, err = mb("DATROPE_MUSIC_LIBRARY_MB", music.DefaultLibraryBytes)
	return err
}

func ConfigFromEnv() (Config, error) {
	c := Config{
		DatabaseURL: os.Getenv("DATROPE_DATABASE_URL"),
		Addr:        os.Getenv("DATROPE_ADDR"),
		PublicURL:   strings.TrimSuffix(os.Getenv("DATROPE_PUBLIC_URL"), "/"),
		TrustProxy:  os.Getenv("DATROPE_TRUST_PROXY") == "true",
		DataDir:     os.Getenv("DATROPE_DATA_DIR"),
		ImgproxyURL: strings.TrimSuffix(os.Getenv("DATROPE_IMGPROXY_URL"), "/"),
		LiveKit: voice.Config{
			URL:       os.Getenv("DATROPE_LIVEKIT_URL"),
			PublicURL: strings.TrimSuffix(os.Getenv("DATROPE_LIVEKIT_PUBLIC_URL"), "/"),
			APIKey:    os.Getenv("DATROPE_LIVEKIT_API_KEY"),
			APISecret: os.Getenv("DATROPE_LIVEKIT_API_SECRET"),
		},
		UpdaterURL:   strings.TrimSuffix(os.Getenv("DATROPE_UPDATER_URL"), "/"),
		UpdaterToken: os.Getenv("DATROPE_UPDATER_TOKEN"),
		Music:        music.Config{FFmpeg: os.Getenv("DATROPE_FFMPEG"), YtDlp: os.Getenv("DATROPE_YTDLP")},
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	if c.DataDir == "" {
		c.DataDir = "/data"
	}
	if c.UpdaterToken != "" && c.UpdaterURL == "" {
		c.UpdaterURL = "http://updater:8090"
	}
	if err := c.musicFromEnv(); err != nil {
		return c, err
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
