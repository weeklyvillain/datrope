package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// FileItem is one file in the gallery: the attachment, its message, and where it was posted
// (a thread's file carries the thread; clients tag it with parent_name).
type FileItem struct {
	Attachment files.Attachment `json:"attachment"`
	Message    Message          `json:"message"`
	Channel    ChannelRef       `json:"channel"`
	Kind       string           `json:"kind" enum:"image,video,audio,document,archive,other"`
}

type FilesPage struct {
	Items      []FileItem `json:"items"`
	NextCursor *id.ID     `json:"next_cursor,omitempty" doc:"Pass as before= for the next page"`
}

// kindSQL classifies attachment a by its sniffed type (without parameters). Mirrored in
// clients/web/src/app/gallery/kinds.ts: change both together.
const kindSQL = `(CASE
	WHEN a.gif OR split_part(a.content_type, ';', 1) LIKE 'image/%' THEN 'image'
	WHEN split_part(a.content_type, ';', 1) LIKE 'video/%' THEN 'video'
	WHEN split_part(a.content_type, ';', 1) LIKE 'audio/%' THEN 'audio'
	WHEN split_part(a.content_type, ';', 1) LIKE 'text/%'
		OR split_part(a.content_type, ';', 1) IN ('application/pdf', 'application/json', 'application/rtf', 'application/msword',
			'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
		OR split_part(a.content_type, ';', 1) LIKE 'application/vnd.openxmlformats-officedocument.%'
		OR split_part(a.content_type, ';', 1) LIKE 'application/vnd.oasis.opendocument.%' THEN 'document'
	WHEN split_part(a.content_type, ';', 1) IN ('application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed',
		'application/vnd.rar', 'application/x-tar', 'application/gzip', 'application/x-gzip', 'application/x-bzip2', 'application/x-xz') THEN 'archive'
	ELSE 'other' END)`

var fileKinds = map[string]bool{"image": true, "video": true, "audio": true, "document": true, "archive": true, "other": true}

const filesPageMax = 100

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

type FilesQuery struct {
	Kinds    []string
	Channels []id.ID // nil: every readable channel
	Uploader *id.ID
	Text     string
	Before   *id.ID
	Limit    int
}

// Files lists the files userID can read outside DMs, newest first (spec: global gallery).
func (s *Service) Files(ctx context.Context, userID id.ID, fq FilesQuery) (*FilesPage, error) {
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	if fq.Channels != nil {
		readable := map[id.ID]bool{}
		for _, c := range scope {
			readable[c] = true
		}
		var narrowed []id.ID
		for _, c := range fq.Channels {
			if readable[c] {
				narrowed = append(narrowed, c)
			}
		}
		scope = narrowed
	}
	page := &FilesPage{Items: []FileItem{}}
	if len(scope) == 0 {
		return page, nil
	}
	var args []any
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	sc := add(id.Int64s(scope))
	conds := []string{
		"a.message_id IS NOT NULL", "NOT m.deleted", "c.type <> 'dm'",
		"(a.channel_id = ANY(" + sc + ") OR (c.type = 'thread' AND c.parent_channel_id = ANY(" + sc + ")))",
	}
	if len(fq.Kinds) > 0 {
		conds = append(conds, kindSQL+" = ANY("+add(fq.Kinds)+")")
	}
	if fq.Uploader != nil {
		conds = append(conds, "a.uploader_id = "+add(*fq.Uploader))
	}
	if fq.Text != "" {
		p := add(fq.Text)
		conds = append(conds, "(a.filename ILIKE '%' || "+add(likeEscaper.Replace(fq.Text))+" || '%'"+
			" OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', "+p+"))")
	}
	if fq.Before != nil {
		conds = append(conds, "a.id < "+add(*fq.Before))
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, a.message_id, `+kindSQL+`
		FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = a.channel_id
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY a.id DESC LIMIT `+add(fq.Limit+1), args...)
	if err != nil {
		return nil, err
	}
	type hit struct {
		att, msg id.ID
		kind     string
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.att, &h.msg, &h.kind); err != nil {
			rows.Close()
			return nil, err
		}
		hits = append(hits, h)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(hits) > fq.Limit {
		hits = hits[:fq.Limit]
		next := hits[len(hits)-1].att
		page.NextCursor = &next
	}
	if len(hits) == 0 {
		return page, nil
	}
	attIDs := make([]id.ID, len(hits))
	msgIDs := make([]id.ID, 0, len(hits))
	seen := map[id.ID]bool{}
	for i, h := range hits {
		attIDs[i] = h.att
		if !seen[h.msg] {
			seen[h.msg] = true
			msgIDs = append(msgIDs, h.msg)
		}
	}
	atts, err := s.attachments.ForIDs(ctx, attIDs)
	if err != nil {
		return nil, err
	}
	mrows, err := s.db.Query(ctx, `SELECT `+messageCols+` FROM messages WHERE id = ANY($1)`, id.Int64s(msgIDs))
	if err != nil {
		return nil, err
	}
	ms, err := collectMessages(mrows)
	if err != nil {
		return nil, err
	}
	if err := s.hydrate(ctx, ms); err != nil {
		return nil, err
	}
	byID := make(map[id.ID]Message, len(ms))
	for _, m := range ms {
		byID[m.ID] = m
	}
	refs, err := s.channelRefs(ctx, channelIDsOf(ms))
	if err != nil {
		return nil, err
	}
	for _, h := range hits {
		m, ok := byID[h.msg]
		a, aok := atts[h.att]
		if !ok || !aok {
			continue // deleted between the two queries
		}
		page.Items = append(page.Items, FileItem{Attachment: a, Message: m, Channel: refs[m.ChannelID], Kind: h.kind})
	}
	return page, nil
}

func parseIDList(raw, what string) ([]id.ID, error) {
	if raw == "" {
		return nil, nil
	}
	out := []id.ID{}
	for _, p := range strings.Split(raw, ",") {
		v, err := id.Parse(strings.TrimSpace(p))
		if err != nil {
			return nil, httpx.BadRequest("VALIDATION_FAILED", what+" must be IDs separated by commas")
		}
		out = append(out, v)
	}
	return out, nil
}

func registerFiles(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-files", http.MethodGet, "/api/files", 0),
		func(ctx context.Context, in *struct {
			Kind     string `query:"kind" doc:"Comma-separated: image, video, audio, document, archive, other"`
			Channel  string `query:"channel" doc:"Comma-separated channel IDs; a channel includes its threads"`
			Uploader string `query:"uploader"`
			Q        string `query:"q" maxLength:"100" doc:"Matches file names and captions"`
			Before   string `query:"before" doc:"next_cursor from the previous page"`
			Limit    int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body *FilesPage }, error) {
			me := auth.Current(ctx).User.ID
			if !s.searchLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			fq := FilesQuery{Text: strings.TrimSpace(in.Q), Limit: min(max(in.Limit, 1), filesPageMax)}
			if in.Kind != "" {
				for _, k := range strings.Split(in.Kind, ",") {
					k = strings.TrimSpace(k)
					if !fileKinds[k] {
						return nil, httpx.BadRequest("VALIDATION_FAILED", "kind must be image, video, audio, document, archive or other")
					}
					fq.Kinds = append(fq.Kinds, k)
				}
			}
			var err error
			if fq.Channels, err = parseIDList(in.Channel, "channel"); err != nil {
				return nil, err
			}
			if in.Uploader != "" {
				u, err := id.Parse(in.Uploader)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "uploader must be a user ID")
				}
				fq.Uploader = &u
			}
			if in.Before != "" {
				b, err := id.Parse(in.Before)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", "before must be an attachment ID")
				}
				fq.Before = &b
			}
			page, err := s.Files(ctx, me, fq)
			return &struct{ Body *FilesPage }{page}, err
		})
}
