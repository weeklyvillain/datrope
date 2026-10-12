package audit

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Schema lists every action as the OpenAPI enum.
func (Action) Schema(huma.Registry) *huma.Schema {
	enum := make([]any, len(Actions))
	for i, a := range Actions {
		enum[i] = string(a)
	}
	return &huma.Schema{Type: huma.TypeString, Enum: enum}
}

type LogEntry struct {
	ID        id.ID      `json:"id"`
	Action    Action     `json:"action"`
	ActorID   id.ID      `json:"actor_id"`
	TargetID  *id.ID     `json:"target_id,omitempty" doc:"The user, channel, category, role or other thing acted on"`
	Details   LogDetails `json:"details"`
	CreatedAt time.Time  `json:"created_at"`
}

type LogPage struct {
	Entries []LogEntry `json:"entries" doc:"Newest first"`
	// Users holds the actors and the users acted on, keyed by ID.
	Users map[string]auth.PublicUser `json:"users"`
}

func Register(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-audit-log", Method: http.MethodGet, Path: "/api/server/audit-log",
		Tags: []string{"server"}, Security: httpx.Authed,
	}, func(ctx context.Context, in *struct {
		Before string `query:"before" doc:"Only entries older than this ID"`
		Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
	}) (*struct{ Body *LogPage }, error) {
		p, err := s.perms.BasePerms(ctx, auth.Current(ctx).User.ID)
		if err != nil {
			return nil, err
		}
		if !p.Has(perms.ViewAuditLog) {
			return nil, httpx.MissingPermission()
		}
		var before *id.ID
		if in.Before != "" {
			v, err := id.Parse(in.Before)
			if err != nil {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be an audit log entry ID")
			}
			before = &v
		}
		page, err := s.list(ctx, before, in.Limit)
		return &struct{ Body *LogPage }{page}, err
	})
}

func (s *Service) list(ctx context.Context, before *id.ID, limit int) (*LogPage, error) {
	rows, err := s.db.Query(ctx, `
		SELECT id, action, actor_id, target_id, details FROM audit_log
		WHERE $1::bigint IS NULL OR id < $1
		ORDER BY id DESC LIMIT $2`, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &LogPage{Entries: []LogEntry{}, Users: map[string]auth.PublicUser{}}
	var userIDs []id.ID
	for rows.Next() {
		var e LogEntry
		var target *int64
		if err := rows.Scan(&e.ID, &e.Action, &e.ActorID, &target, &e.Details); err != nil {
			return nil, err
		}
		e.TargetID = id.FromNullable(target)
		e.CreatedAt = e.ID.Time()
		page.Entries = append(page.Entries, e)
		userIDs = append(userIDs, e.ActorID)
		if e.TargetID != nil {
			userIDs = append(userIDs, *e.TargetID) // users only: other IDs find nobody
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users, err := s.users.PublicUsers(ctx, userIDs)
	if err != nil {
		return nil, err
	}
	for uid, u := range users {
		page.Users[uid.String()] = u
	}
	return page, nil
}
