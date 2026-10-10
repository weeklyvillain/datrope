package messages

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// ChannelRef describes where a message lives, for search results and the inbox.
type ChannelRef struct {
	ID         id.ID  `json:"id"`
	Type       string `json:"type"`
	Name       string `json:"name" doc:"Empty for DMs: clients name them after the other people"`
	ParentID   *id.ID `json:"parent_id,omitempty" doc:"For threads: the channel they belong to"`
	ParentName string `json:"parent_name,omitempty"`
}

type SearchResult struct {
	Message Message    `json:"message"`
	Channel ChannelRef `json:"channel"`
}

// SearchFilters echoes the operators the server understood.
type SearchFilters struct {
	Terms     []string         `json:"terms" doc:"Lower-cased words that were searched"`
	From      *auth.PublicUser `json:"from,omitempty"`
	InChannel *ChannelRef      `json:"in_channel,omitempty"`
	InDMWith  *auth.PublicUser `json:"in_dm_with,omitempty"`
	Has       string           `json:"has,omitempty"`
	Before    string           `json:"before,omitempty"`
	After     string           `json:"after,omitempty"`
}

type SearchResponse struct {
	Results    []SearchResult `json:"results"`
	Filters    SearchFilters  `json:"filters"`
	Total      *int           `json:"total,omitempty" doc:"First page only; capped at 1001"`
	NextCursor *id.ID         `json:"next_cursor,omitempty"`
}

const (
	searchPage     = 25
	searchCountCap = 1001 // "1000+ results"
)

// readableSQL limits messages m to the channels in the bigint[] parameter
// and the threads of those channels (a thread follows its parent).
func readableSQL(param string) string {
	return `(m.channel_id = ANY(` + param + `) OR m.channel_id IN (
		SELECT c.id FROM channels c WHERE c.type = 'thread' AND c.parent_channel_id = ANY(` + param + `)))`
}

// Search runs a search box query for userID (spec M8: channels they can read
// plus their DMs; threads follow their parent). utcOffset is minutes east of
// UTC; before:/after: dates are days in that offset.
func (s *Service) Search(ctx context.Context, userID id.ID, raw string, cursor *id.ID, utcOffset int) (*SearchResponse, error) {
	q, err := ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	resp := &SearchResponse{Results: []SearchResult{}, Filters: SearchFilters{Terms: q.Terms, Has: q.Has}}
	var author *id.ID
	if q.From != "" {
		uid, u, err := s.userNamed(ctx, q.From)
		if err != nil {
			return nil, err
		}
		author, resp.Filters.From = &uid, u
	}
	if q.In != "" {
		if scope, err = s.searchScope(ctx, userID, scope, q.In, &resp.Filters); err != nil {
			return nil, err
		}
	}
	loc := time.FixedZone("", utcOffset*60)
	var before, after *id.ID
	if !q.Before.IsZero() {
		b := id.FirstAt(time.Date(q.Before.Year(), q.Before.Month(), q.Before.Day(), 0, 0, 0, 0, loc))
		before, resp.Filters.Before = &b, q.Before.Format(time.DateOnly)
	}
	if !q.After.IsZero() {
		a := id.FirstAt(time.Date(q.After.Year(), q.After.Month(), q.After.Day()+1, 0, 0, 0, 0, loc))
		after, resp.Filters.After = &a, q.After.Format(time.DateOnly)
	}
	// Every condition is added only when it applies, so the GIN index stays usable.
	var args []any
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	conds := []string{"NOT m.deleted", readableSQL(add(id.Int64s(scope)))}
	if q.Text != "" {
		conds = append(conds, "to_tsvector('simple', m.content) @@ plainto_tsquery('simple', "+add(q.Text)+")")
	}
	if author != nil {
		conds = append(conds, "m.author_id = "+add(*author))
	}
	if q.Has == "link" {
		conds = append(conds, "m.content ~* 'https?://'")
	}
	if q.Has == "file" {
		conds = append(conds, "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)")
	}
	if before != nil {
		conds = append(conds, "m.id < "+add(*before))
	}
	if after != nil {
		conds = append(conds, "m.id >= "+add(*after))
	}
	where := strings.Join(conds, " AND ")
	countArgs := args
	pageWhere := where
	if cursor != nil {
		pageWhere += " AND m.id < " + add(*cursor)
	}
	limit := add(searchPage + 1)
	rows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages m WHERE `+pageWhere+` ORDER BY m.id DESC LIMIT `+limit, args...)
	if err != nil {
		return nil, err
	}
	ms, err := collectMessages(rows)
	if err != nil {
		return nil, err
	}
	if len(ms) > searchPage {
		ms = ms[:searchPage]
		next := ms[searchPage-1].ID
		resp.NextCursor = &next
	}
	if cursor == nil {
		var n int
		if err := s.db.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM messages m WHERE `+where+` LIMIT `+
			strconv.Itoa(searchCountCap)+`) x`, countArgs...).Scan(&n); err != nil {
			return nil, err
		}
		resp.Total = &n
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for _, m := range ms {
		resp.Results = append(resp.Results, SearchResult{Message: m, Channel: refs[m.ChannelID]})
	}
	return resp, nil
}

// collectMessages scans every row of rows (and closes it).
func collectMessages(rows pgx.Rows) ([]Message, error) {
	defer rows.Close()
	out := []Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}

func channelIDsOf(ms []Message) []id.ID {
	seen := map[id.ID]bool{}
	out := []id.ID{}
	for _, m := range ms {
		if !seen[m.ChannelID] {
			seen[m.ChannelID] = true
			out = append(out, m.ChannelID)
		}
	}
	return out
}

// userNamed resolves a username written in a search box.
func (s *Service) userNamed(ctx context.Context, name string) (id.ID, *auth.PublicUser, error) {
	unknown := httpx.BadRequest("UNKNOWN_FILTER", fmt.Sprintf("nobody is called %q", name))
	found, err := s.users.UserIDsByUsername(ctx, []string{strings.ToLower(name)})
	if err != nil {
		return 0, nil, err
	}
	uid, ok := found[strings.ToLower(name)]
	if !ok {
		return 0, nil, unknown
	}
	users, err := s.users.PublicUsers(ctx, []id.ID{uid})
	if err != nil {
		return 0, nil, err
	}
	u, ok := users[uid]
	if !ok {
		return 0, nil, unknown
	}
	return uid, &u, nil
}

// searchScope narrows scope to the channel or DM named by an in: operator.
// A channel the caller cannot read is reported like one that does not exist.
func (s *Service) searchScope(ctx context.Context, userID id.ID, scope []id.ID, in string, f *SearchFilters) ([]id.ID, error) {
	if strings.HasPrefix(in, "@") {
		uid, u, err := s.userNamed(ctx, strings.TrimPrefix(in, "@"))
		if err != nil {
			return nil, err
		}
		f.InDMWith = u
		rows, err := s.db.Query(ctx, `
			SELECT c.id FROM channels c JOIN dm_participants p ON p.channel_id = c.id
			WHERE c.id = ANY($1) AND c.type = 'dm' AND p.user_id = $2`, id.Int64s(scope), uid)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []id.ID{}
		for rows.Next() {
			var cid id.ID
			if err := rows.Scan(&cid); err != nil {
				return nil, err
			}
			out = append(out, cid)
		}
		return out, rows.Err()
	}
	var cid id.ID
	err := s.db.QueryRow(ctx, `
		SELECT id FROM channels WHERE id = ANY($1) AND type IN ('text', 'voice', 'webhook', 'announcement', 'forum', 'gallery') AND lower(name) = lower($2)
		ORDER BY id LIMIT 1`, id.Int64s(scope), in).Scan(&cid)
	if err == pgx.ErrNoRows {
		return nil, httpx.BadRequest("UNKNOWN_FILTER", fmt.Sprintf("no channel called %q", "#"+in))
	}
	if err != nil {
		return nil, err
	}
	refs, err := s.channelRefs(ctx, []id.ID{cid})
	if err != nil {
		return nil, err
	}
	ref := refs[cid]
	f.InChannel = &ref
	return []id.ID{cid}, nil
}

// channelRefs describes where messages are, for search results and the inbox.
func (s *Service) channelRefs(ctx context.Context, ids []id.ID) (map[id.ID]ChannelRef, error) {
	rows, err := s.db.Query(ctx, `
		SELECT c.id, c.type, c.name, c.parent_channel_id, COALESCE(p.name, '')
		FROM channels c LEFT JOIN channels p ON p.id = c.parent_channel_id
		WHERE c.id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[id.ID]ChannelRef, len(ids))
	for rows.Next() {
		var r ChannelRef
		var parent *int64
		if err := rows.Scan(&r.ID, &r.Type, &r.Name, &parent, &r.ParentName); err != nil {
			return nil, err
		}
		r.ParentID = id.FromNullable(parent)
		if r.Type == channels.TypeDM {
			r.Name = "" // clients name DMs after the other people
		}
		out[r.ID] = r
	}
	return out, rows.Err()
}

func registerSearch(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("search-messages", http.MethodGet, "/api/search", 0),
		func(ctx context.Context, in *struct {
			Q         string `query:"q" maxLength:"500" doc:"Words plus from:, in:, has:, before:, after:"`
			Cursor    string `query:"cursor" doc:"next_cursor from the previous page"`
			UTCOffset int    `query:"utc_offset" minimum:"-840" maximum:"840" doc:"Minutes east of UTC, for before:/after: dates"`
		}) (*struct{ Body *SearchResponse }, error) {
			if !s.searchLimit.Allow(auth.Current(ctx).User.ID.String()) {
				return nil, httpx.RateLimited()
			}
			var cursor *id.ID
			if in.Cursor != "" {
				c, err := id.Parse(in.Cursor)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "cursor must be a message ID")
				}
				cursor = &c
			}
			r, err := s.Search(ctx, auth.Current(ctx).User.ID, in.Q, cursor, in.UTCOffset)
			return &struct{ Body *SearchResponse }{r}, err
		})
}
