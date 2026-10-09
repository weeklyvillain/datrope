package communities

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Welcome is the welcome channel's page.
type Welcome struct {
	ChannelID id.ID  `json:"channel_id"`
	Markdown  string `json:"markdown"`
	RulesGate bool   `json:"rules_gate" doc:"New members see only this page until they accept the rules"`
}

type UpdateWelcomeRequest struct {
	Markdown  string `json:"markdown" maxLength:"50000"`
	RulesGate bool   `json:"rules_gate,omitempty"`
}

func errGated() *httpx.Error {
	return httpx.E(http.StatusForbidden, "RULES_NOT_ACCEPTED", "accept the server's rules on the welcome page first")
}

func (s *Service) welcome(ctx context.Context, serverID id.ID) (*Welcome, error) {
	var w Welcome
	err := s.db.QueryRow(ctx, `
		SELECT ch.id, c.welcome_markdown, c.rules_gate
		FROM communities c JOIN channels ch ON ch.community_id = c.id AND ch.type = 'welcome'
		WHERE c.id = $1`, serverID).Scan(&w.ChannelID, &w.Markdown, &w.RulesGate)
	return &w, err
}

func registerWelcome(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("get-welcome", http.MethodGet, "/api/server/welcome", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *Welcome }, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			w, err := s.welcome(ctx, a.CommunityID)
			return &struct{ Body *Welcome }{w}, err
		})

	huma.Register(api, op("update-welcome", http.MethodPut, "/api/server/welcome", 0),
		func(ctx context.Context, in *struct{ Body UpdateWelcomeRequest }) (*struct{ Body *Welcome }, error) {
			a, err := s.requireActor(ctx, perms.ManageServer)
			if err != nil {
				return nil, err
			}
			if in.Body.RulesGate && strings.TrimSpace(in.Body.Markdown) == "" {
				return nil, httpx.BadRequest("WELCOME_EMPTY", "write the welcome page before turning on the rules gate")
			}
			var wasGated bool
			if err := s.db.QueryRow(ctx, `
				UPDATE communities c SET welcome_markdown = $2, rules_gate = $3
				FROM communities old WHERE c.id = $1 AND old.id = c.id
				RETURNING old.rules_gate`, a.CommunityID, in.Body.Markdown, in.Body.RulesGate).Scan(&wasGated); err != nil {
				return nil, err
			}
			w, err := s.welcome(ctx, a.CommunityID)
			if err != nil {
				return nil, err
			}
			s.bus.Publish(events.Event{Type: "WELCOME_UPDATE", Data: w, Scope: events.Scope{CommunityID: a.CommunityID}})
			if wasGated != w.RulesGate {
				if err := s.PublishServerUpdate(ctx); err != nil {
					return nil, err
				}
			}
			return &struct{ Body *Welcome }{w}, nil
		})

	huma.Register(api, op("accept-rules", http.MethodPost, "/api/server/welcome/accept", http.StatusNoContent),
		func(ctx context.Context, _ *struct{}) (*struct{}, error) {
			a, err := s.requireActor(ctx, 0)
			if err != nil {
				return nil, err
			}
			tag, err := s.db.Exec(ctx, `
				UPDATE members SET accepted_rules_at = now()
				WHERE community_id = $1 AND user_id = $2 AND accepted_rules_at IS NULL`, a.CommunityID, a.Member.UserID)
			if err != nil || tag.RowsAffected() == 0 {
				return nil, err
			}
			return nil, s.publishMemberUpdate(ctx, a.CommunityID, a.Member.UserID)
		})
}
