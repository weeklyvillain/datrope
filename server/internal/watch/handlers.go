package watch

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type StartRequest struct {
	URL string `json:"url" minLength:"1" maxLength:"500" doc:"A YouTube video, or a Twitch channel or VOD"`
}

type SeekRequest struct {
	Position float64 `json:"position" doc:"Seconds into the video"`
}

type BufferingRequest struct {
	Seq       int64 `json:"seq" doc:"The watch's seq this answers"`
	Buffering bool  `json:"buffering" doc:"True while my player loads, false once it can play"`
}

type channelPath struct {
	ChannelID string `path:"channelID"`
}

type updateOutput struct {
	Body WatchUpdate
}

// apiError turns the service's errors into HTTP errors.
func apiError(err error) error {
	switch {
	case errors.Is(err, ErrNotInVoice):
		return httpx.E(http.StatusForbidden, "NOT_IN_VOICE", "join the voice channel to control what it watches")
	case errors.Is(err, ErrNothingPlaying):
		return httpx.BadRequest("NOTHING_PLAYING", "nothing is being watched")
	case errors.Is(err, ErrNotSeekable):
		return httpx.BadRequest("NOT_SEEKABLE", "a live stream cannot be seeked")
	case errors.Is(err, ErrUnsupportedLink):
		return httpx.BadRequest("UNSUPPORTED_LINK", "paste a YouTube video, or a Twitch channel or VOD")
	}
	return err
}

func Register(api huma.API, s *Service) {
	tags := []string{"watch"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) id.ID { return auth.Current(ctx).User.ID }
	// voiceChannel resolves a voice channel the caller can see.
	voiceChannel := func(ctx context.Context, raw string) (id.ID, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return 0, err
		}
		ch, _, err := s.channels.Access(ctx, me(ctx), chID, perms.ViewChannel)
		if err != nil {
			return 0, err
		}
		if ch.Type != channels.TypeVoice {
			return 0, httpx.BadRequest("NOT_VOICE_CHANNEL", "watching together happens in voice channels")
		}
		return ch.ID, nil
	}
	reply := func(u WatchUpdate, err error) (*updateOutput, error) {
		if err != nil {
			return nil, apiError(err)
		}
		return &updateOutput{Body: u}, nil
	}

	huma.Register(api, op("get-watch", http.MethodGet, "/api/channels/{channelID}/watch", 0),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return &updateOutput{Body: s.Get(ch)}, nil
		})

	huma.Register(api, op("start-watch", http.MethodPost, "/api/channels/{channelID}/watch", http.StatusOK),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      StartRequest
		}) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Start(me(ctx), ch, in.Body.URL))
		})

	huma.Register(api, op("play-watch", http.MethodPost, "/api/channels/{channelID}/watch/play", http.StatusOK),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Play(me(ctx), ch))
		})

	huma.Register(api, op("pause-watch", http.MethodPost, "/api/channels/{channelID}/watch/pause", http.StatusOK),
		func(ctx context.Context, in *channelPath) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Pause(me(ctx), ch))
		})

	huma.Register(api, op("seek-watch", http.MethodPost, "/api/channels/{channelID}/watch/seek", http.StatusOK),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      SeekRequest
		}) (*updateOutput, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			return reply(s.Seek(me(ctx), ch, in.Body.Position))
		})

	huma.Register(api, op("report-watch-buffering", http.MethodPost, "/api/channels/{channelID}/watch/buffering", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ChannelID string `path:"channelID"`
			Body      BufferingRequest
		}) (*struct{}, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := s.Report(me(ctx), ch, in.Body.Seq, in.Body.Buffering); err != nil {
				return nil, apiError(err)
			}
			return nil, nil
		})

	huma.Register(api, op("stop-watch", http.MethodDelete, "/api/channels/{channelID}/watch", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			ch, err := voiceChannel(ctx, in.ChannelID)
			if err != nil {
				return nil, err
			}
			if err := s.Stop(me(ctx), ch); err != nil {
				return nil, apiError(err)
			}
			return nil, nil
		})
}
