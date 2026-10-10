package music

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type QueueRequest struct {
	Query   string `json:"query,omitempty" maxLength:"300" doc:"A YouTube link, or words to search YouTube for"`
	TrackID *id.ID `json:"track_id,omitempty" doc:"A track from the server's music library"`
}

type channelPath struct {
	ChannelID string `path:"channelID"`
}

func errNotInVoice() error {
	return httpx.E(http.StatusForbidden, "NOT_IN_VOICE", "join the voice channel to control its music")
}

func unavailable(msg string) error {
	return httpx.E(http.StatusServiceUnavailable, "MUSIC_UNAVAILABLE", msg)
}

func Register(api huma.API, s *Service) {
	tags := []string{"music"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	// voiceChannel resolves a voice channel the caller can see.
	voiceChannel := func(ctx context.Context, raw string) (*channels.Channel, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return nil, err
		}
		ch, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, perms.ViewChannel)
		if err != nil {
			return nil, err
		}
		if ch.Type != channels.TypeVoice {
			return nil, httpx.BadRequest("NOT_VOICE_CHANNEL", "music plays in voice channels")
		}
		return ch, nil
	}
	// control also needs the caller to be in the channel's voice.
	control := func(ctx context.Context, raw string) (*channels.Channel, error) {
		ch, err := voiceChannel(ctx, raw)
		if err != nil {
			return nil, err
		}
		if !s.inChannel(auth.Current(ctx).User.ID, ch.ID) {
			return nil, errNotInVoice()
		}
		return ch, nil
	}

	huma.Register(api, op("get-music", http.MethodGet, "/api/channels/{channelID}/music", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body MusicState }, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return &struct{ Body MusicState }{s.state(ch.ID)}, nil
		})

	huma.Register(api, op("queue-music", http.MethodPost, "/api/channels/{channelID}/music", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      QueueRequest
		}) (*struct{ Body MusicTrack }, error) {
			if !s.Enabled() {
				return nil, unavailable("the music bot is not set up on this server (it needs voice and ffmpeg)")
			}
			ch, err := control(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			t := MusicTrack{ID: id.New(), RequestedBy: me}
			query := strings.TrimSpace(in.Body.Query)
			switch {
			case in.Body.TrackID != nil:
				lt, err := s.libraryTrack(ctx, *in.Body.TrackID)
				if err != nil {
					return nil, err
				}
				t.Title, t.Duration, t.Source, t.blob = lt.Title, lt.Duration, "upload", lt.sum
			case query != "":
				if s.resolver == nil {
					return nil, unavailable("YouTube is not set up on this server (it needs yt-dlp); play from the library instead")
				}
				if strings.Contains(query, "://") && !strings.HasPrefix(query, "https://") && !strings.HasPrefix(query, "http://") {
					return nil, httpx.BadRequest("BAD_QUERY", "use a web link or search words")
				}
				r, err := s.resolver.Resolve(ctx, query)
				if errors.Is(err, ErrNotFound) {
					return nil, httpx.NotFound("track")
				}
				if err != nil {
					return nil, httpx.BadRequest("NOT_PLAYABLE", "that could not be found or played")
				}
				t.Title, t.URL, t.Duration, t.Source = r.Title, r.URL, r.Duration, "youtube"
			default:
				return nil, httpx.BadRequest("VALIDATION_FAILED", "give a query or a track_id")
			}
			for range 2 { // a player that is just stopping is replaced
				err = s.player(ch.ID, true).add(t)
				if !errors.Is(err, errStopped) {
					break
				}
				s.mu.Lock()
				if p := s.players[ch.ID]; p != nil {
					p.mu.Lock()
					if p.stopped {
						delete(s.players, ch.ID)
					}
					p.mu.Unlock()
				}
				s.mu.Unlock()
			}
			if errors.Is(err, ErrQueueFull) {
				return nil, httpx.BadRequest("QUEUE_FULL", "the queue is full (100 tracks)")
			}
			return &struct{ Body MusicTrack }{t}, err
		})

	huma.Register(api, op("control-music", http.MethodPost, "/api/channels/{channelID}/music/{action}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Action    string `path:"action" enum:"pause,resume,skip,stop"`
		}) (*struct{}, error) {
			ch, err := control(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			p := s.player(ch.ID, false)
			if p == nil {
				return nil, httpx.BadRequest("NOTHING_PLAYING", "nothing is playing")
			}
			switch in.Action {
			case "pause":
				p.setPaused(true)
			case "resume":
				p.setPaused(false)
			case "skip":
				p.skip()
			case "stop":
				p.stop()
			}
			return nil, nil
		})

	huma.Register(api, op("remove-queued-music", http.MethodDelete, "/api/channels/{channelID}/music/queue/{trackID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			TrackID   string `path:"trackID"`
		}) (*struct{}, error) {
			ch, err := control(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			tid, err := httpx.ParseID(in.TrackID, "track")
			if err != nil {
				return nil, err
			}
			if p := s.player(ch.ID, false); p == nil || !p.remove(tid) {
				return nil, httpx.NotFound("track")
			}
			return nil, nil
		})

	registerLibrary(api, s, op)
}
