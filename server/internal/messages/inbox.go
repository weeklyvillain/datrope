package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

type MentionItem struct {
	Message Message    `json:"message"`
	Channel ChannelRef `json:"channel"`
	Unread  bool       `json:"unread"`
}

type MentionsPage struct {
	Items       []MentionItem `json:"items"`
	UnreadCount *int          `json:"unread_count,omitempty" doc:"First page only; capped at 100"`
	NextCursor  *id.ID        `json:"next_cursor,omitempty"`
}

type AckMentionsResult struct {
	ReadStates []ReadState `json:"read_states"`
}

const mentionsUnreadCap = 100

// mentionsWhere: live messages that mention $1, by someone else, where $1 can still read them ($2).
var mentionsWhere = `m.mentions @> ARRAY[$1::bigint] AND NOT m.deleted AND m.author_id <> $1 AND ` + readableSQL("$2")

// unreadSQL: m is newer than $1's read position in its channel.
const unreadSQL = `m.id > COALESCE((SELECT rs.last_message_id FROM read_states rs WHERE rs.user_id = $1 AND rs.channel_id = m.channel_id), 0)`

// Mentions lists the messages that mention userID, newest first (spec M8).
func (s *Service) Mentions(ctx context.Context, userID id.ID, before *id.ID, limit int) (*MentionsPage, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+messageCols+`, `+unreadSQL+` FROM messages m
		WHERE `+mentionsWhere+` AND ($3::bigint IS NULL OR m.id < $3) ORDER BY m.id DESC LIMIT $4`,
		userID, id.Int64s(scope), before, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ms []Message
	var unread []bool
	for rows.Next() {
		var u bool
		m, err := scanMessage(rows, &u)
		if err != nil {
			return nil, err
		}
		ms, unread = append(ms, *m), append(unread, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	page := &MentionsPage{Items: []MentionItem{}}
	if len(ms) > limit {
		ms, unread = ms[:limit], unread[:limit]
		next := ms[limit-1].ID
		page.NextCursor = &next
	}
	if before == nil {
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM messages m WHERE `+mentionsWhere+` AND `+unreadSQL+
			` LIMIT `+strconv.Itoa(mentionsUnreadCap)+`) x`, userID, id.Int64s(scope)).Scan(&n); err != nil {
			return nil, err
		}
		page.UnreadCount = &n
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for i, m := range ms {
		page.Items = append(page.Items, MentionItem{Message: m, Channel: refs[m.ChannelID], Unread: unread[i]})
	}
	return page, nil
}

// AckMentions moves the read position of every channel with a mention of
// userID up to its newest mention ("Mark all read").
func (s *Service) AckMentions(ctx context.Context, userID id.ID) (*AckMentionsResult, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `
		INSERT INTO read_states (user_id, channel_id, last_message_id)
		SELECT $1, m.channel_id, max(m.id) FROM messages m WHERE `+mentionsWhere+` GROUP BY m.channel_id
		ON CONFLICT (user_id, channel_id)
		DO UPDATE SET last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id)
		RETURNING channel_id, last_message_id`, userID, id.Int64s(scope))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &AckMentionsResult{ReadStates: []ReadState{}}
	for rows.Next() {
		var r ReadState
		var last int64
		if err := rows.Scan(&r.ChannelID, &last); err != nil {
			return nil, err
		}
		l := id.ID(last)
		r.LastReadID = &l
		out.ReadStates = append(out.ReadStates, r)
	}
	return out, rows.Err()
}

func registerInbox(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-mentions", http.MethodGet, "/api/users/@me/mentions", 0),
		func(ctx context.Context, in *struct {
			Before string `query:"before" doc:"next_cursor from the previous page"`
			Limit  int    `query:"limit" minimum:"1" maximum:"50" default:"25"`
		}) (*struct{ Body *MentionsPage }, error) {
			var before *id.ID
			if strings.TrimSpace(in.Before) != "" {
				b, err := id.Parse(in.Before)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be a message ID")
				}
				before = &b
			}
			p, err := s.Mentions(ctx, auth.Current(ctx).User.ID, before, in.Limit)
			return &struct{ Body *MentionsPage }{p}, err
		})
	huma.Register(api, op("ack-mentions", http.MethodPost, "/api/users/@me/mentions/ack", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body *AckMentionsResult }, error) {
			r, err := s.AckMentions(ctx, auth.Current(ctx).User.ID)
			return &struct{ Body *AckMentionsResult }{r}, err
		})
}
