// Package music runs a music bot per voice channel: a LiveKit participant
// that plays a queue of YouTube links, searches and uploaded tracks, which
// the people in the channel control together.
package music

import (
	"context"
	"io"
	"log/slog"
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
// is off without ffmpeg, and YouTube is off without yt-dlp.
type Config struct {
	FFmpeg string
	YtDlp  string
}

// Channels is what this package needs from channels.
type Channels interface {
	Access(ctx context.Context, userID, channelID id.ID, need perms.Perms) (*channels.Channel, perms.Perms, error)
}

// Voice is what this package needs from voice: who is in which channel.
type Voice interface {
	States(channelIDs []id.ID) []voice.VoiceState
}

// Blobs stores and opens uploaded tracks.
type Blobs interface {
	StoreBlob(ctx context.Context, tx pgx.Tx, data []byte) (string, error)
	OpenBlob(sum string) (io.ReadSeekCloser, error)
	RemoveBlobs(ctx context.Context, sums []string) error
}

// Track is one entry of a queue.
type MusicTrack struct {
	ID          id.ID  `json:"id"`
	Title       string `json:"title"`
	URL         string `json:"url,omitempty" doc:"The page it came from (YouTube); absent for uploads"`
	Duration    int    `json:"duration" doc:"Seconds; 0 when unknown"`
	Source      string `json:"source" enum:"youtube,upload"`
	RequestedBy id.ID  `json:"requested_by"`

	blob string // uploads: the stored file
}

// State is a channel's music: what plays, whether it is paused, what comes next.
type MusicState struct {
	ChannelID id.ID        `json:"channel_id"`
	Current   *MusicTrack  `json:"current,omitempty"`
	Paused    bool         `json:"paused"`
	Position  float64      `json:"position" doc:"Seconds into the current track when the state was sent"`
	Queue     []MusicTrack `json:"queue"`
	BotID     string       `json:"bot_id,omitempty" doc:"The bot's LiveKit identity while it is in the channel (for per-person volume)"`
	Enabled   bool         `json:"enabled" doc:"The server can play music (voice and ffmpeg are set up)"`
	YouTube   bool         `json:"youtube" doc:"YouTube links and searches work (yt-dlp is installed)"`
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
	resolver  Resolver // nil: no YouTube

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
	if yt := lookPath(cfg.YtDlp, "yt-dlp"); yt != "" {
		s.resolver = ytDlp{path: yt}
	}
	return s
}

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
