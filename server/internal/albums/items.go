package albums

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

var fileKinds = map[string]bool{"image": true, "video": true, "audio": true, "document": true, "archive": true, "other": true}

type filesQuery struct {
	kinds    []string
	uploader *id.ID
	text     string
	before   *id.ID
	limit    int
}

// listFiles lists an album's files its gallery shows the caller, newest upload first.
func (s *Service) listFiles(ctx context.Context, userID, albumID id.ID, fq filesQuery) (*messages.FilesPage, error) {
	_, _, sc, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	var args []any
	add := func(v any) string {
		args = append(args, v)
		return "$" + strconv.Itoa(len(args))
	}
	// Attachments are aliased a, as messages.KindSQL expects.
	conds := []string{"i.album_id = " + add(albumID), "a.expired_at IS NULL", "NOT m.deleted", fmt.Sprintf(inScopeSQL, "a", add(id.Int64s(sc)))}
	if len(fq.kinds) > 0 {
		conds = append(conds, messages.KindSQL+" = ANY("+add(fq.kinds)+")")
	}
	if fq.uploader != nil {
		conds = append(conds, "a.uploader_id = "+add(*fq.uploader))
	}
	if fq.text != "" {
		p := add(fq.text)
		conds = append(conds, "(a.filename ILIKE '%' || "+add(likeEscaper.Replace(fq.text))+" || '%'"+
			" OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', "+p+"))")
	}
	if fq.before != nil {
		conds = append(conds, "a.id < "+add(*fq.before))
	}
	rows, err := s.db.Query(ctx, `SELECT a.id, `+messages.KindSQL+`
		FROM album_items i JOIN attachments a ON a.id = i.attachment_id
		JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = a.channel_id
		WHERE `+strings.Join(conds, " AND ")+` ORDER BY a.id DESC LIMIT `+add(fq.limit+1), args...)
	if err != nil {
		return nil, err
	}
	var hits []messages.FileHit
	for rows.Next() {
		var h messages.FileHit
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
	page := &messages.FilesPage{Items: []messages.FileItem{}}
	if len(hits) > fq.limit {
		hits = hits[:fq.limit]
		next := hits[len(hits)-1].AttachmentID
		page.NextCursor = &next
	}
	if page.Items, err = s.messages.FileItems(ctx, hits); err != nil {
		return nil, err
	}
	return page, nil
}

// add puts a file the album's gallery shows the caller into the album. A file the caller can read
// elsewhere is NOT_IN_GALLERY; one they can't read (or unsent) is a missing attachment.
func (s *Service) add(ctx context.Context, userID, albumID, attachmentID id.ID) error {
	_, sc, err := s.editable(ctx, userID, albumID)
	if err != nil {
		return err
	}
	ok, err := s.inScope(ctx, attachmentID, sc)
	if err != nil {
		return err
	}
	if !ok {
		readable, err := s.channels.Readable(ctx, userID)
		if err != nil {
			return err
		}
		if elsewhere, err := s.inScope(ctx, attachmentID, readable); err != nil {
			return err
		} else if elsewhere {
			return httpx.BadRequest("NOT_IN_GALLERY", "that file isn't in this album's gallery")
		}
		return httpx.NotFound("attachment")
	}
	if err := s.checkRoom(ctx, albumID); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `INSERT INTO album_items (album_id, attachment_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
		albumID, attachmentID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() > 0 {
		s.itemsChanged(ctx, albumID)
	}
	return nil
}

// take removes an item from the album; the file stays where it was posted.
func (s *Service) take(ctx context.Context, userID, albumID, attachmentID id.ID) error {
	if _, _, err := s.editable(ctx, userID, albumID); err != nil {
		return err
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM album_items WHERE album_id = $1 AND attachment_id = $2`, albumID, attachmentID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("attachment")
	}
	s.itemsChanged(ctx, albumID)
	return nil
}

func (s *Service) itemsChanged(ctx context.Context, albumID id.ID) {
	_, _ = s.db.Exec(ctx, `UPDATE albums SET updated_at = now() WHERE id = $1`, albumID)
	s.publishItems(ctx, albumID)
}

func registerItems(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, me func(context.Context) id.ID) {
	huma.Register(api, op("list-album-files", http.MethodGet, "/api/albums/{albumID}/files", 0),
		func(ctx context.Context, in *struct {
			AlbumID  string `path:"albumID"`
			Kind     string `query:"kind" doc:"Comma-separated: image, video, audio, document, archive, other"`
			Uploader string `query:"uploader"`
			Q        string `query:"q" maxLength:"100" doc:"Matches file names and captions"`
			Before   string `query:"before" doc:"next_cursor from the previous page"`
			Limit    int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body *messages.FilesPage }, error) {
			aid, err := httpx.ParseID(in.AlbumID, "album")
			if err != nil {
				return nil, err
			}
			fq := filesQuery{text: strings.TrimSpace(in.Q), limit: min(max(in.Limit, 1), 100)}
			if in.Kind != "" {
				for _, k := range strings.Split(in.Kind, ",") {
					k = strings.TrimSpace(k)
					if !fileKinds[k] {
						return nil, httpx.BadRequest("VALIDATION_FAILED", "kind must be image, video, audio, document, archive or other")
					}
					fq.kinds = append(fq.kinds, k)
				}
			}
			if in.Uploader != "" {
				u, err := httpx.ParseID(in.Uploader, "user")
				if err != nil {
					return nil, err
				}
				fq.uploader = &u
			}
			if in.Before != "" {
				b, err := httpx.ParseID(in.Before, "attachment")
				if err != nil {
					return nil, err
				}
				fq.before = &b
			}
			p, err := s.listFiles(ctx, me(ctx), aid, fq)
			return &struct{ Body *messages.FilesPage }{p}, err
		})

	type itemPath struct {
		AlbumID      string `path:"albumID"`
		AttachmentID string `path:"attachmentID"`
	}
	ids := func(in *itemPath) (id.ID, id.ID, error) {
		aid, err := httpx.ParseID(in.AlbumID, "album")
		if err != nil {
			return 0, 0, err
		}
		att, err := httpx.ParseID(in.AttachmentID, "attachment")
		return aid, att, err
	}
	huma.Register(api, op("add-album-file", http.MethodPut, "/api/albums/{albumID}/files/{attachmentID}", http.StatusNoContent),
		func(ctx context.Context, in *itemPath) (*struct{}, error) {
			aid, att, err := ids(in)
			if err != nil {
				return nil, err
			}
			return nil, s.add(ctx, me(ctx), aid, att)
		})
	huma.Register(api, op("remove-album-file", http.MethodDelete, "/api/albums/{albumID}/files/{attachmentID}", http.StatusNoContent),
		func(ctx context.Context, in *itemPath) (*struct{}, error) {
			aid, att, err := ids(in)
			if err != nil {
				return nil, err
			}
			return nil, s.take(ctx, me(ctx), aid, att)
		})
}
