package messages

import (
	"context"
	"errors"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/perms"
)

type KeepRequest struct {
	Keep bool `json:"keep" doc:"true: never delete it by the size rules; false: let them apply again (counted from now)"`
}

// sentFileFor loads a sent attachment the caller may manage: their own, or (MANAGE_MESSAGES) someone they
// outrank; DMs need no outranking. The same rule as deleting the message.
func (s *Service) sentFileFor(ctx context.Context, raw string) (*files.Attachment, *channels.Channel, error) {
	aid, err := httpx.ParseID(raw, "attachment")
	if err != nil {
		return nil, nil, err
	}
	a, err := s.attachments.Get(ctx, aid)
	if err != nil {
		return nil, nil, err
	}
	if a.MessageID() == nil || a.ChannelID == nil {
		return nil, nil, httpx.NotFound("attachment")
	}
	me := auth.Current(ctx).User.ID
	ch, have, err := s.channels.Access(ctx, me, *a.ChannelID, perms.ReadHistory)
	if err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return nil, nil, httpx.NotFound("attachment")
		}
		return nil, nil, err
	}
	if a.UploaderID() == me {
		return a, ch, nil
	}
	if !have.Has(perms.ManageMessages) {
		return nil, nil, httpx.MissingPermission()
	}
	if ch.Type != channels.TypeDM {
		ok, err := s.ranks.Outranks(ctx, me, a.UploaderID())
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			return nil, nil, httpx.MissingPermission()
		}
	}
	return a, ch, nil
}

type AttachmentPath struct {
	ID string `path:"id"`
}

func registerAttachmentActions(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("keep-attachment", http.MethodPatch, "/api/attachments/{id}", 0),
		func(ctx context.Context, in *struct {
			AttachmentPath
			Body KeepRequest
		}) (*struct{ Body *files.Attachment }, error) {
			a, ch, err := s.sentFileFor(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if err := s.attachments.SetKeep(ctx, a, in.Body.Keep); err != nil {
				return nil, err
			}
			if a, err = s.attachments.Get(ctx, a.ID); err != nil {
				return nil, err
			}
			s.publishUpdated(ctx, ch.ID, *a.MessageID())
			return &struct{ Body *files.Attachment }{a}, nil
		})
	huma.Register(api, op("remove-attachment", http.MethodDelete, "/api/attachments/{id}", http.StatusNoContent),
		func(ctx context.Context, in *AttachmentPath) (*struct{}, error) {
			a, _, err := s.sentFileFor(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			return nil, s.attachments.ExpireNow(ctx, a) // publishes MESSAGE_UPDATE through the expiry hook
		})
}
