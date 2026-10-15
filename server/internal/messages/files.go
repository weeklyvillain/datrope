package messages

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// FileItem is one file in a gallery or album: the attachment, its message and where it was posted
// (a thread's file carries the thread; clients tag it with parent_name).
type FileItem struct {
	Attachment files.Attachment `json:"attachment"`
	Message    *Message         `json:"message,omitempty"`
	Channel    *ChannelRef      `json:"channel,omitempty"`
	Kind       string           `json:"kind" enum:"image,video,audio,document,archive,other"`
	UploaderID id.ID            `json:"uploader_id"`
	CreatedAt  time.Time        `json:"created_at" doc:"When the file was uploaded"`
}

// FileHit is a file found by a listing: its attachment and kind (see KindSQL).
type FileHit struct {
	AttachmentID id.ID
	Kind         string
}

type FilesPage struct {
	Items      []FileItem `json:"items"`
	NextCursor *id.ID     `json:"next_cursor,omitempty" doc:"Pass as before= for the next page"`
}

// KindSQL classifies attachment a by its sniffed type (without parameters). Mirrored in
// clients/web/src/app/gallery/kinds.ts: change both together. Exported for album listings, which
// also alias attachments as a.
const KindSQL = `(CASE
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
	Gallery  *id.ID  // the gallery's scope; else Channels (required then)
	Channels []id.ID // narrows the scope; with no Gallery, the scope is these readable channels
	Uploader *id.ID
	Text     string
	Before   *id.ID
	Limit    int
}

// Files lists the files userID can read outside DMs in a gallery's scope or in the given channels, newest first.
func (s *Service) Files(ctx context.Context, userID id.ID, fq FilesQuery) (*FilesPage, error) {
	var scope []id.ID
	var err error
	if fq.Gallery != nil {
		scope, err = s.channels.GalleryScope(ctx, userID, *fq.Gallery)
	} else {
		scope, err = s.channels.Readable(ctx, userID)
	}
	if err != nil {
		return nil, err
	}
	if fq.Channels != nil {
		in := map[id.ID]bool{}
		for _, c := range scope {
			in[c] = true
		}
		var narrowed []id.ID
		for _, c := range fq.Channels {
			if in[c] {
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
		"a.message_id IS NOT NULL", "a.expired_at IS NULL", "NOT m.deleted", "c.type <> 'dm'",
		"(a.channel_id = ANY(" + sc + ") OR (c.type = 'thread' AND c.parent_channel_id = ANY(" + sc + ")))",
	}
	if len(fq.Kinds) > 0 {
		conds = append(conds, KindSQL+" = ANY("+add(fq.Kinds)+")")
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
	rows, err := s.db.Query(ctx, `SELECT a.id, `+KindSQL+`
		FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = a.channel_id
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY a.id DESC LIMIT `+add(fq.Limit+1), args...)
	if err != nil {
		return nil, err
	}
	var hits []FileHit
	for rows.Next() {
		var h FileHit
		if err := rows.Scan(&h.AttachmentID, &h.Kind); err != nil {
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
		next := hits[len(hits)-1].AttachmentID
		page.NextCursor = &next
	}
	items, err := s.FileItems(ctx, hits)
	if err != nil {
		return nil, err
	}
	page.Items = items
	return page, nil
}

// FileItems hydrates listed files, in order, each with its message and channel. Files deleted since
// they were listed are left out.
func (s *Service) FileItems(ctx context.Context, hits []FileHit) ([]FileItem, error) {
	out := []FileItem{}
	if len(hits) == 0 {
		return out, nil
	}
	attIDs := make([]id.ID, len(hits))
	for i, h := range hits {
		attIDs[i] = h.AttachmentID
	}
	atts, err := s.attachments.ForIDs(ctx, attIDs)
	if err != nil {
		return nil, err
	}
	msgIDs := []id.ID{}
	seen := map[id.ID]bool{}
	for _, a := range atts {
		if m := a.MessageID(); m != nil && !seen[*m] {
			seen[*m] = true
			msgIDs = append(msgIDs, *m)
		}
	}
	byID := map[id.ID]Message{}
	refs := map[id.ID]ChannelRef{}
	if len(msgIDs) > 0 {
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
		for _, m := range ms {
			byID[m.ID] = m
		}
		if refs, err = s.channelRefs(ctx, channelIDsOf(ms)); err != nil {
			return nil, err
		}
	}
	for _, h := range hits {
		a, ok := atts[h.AttachmentID]
		if !ok {
			continue // deleted between the two queries
		}
		it := FileItem{Attachment: a, Kind: h.Kind, UploaderID: a.UploaderID(), CreatedAt: a.ID.Time()}
		if mid := a.MessageID(); mid != nil {
			m, ok := byID[*mid]
			if !ok || m.Deleted {
				continue
			}
			ref := refs[m.ChannelID]
			it.Message, it.Channel = &m, &ref
		}
		out = append(out, it)
	}
	return out, nil
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
			Gallery  string `query:"gallery" doc:"A gallery channel ID: its own posts and its sources' files"`
			Kind     string `query:"kind" doc:"Comma-separated: image, video, audio, document, archive, other"`
			Channel  string `query:"channel" doc:"Comma-separated channel IDs; narrows a gallery, or is the scope without one. A channel includes its threads"`
			Uploader string `query:"uploader"`
			Q        string `query:"q" maxLength:"100" doc:"Matches file names and captions"`
			Before   string `query:"before" doc:"next_cursor from the previous page"`
			Limit    int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body *FilesPage }, error) {
			me := auth.Current(ctx).User.ID
			if !s.searchLimit.Allow(me.String()) {
				return nil, httpx.RateLimited()
			}
			if in.Gallery == "" && in.Channel == "" {
				return nil, httpx.BadRequest("SCOPE_REQUIRED", "pass gallery or channel")
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
			if in.Gallery != "" {
				g, err := httpx.ParseID(in.Gallery, "channel")
				if err != nil {
					return nil, err
				}
				fq.Gallery = &g
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
