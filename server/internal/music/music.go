// Package music runs a music bot per voice channel: a LiveKit participant
// that plays a queue of YouTube links, searches and uploaded tracks, which
// the people in the channel control together.
package music

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

// Config says where the tools are. Empty paths are looked up on PATH; music
// is off without ffmpeg, and links and searches are off without yt-dlp.
type Config struct {
	FFmpeg string
	YtDlp  string
	// YtDlpPath, when set, is the yt-dlp to use (it may change at run time); YtDlp is then ignored.
	YtDlpPath *YtDlpPath
	// Sources are the yt-dlp extractors links may use; empty means DefaultSources.
	Sources []string
	// CacheDir keeps played links as Ogg Opus so they replay without yt-dlp;
	// "" turns the cache off. CacheBytes caps it (0: DefaultCacheBytes).
	CacheDir   string
	CacheBytes int64
	// LibraryBytes caps the uploaded tracks' total size (0: DefaultLibraryBytes).
	LibraryBytes int64
}

const (
	DefaultCacheBytes   = 2 << 30
	DefaultLibraryBytes = 2 << 30
)

// Spotify looks up Spotify links: a track, an album or a playlist. Spotify has
// no audio for us, so each track is played by searching YouTube for it.
type Spotify interface {
	SpotifyTracks(ctx context.Context, link string) (title string, tracks []SpotifyTrack, err error)
}

// SpotifyTrack is one track a Spotify link lists.
type SpotifyTrack struct {
	Title    string
	Artist   string
	Duration int    // seconds
	Cover    string // album art URL
}

// ErrSpotifyOff: the server has no Spotify app credentials.
var ErrSpotifyOff = errors.New("music: spotify is not set up")

// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

// Voice is what this package needs from voice: who is in which channel.
type Voice interface {
	States(channelIDs []id.ID) []voice.VoiceState
}

// Blobs stores and opens uploaded tracks and cover images.
type Blobs interface {
	StoreBlob(ctx context.Context, tx pgx.Tx, data []byte) (string, error)
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	OpenBlob(sum string) (io.ReadSeekCloser, error)
	ServeBlob(w http.ResponseWriter, r *http.Request, sum, contentType string, immutable bool)
	RemoveBlobs(ctx context.Context, sums []string) error
}

// Track is one entry of a queue.
type MusicTrack struct {
	ID          id.ID  `json:"id"`
	Title       string `json:"title"`
	Artist      string `json:"artist,omitempty"`
	URL         string `json:"url,omitempty" doc:"The page it came from; absent for uploads and for Spotify tracks not yet found"`
	Duration    int    `json:"duration" doc:"Seconds; 0 when unknown"`
	Source      string `json:"source" enum:"link,upload"`
	Site        string `json:"site,omitempty" doc:"A link's site: youtube, soundcloud, bandcamp, vimeo or spotify"`
	Cover       string `json:"cover,omitempty" doc:"The cover image's path, when there is one"`
	RequestedBy id.ID  `json:"requested_by"`

	blob      string // uploads: the stored file
	opus      bool   // the blob is Ogg Opus already
	libraryID id.ID  // uploads: the library track
	search    string // played by searching YouTube for this when it comes up (Spotify)
	thumb     string // a link's thumbnail on its site, for saving it to a playlist
	coverSum  string
	live      bool
}

// State is a channel's music: what plays, whether it is paused, what comes next.
type MusicState struct {
	ChannelID id.ID        `json:"channel_id"`
	Current   *MusicTrack  `json:"current,omitempty"`
	Paused    bool         `json:"paused"`
	Loading   bool         `json:"loading" doc:"The current track is being fetched and has not started playing yet"`
	Position  float64      `json:"position" doc:"Seconds into the current track when the state was sent"`
	Queue     []MusicTrack `json:"queue"`
	Repeat    string       `json:"repeat" enum:"off,all,one" doc:"off; all: finished tracks go back to the end of the queue; one: the current track replays"`
	BotID     string       `json:"bot_id,omitempty" doc:"The bot's LiveKit identity while it is in the channel (for per-person volume)"`
	Enabled   bool         `json:"enabled" doc:"The server can play music (voice and ffmpeg are set up)"`
	YouTube   bool         `json:"youtube" doc:"Links and searches work (yt-dlp is installed)"`
}

type Service struct {
	db        *pgxpool.Pool
	bus       *events.Bus
	channels  Channels
	voice     Voice
	blobs     Blobs
	community Community
	lk        voice.Config
	ffmpeg    string
	resolver  Resolver // nil: no links or searches
	spotify   Spotify  // nil: no Spotify links
	cache     *cache   // nil: off
	library   int64    // the library's size limit, in bytes

	mu      sync.Mutex
	players map[id.ID]*player
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, v Voice, lk voice.Config, cfg Config) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{db: pool, bus: bus, channels: ch, voice: v, lk: lk, players: map[id.ID]*player{}, ctx: ctx, cancel: cancel}
	s.ffmpeg = lookPath(cfg.FFmpeg, "ffmpeg")
	switch {
	case cfg.YtDlpPath != nil:
		if cfg.YtDlpPath.Get() != "" {
			s.resolver = ytDlp{path: cfg.YtDlpPath, sources: cfg.Sources}
		}
	default:
		if yt := lookPath(cfg.YtDlp, "yt-dlp"); yt != "" {
			s.resolver = ytDlp{path: NewYtDlpPath(yt), sources: cfg.Sources}
		}
	}
	if cfg.CacheDir != "" {
		max := cfg.CacheBytes
		if max <= 0 {
			max = DefaultCacheBytes
		}
		c, err := newCache(cfg.CacheDir, max)
		if err != nil {
			slog.Warn("music: cache off", "err", err)
		} else {
			s.cache = c
		}
	}
	s.library = cfg.LibraryBytes
	if s.library <= 0 {
		s.library = DefaultLibraryBytes
	}
	return s
}

// SetSpotify turns on Spotify links.
func (s *Service) SetSpotify(sp Spotify) { s.spotify = sp }

func lookPath(configured, name string) string {
	if configured != "" {
		name = configured
	}
	p, err := exec.LookPath(name)
	if err != nil {
		return ""
	}
	return p
}

func (s *Service) SetBlobs(b Blobs) { s.blobs = b }

// SetResolver replaces yt-dlp (tests use a fake).
func (s *Service) SetResolver(r Resolver) { s.resolver = r }

// Enabled reports whether the bot can play at all: it needs voice and ffmpeg.
func (s *Service) Enabled() bool { return s.lk.Enabled() && s.ffmpeg != "" }

// YouTube reports whether links and searches work.
func (s *Service) YouTube() bool { return s.Enabled() && s.resolver != nil }

// Close stops every player.
func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

// state is a channel's current state (an empty one when nothing plays).
func (s *Service) state(channelID id.ID) MusicState {
	s.mu.Lock()
	p := s.players[channelID]
	s.mu.Unlock()
	if p == nil {
		return s.withFlags(MusicState{ChannelID: channelID, Queue: []MusicTrack{}})
	}
	return p.snapshot()
}

func (s *Service) withFlags(st MusicState) MusicState {
	st.Enabled, st.YouTube = s.Enabled(), s.YouTube()
	if st.Repeat == "" {
		st.Repeat = "off"
	}
	return st
}

func (s *Service) publish(st MusicState) {
	st = s.withFlags(st)
	s.bus.Publish(events.Event{Type: "MUSIC_UPDATE", Data: st, Scope: events.Scope{ChannelID: st.ChannelID}})
}

// player returns the channel's player, starting one if create is set.
func (s *Service) player(channelID id.ID, create bool) *player {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p := s.players[channelID]; p != nil || !create {
		return p
	}
	p := newPlayer(s, channelID)
	s.players[channelID] = p
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		p.run(s.ctx)
		s.mu.Lock()
		if s.players[channelID] == p {
			delete(s.players, channelID)
		}
		s.mu.Unlock()
		s.publish(MusicState{ChannelID: channelID, Queue: []MusicTrack{}})
	}()
	return p
}

// humans counts the people (not bots) in a channel's voice.
func (s *Service) humans(channelID id.ID) int {
	return len(s.voice.States([]id.ID{channelID}))
}

// inChannel reports whether a user is in a channel's voice.
func (s *Service) inChannel(userID, channelID id.ID) bool {
	for _, v := range s.voice.States([]id.ID{channelID}) {
		if v.UserID == userID {
			return true
		}
	}
	return false
}

// idleTimeout is how long the bot stays with nothing to play, and how long
// it stays once everyone has left.
const idleTimeout = 2 * time.Minute

func logErr(ctx context.Context, what string, err error) {
	if err != nil && ctx.Err() == nil {
		slog.WarnContext(ctx, "music: "+what, "err", err)
	}
}
