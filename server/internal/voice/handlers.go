package voice

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
)

func Register(api huma.API, s *Service) {
	tags := []string{"voice"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	me := func(ctx context.Context) *auth.User { return auth.Current(ctx).User }
	registerSoundboard(api, s, op)

	huma.Register(api, op("go-afk", http.MethodPost, "/api/voice/afk", http.StatusNoContent),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			return nil, s.GoAFK(ctx, me(ctx).ID)
		})

	huma.Register(api, op("join-voice", http.MethodPost, "/api/voice/{id}/join", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body JoinRequest
		}) (*struct{ Body *JoinResponse }, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			res, err := s.Join(ctx, me(ctx), auth.Current(ctx).SessionID, chID, in.Body)
			return &struct{ Body *JoinResponse }{res}, err
		})

	huma.Register(api, op("voice-connected", http.MethodPost, "/api/voice/connected", http.StatusNoContent),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			return nil, s.Connected(ctx, me(ctx).ID)
		})

	huma.Register(api, op("set-voice-state", http.MethodPatch, "/api/voice/state", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body SelfStateRequest }) (*struct{}, error) {
			return nil, s.SetSelf(ctx, me(ctx).ID, in.Body)
		})

	huma.Register(api, op("server-mute-voice-member", http.MethodPost, "/api/voice/members/{userID}/mute", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
			Body   ServerMuteRequest
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.SetServerMute(ctx, me(ctx).ID, uid, in.Body.Muted)
		})

	huma.Register(api, op("move-voice-member", http.MethodPost, "/api/voice/members/{userID}/move", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
			Body   MoveRequest
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.Move(ctx, me(ctx).ID, uid, in.Body.ChannelID)
		})

	huma.Register(api, op("disconnect-voice-member", http.MethodDelete, "/api/voice/members/{userID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			UserID string `path:"userID"`
		}) (*struct{}, error) {
			uid, err := httpx.ParseID(in.UserID, "user")
			if err != nil {
				return nil, err
			}
			return nil, s.Disconnect(ctx, me(ctx).ID, uid)
		})

	huma.Register(api, op("voice-ping", http.MethodPost, "/api/voice/ping", http.StatusNoContent),
		func(ctx context.Context, in *struct{ Body PingRequest }) (*struct{}, error) {
			return nil, s.Ping(ctx, me(ctx).ID, in.Body.RttMs)
		})

	huma.Register(api, op("draw-teams", http.MethodPost, "/api/voice/{id}/teams", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body TeamsRequest
		}) (*struct{}, error) {
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			return nil, s.DrawTeams(ctx, me(ctx).ID, chID, in.Body)
		})
}
