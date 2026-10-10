package music

import (
	"context"
	"errors"
	"fmt"
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
	Query      string `json:"query,omitempty" maxLength:"300" doc:"A link (YouTube, SoundCloud, Bandcamp, Vimeo, Spotify), or words to search YouTube for"`
	TrackID    *id.ID `json:"track_id,omitempty" doc:"A track from the server's music library"`
	PlaylistID *id.ID `json:"playlist_id,omitempty" doc:"A saved playlist: queue all its tracks"`
	Playlist   bool   `json:"playlist,omitempty" doc:"With a link: queue every track of the playlist it is in, not just the one it points at"`
	Shuffle    bool   `json:"shuffle,omitempty" doc:"With several tracks: queue them in a random order"`
	Replace    bool   `json:"replace,omitempty" doc:"Clear the queue first; the current track plays on"`
}

type QueueResult struct {
	Tracks  []MusicTrack `json:"tracks" doc:"What was queued"`
	Skipped int          `json:"skipped" doc:"Tracks that did not fit in the queue"`
	Dropped int          `json:"dropped" doc:"Playlist entries that are private, deleted or cannot be played"`
}

type RepeatRequest struct {
	Mode string `json:"mode" enum:"off,all,one"`
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
	// playing is the channel's player, when the bot is there.
	playing := func(ctx context.Context, raw string) (*player, error) {
		ch, err := control(ctx, raw)
		if err != nil {
			return nil, err
		}
		p := s.player(ch.ID, false)
		if p == nil {
			return nil, httpx.BadRequest("NOTHING_PLAYING", "nothing is playing")
		}
		return p, nil
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
		}) (*struct{ Body QueueResult }, error) {
			if !s.Enabled() {
				return nil, unavailable("the music bot is not set up on this server (it needs voice and ffmpeg)")
			}
			ch, err := control(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			var res QueueResult
			var tracks []MusicTrack
			query := strings.TrimSpace(in.Body.Query)
			switch {
			case in.Body.TrackID != nil:
				lt, err := s.libraryTrack(ctx, *in.Body.TrackID)
				if err != nil {
					return nil, err
				}
				tracks = []MusicTrack{libraryTrackOf(lt)}
			case in.Body.PlaylistID != nil:
				if _, err := s.member(ctx); err != nil {
					return nil, err
				}
				items, err := s.playlistItems(ctx, *in.Body.PlaylistID)
				if err != nil {
					return nil, err
				}
				for _, it := range items {
					tracks = append(tracks, it.track())
				}
				if len(tracks) == 0 {
					return nil, httpx.BadRequest("PLAYLIST_EMPTY", "the playlist has no tracks")
				}
			case query != "":
				tracks, _, res.Dropped, err = s.lookup(ctx, query, in.Body.Playlist)
				if err != nil {
					return nil, err
				}
			default:
				return nil, httpx.BadRequest("VALIDATION_FAILED", "give a query, a track_id or a playlist_id")
			}
			if in.Body.Shuffle {
				shuffleTracks(tracks)
			}
			stamp(tracks, auth.Current(ctx).User.ID)
			var n int
			for range 2 { // a player that is just stopping is replaced
				n, err = s.player(ch.ID, true).add(tracks, in.Body.Replace)
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
				return nil, httpx.BadRequest("QUEUE_FULL", fmt.Sprintf("the queue is full (%d tracks)", maxQueue))
			}
			if err != nil {
				return nil, err
			}
			res.Tracks, res.Skipped = tracks[:n], len(tracks)-n
			return &struct{ Body QueueResult }{res}, nil
		})

	huma.Register(api, op("control-music", http.MethodPost, "/api/channels/{channelID}/music/{action}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Action    string `path:"action" enum:"pause,resume,skip,stop,shuffle"`
		}) (*struct{}, error) {
			p, err := playing(ctx, in.ChannelID)
			if err != nil {
				return nil, err
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
			case "shuffle":
				p.shuffle()
			}
			return nil, nil
		})

	huma.Register(api, op("set-music-repeat", http.MethodPut, "/api/channels/{channelID}/music/repeat", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      RepeatRequest
		}) (*struct{}, error) {
			p, err := playing(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			p.setRepeat(in.Body.Mode)
			return nil, nil
		})

	huma.Register(api, op("clear-music-queue", http.MethodDelete, "/api/channels/{channelID}/music/queue", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			p, err := playing(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			p.clear()
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
	registerPlaylists(api, s, op, voiceChannel)
}
