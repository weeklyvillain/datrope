package music

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// MusicPlaylist is a saved playlist, as listed.
type MusicPlaylist struct {
	ID        id.ID     `json:"id"`
	Title     string    `json:"title"`
	CreatedBy *id.ID    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Count     int       `json:"count" doc:"Number of tracks"`
	Duration  int       `json:"duration" doc:"Total seconds of the tracks of known length"`
	Cover     string    `json:"cover,omitempty" doc:"The first track's cover image, when it has one"`
}

// PlaylistItem is one track of a saved playlist.
type PlaylistItem struct {
	ID           id.ID  `json:"id"`
	Title        string `json:"title"`
	Artist       string `json:"artist,omitempty"`
	Duration     int    `json:"duration" doc:"Seconds; 0 when unknown"`
	Source       string `json:"source" enum:"link,upload,file"`
	Site         string `json:"site,omitempty"`
	URL          string `json:"url,omitempty"`
	Cover        string `json:"cover,omitempty"`
	TrackID      *id.ID `json:"track_id,omitempty" doc:"The library track, for uploads"`
	AttachmentID *id.ID `json:"attachment_id,omitempty" doc:"The channel file, for files"`
	ChannelID    *id.ID `json:"channel_id,omitempty" doc:"Where the file was posted (a thread's parent)"`
	AddedBy      *id.ID `json:"added_by,omitempty"`

	search   string
	blob     string
	opus     bool
	coverSum string
}

// PlaylistDetail is a playlist with its tracks, in order.
type PlaylistDetail struct {
	MusicPlaylist
	Items  []PlaylistItem `json:"items"`
	Hidden int            `json:"hidden" doc:"Files left out because you cannot read their channel"`
}

// PlaylistDeleted is the MUSIC_PLAYLIST_DELETE event.
type PlaylistDeleted struct {
	ID id.ID `json:"id"`
}

type PlaylistCreate struct {
	Title   string `json:"title,omitempty" maxLength:"100" doc:"Defaults to the imported playlist's title"`
	FromURL string `json:"from_url,omitempty" maxLength:"500" doc:"A playlist link (YouTube, SoundCloud, Bandcamp, Spotify ...) to import"`
}

type PlaylistRename struct {
	Title string `json:"title" minLength:"1" maxLength:"100"`
}

type PlaylistAdd struct {
	Query        string `json:"query,omitempty" maxLength:"500" doc:"A link or YouTube search words"`
	Playlist     bool   `json:"playlist,omitempty" doc:"With a link: add every track of the playlist it is in"`
	TrackID      *id.ID `json:"track_id,omitempty" doc:"A library track"`
	AttachmentID *id.ID `json:"attachment_id,omitempty" doc:"An audio file posted in a channel you can read"`
	FromChannel  *id.ID `json:"from_channel,omitempty" doc:"A voice channel: add what plays there and its queue"`
}

type PlaylistAddResult struct {
	Added   int `json:"added"`
	Skipped int `json:"skipped" doc:"Tracks that did not fit (a playlist holds at most 500)"`
	Dropped int `json:"dropped" doc:"Entries of an imported playlist that are private, deleted or cannot be played"`
}

type PlaylistMove struct {
	Position int `json:"position" minimum:"0" doc:"The new place, counting from 0"`
}

const (
	maxPlaylists     = 100
	maxPlaylistItems = 500
)

func (it PlaylistItem) track() MusicTrack {
	t := MusicTrack{Title: it.Title, Artist: it.Artist, Duration: it.Duration, Source: it.Source, Site: it.Site, URL: it.URL,
		Cover: it.Cover, blob: it.blob, opus: it.opus, search: it.search, coverSum: it.coverSum}
	if it.TrackID != nil {
		t.libraryID = *it.TrackID
	}
	if it.AttachmentID != nil {
		t.attachmentID = *it.AttachmentID
	}
	return t
}

const playlistCols = `p.id, p.title, p.created_by,
	(SELECT count(*) FROM music_playlist_items i WHERE i.playlist_id = p.id),
	(SELECT coalesce(sum(i.duration), 0) FROM music_playlist_items i WHERE i.playlist_id = p.id),
	coalesce((SELECT coalesce(i.cover, t.cover) FROM music_playlist_items i LEFT JOIN music_tracks t ON t.id = i.track_id
		WHERE i.playlist_id = p.id ORDER BY i.position LIMIT 1), '')`

func scanPlaylist(row pgx.Row) (MusicPlaylist, error) {
	var pl MusicPlaylist
	var by *int64
	var cover string
	err := row.Scan(&pl.ID, &pl.Title, &by, &pl.Count, &pl.Duration, &cover)
	pl.CreatedBy = id.FromNullable(by)
	pl.CreatedAt = pl.ID.Time()
	pl.Cover = coverPath(cover)
	return pl, err
}

func (s *Service) playlist(ctx context.Context, pid id.ID) (MusicPlaylist, error) {
	pl, err := scanPlaylist(s.db.QueryRow(ctx, `SELECT `+playlistCols+` FROM music_playlists p WHERE p.id = $1`, pid))
	if errors.Is(err, pgx.ErrNoRows) {
		return pl, httpx.NotFound("playlist")
	}
	return pl, err
}

const itemCols = `i.id, i.title, coalesce(nullif(i.artist, ''), t.artist, ''), i.duration, i.site, coalesce(i.url, ''),
	coalesce(i.search, ''), i.track_id, i.attachment_id, i.added_by, coalesce(t.sha256, a.sha256, ''), coalesce(t.format, ''),
	coalesce(i.cover, t.cover, ''), CASE WHEN ac.type = 'thread' THEN ac.parent_channel_id ELSE a.channel_id END`

const itemJoins = ` FROM music_playlist_items i LEFT JOIN music_tracks t ON t.id = i.track_id
	LEFT JOIN attachments a ON a.id = i.attachment_id LEFT JOIN channels ac ON ac.id = a.channel_id`

// playlistItems lists a playlist's tracks in order, leaving out the channel files the
// signed-in user cannot read (hidden counts them).
func (s *Service) playlistItems(ctx context.Context, pid id.ID) ([]PlaylistItem, int, error) {
	if _, err := s.playlist(ctx, pid); err != nil {
		return nil, 0, err
	}
	readable, err := s.channels.Readable(ctx, auth.Current(ctx).User.ID)
	if err != nil {
		return nil, 0, err
	}
	canRead := make(map[id.ID]bool, len(readable))
	for _, c := range readable {
		canRead[c] = true
	}
	rows, err := s.db.Query(ctx, `SELECT `+itemCols+itemJoins+` WHERE i.playlist_id = $1 ORDER BY i.position`, pid)
	if err != nil {
		return nil, 0, err
	}
	all, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (PlaylistItem, error) {
		var it PlaylistItem
		var track, att, by, ch *int64
		var format string
		err := r.Scan(&it.ID, &it.Title, &it.Artist, &it.Duration, &it.Site, &it.URL, &it.search, &track, &att, &by,
			&it.blob, &format, &it.coverSum, &ch)
		it.TrackID, it.AttachmentID, it.AddedBy, it.ChannelID = id.FromNullable(track), id.FromNullable(att), id.FromNullable(by), id.FromNullable(ch)
		it.opus = format == "opus"
		switch {
		case it.AttachmentID != nil:
			it.Source = "file"
		case it.TrackID != nil:
			it.Source = "upload"
		default:
			it.Source = "link"
		}
		it.Cover = coverPath(it.coverSum)
		return it, err
	})
	if err != nil {
		return nil, 0, err
	}
	items := []PlaylistItem{}
	hidden := 0
	for _, it := range all {
		if it.AttachmentID != nil && (it.ChannelID == nil || !canRead[*it.ChannelID]) {
			hidden++
			continue
		}
		items = append(items, it)
	}
	return items, hidden, nil
}

// publishPlaylist tells the server's members a playlist changed.
func (s *Service) publishPlaylist(ctx context.Context, pid id.ID) {
	pl, err := s.playlist(ctx, pid)
	if err != nil {
		return
	}
	sid, err := s.community.ServerID(ctx)
	if err != nil {
		return
	}
	s.bus.Publish(events.Event{Type: "MUSIC_PLAYLIST_UPDATE", Data: pl, Scope: events.Scope{CommunityID: sid}})
}

// renumber closes the gaps left in a playlist's positions (deleted tracks).
func (s *Service) renumber(ctx context.Context, pid id.ID) {
	_, _ = s.db.Exec(ctx, `UPDATE music_playlist_items i SET position = v.n - 1
		FROM (SELECT id, row_number() OVER (ORDER BY position) AS n FROM music_playlist_items WHERE playlist_id = $1) v
		WHERE i.id = v.id AND i.position <> v.n - 1`, pid)
}

// canEdit: the playlist's creator, or someone who manages expressions.
func (s *Service) canEdit(ctx context.Context, pl MusicPlaylist) error {
	p, err := s.member(ctx)
	if err != nil {
		return err
	}
	mine := pl.CreatedBy != nil && *pl.CreatedBy == auth.Current(ctx).User.ID
	if !mine && !p.Has(perms.ManageExpressions) {
		return httpx.MissingPermission()
	}
	return nil
}

// insertItems appends tracks to a playlist, as many as fit, and starts
// downloading the links' thumbnails as covers.
func (s *Service) insertItems(ctx context.Context, pid id.ID, tracks []MusicTrack) (added int, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var next int
	// Lock the playlist so concurrent adds don't take the same positions.
	if err := tx.QueryRow(ctx, `SELECT 1 FROM music_playlists WHERE id = $1 FOR UPDATE`, pid).Scan(new(int)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, httpx.NotFound("playlist")
		}
		return 0, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM music_playlist_items WHERE playlist_id = $1`, pid).Scan(&next); err != nil {
		return 0, err
	}
	tracks = tracks[:min(len(tracks), maxPlaylistItems-next)]
	me := auth.Current(ctx).User.ID
	var thumbs []pendingThumb
	for _, t := range tracks {
		iid := id.New()
		var link, search *string
		var trackID, attID *id.ID
		switch {
		case t.attachmentID != 0:
			attID = &t.attachmentID
		case t.blob != "":
			trackID = &t.libraryID
		case t.URL != "":
			link = &t.URL
		default:
			search = &t.search
		}
		var cover *string // a link saved again (from a playlist, via the queue) keeps its cover
		if t.coverSum != "" && t.blob == "" {
			cover = &t.coverSum
		}
		if _, err := tx.Exec(ctx, `INSERT INTO music_playlist_items (id, playlist_id, position, track_id, attachment_id, url, search, title, artist, duration, site, cover, cover_type, added_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text,
				(SELECT cover_type FROM music_playlist_items WHERE cover = $12::text AND cover_type IS NOT NULL LIMIT 1), $13)`,
			iid, pid, next, trackID, attID, link, search, t.Title, t.Artist, t.Duration, t.Site, cover, me); err != nil {
			return 0, err
		}
		next++
		if t.blob == "" && t.thumb != "" {
			thumbs = append(thumbs, pendingThumb{iid, t.thumb})
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	s.fetchCovers(pid, thumbs)
	return len(tracks), nil
}

type pendingThumb struct {
	item id.ID
	url  string
}

// fetchCovers downloads saved links' thumbnails in the background, a few at
// a time, then tells the playlist's viewers.
func (s *Service) fetchCovers(pid id.ID, thumbs []pendingThumb) {
	if len(thumbs) == 0 || s.blobs == nil {
		return
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		ctx := s.ctx
		work := make(chan pendingThumb)
		var wg sync.WaitGroup
		for range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for th := range work {
					s.fetchCover(ctx, th)
				}
			}()
		}
		for _, th := range thumbs {
			select {
			case work <- th:
			case <-ctx.Done():
			}
		}
		close(work)
		wg.Wait()
		if ctx.Err() == nil {
			s.publishPlaylist(ctx, pid)
		}
	}()
}

func (s *Service) fetchCover(ctx context.Context, th pendingThumb) {
	data, err := fetchThumb(ctx, th.url)
	if err != nil {
		return
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data)
	if err != nil {
		return
	}
	if _, err := tx.Exec(ctx, `UPDATE music_playlist_items SET cover = $2, cover_type = $3 WHERE id = $1`, th.item, sum, ct); err != nil {
		return
	}
	_ = tx.Commit(ctx)
}

// coversOf are the cover blobs of a playlist's items (to release when they go).
func (s *Service) coversOf(ctx context.Context, where string, arg any) []string {
	rows, err := s.db.Query(ctx, `SELECT cover FROM music_playlist_items WHERE cover IS NOT NULL AND `+where, arg)
	if err != nil {
		return nil
	}
	sums, _ := pgx.CollectRows(rows, pgx.RowTo[string])
	return sums
}

func registerPlaylists(api huma.API, s *Service, op func(string, string, string, int) huma.Operation,
	voiceChannel func(context.Context, string) (*channels.Channel, error)) {
	type playlistPath struct {
		PlaylistID string `path:"playlistID"`
	}
	// editable loads a playlist the caller may change.
	editable := func(ctx context.Context, raw string) (MusicPlaylist, error) {
		pid, err := httpx.ParseID(raw, "playlist")
		if err != nil {
			return MusicPlaylist{}, err
		}
		pl, err := s.playlist(ctx, pid)
		if err != nil {
			return pl, err
		}
		return pl, s.canEdit(ctx, pl)
	}

	huma.Register(api, op("list-music-playlists", http.MethodGet, "/api/server/music/playlists", 0),
		func(ctx context.Context, _ *struct{}) (*struct{ Body []MusicPlaylist }, error) {
			if _, err := s.member(ctx); err != nil {
				return nil, err
			}
			rows, err := s.db.Query(ctx, `SELECT `+playlistCols+` FROM music_playlists p ORDER BY lower(p.title), p.id`)
			if err != nil {
				return nil, err
			}
			list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (MusicPlaylist, error) { return scanPlaylist(r) })
			if list == nil {
				list = []MusicPlaylist{}
			}
			return &struct{ Body []MusicPlaylist }{list}, err
		})

	huma.Register(api, op("get-music-playlist", http.MethodGet, "/api/server/music/playlists/{playlistID}", 0),
		func(ctx context.Context, in *playlistPath) (*struct{ Body PlaylistDetail }, error) {
			if _, err := s.member(ctx); err != nil {
				return nil, err
			}
			pid, err := httpx.ParseID(in.PlaylistID, "playlist")
			if err != nil {
				return nil, err
			}
			pl, err := s.playlist(ctx, pid)
			if err != nil {
				return nil, err
			}
			items, hidden, err := s.playlistItems(ctx, pid)
			return &struct{ Body PlaylistDetail }{PlaylistDetail{MusicPlaylist: pl, Items: items, Hidden: hidden}}, err
		})

	huma.Register(api, op("create-music-playlist", http.MethodPost, "/api/server/music/playlists", http.StatusCreated),
		func(ctx context.Context, in *struct{ Body PlaylistCreate }) (*struct {
			Body struct {
				PlaylistDetail
				PlaylistAddResult
			}
		}, error) {
			p, err := s.member(ctx)
			if err != nil {
				return nil, err
			}
			if !p.Has(perms.AttachFiles) {
				return nil, httpx.MissingPermission()
			}
			title := clip(in.Body.Title, 100)
			var tracks []MusicTrack
			var res PlaylistAddResult
			if link := strings.TrimSpace(in.Body.FromURL); link != "" {
				if !IsLink(link) {
					return nil, httpx.BadRequest("BAD_QUERY", "from_url must be a link")
				}
				var plTitle string
				tracks, plTitle, res.Dropped, err = s.lookup(ctx, link, true)
				if err != nil {
					return nil, err
				}
				if title == "" {
					title = clip(plTitle, 100)
				}
			}
			if title == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "give the playlist a title")
			}
			var n int
			if err := s.db.QueryRow(ctx, `SELECT count(*) FROM music_playlists`).Scan(&n); err != nil {
				return nil, err
			}
			if n >= maxPlaylists {
				return nil, httpx.BadRequest("PLAYLISTS_FULL", fmt.Sprintf("the server has the most playlists it can hold (%d)", maxPlaylists))
			}
			pid := id.New()
			if _, err := s.db.Exec(ctx, `INSERT INTO music_playlists (id, title, created_by) VALUES ($1, $2, $3)`,
				pid, title, auth.Current(ctx).User.ID); err != nil {
				return nil, err
			}
			if res.Added, err = s.insertItems(ctx, pid, tracks); err != nil {
				return nil, err
			}
			res.Skipped = len(tracks) - res.Added
			pl, err := s.playlist(ctx, pid)
			if err != nil {
				return nil, err
			}
			items, _, err := s.playlistItems(ctx, pid)
			if err != nil {
				return nil, err
			}
			s.publishPlaylist(ctx, pid)
			out := &struct {
				Body struct {
					PlaylistDetail
					PlaylistAddResult
				}
			}{}
			out.Body.PlaylistDetail, out.Body.PlaylistAddResult = PlaylistDetail{MusicPlaylist: pl, Items: items}, res
			return out, nil
		})

	huma.Register(api, op("rename-music-playlist", http.MethodPatch, "/api/server/music/playlists/{playlistID}", 0),
		func(ctx context.Context, in *struct {
			PlaylistID string `path:"playlistID"`
			Body       PlaylistRename
		}) (*struct{ Body MusicPlaylist }, error) {
			pl, err := editable(ctx, in.PlaylistID)
			if err != nil {
				return nil, err
			}
			title := clip(in.Body.Title, 100)
			if title == "" {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "give the playlist a title")
			}
			if _, err := s.db.Exec(ctx, `UPDATE music_playlists SET title = $2 WHERE id = $1`, pl.ID, title); err != nil {
				return nil, err
			}
			pl.Title = title
			s.publishPlaylist(ctx, pl.ID)
			return &struct{ Body MusicPlaylist }{pl}, nil
		})

	huma.Register(api, op("delete-music-playlist", http.MethodDelete, "/api/server/music/playlists/{playlistID}", http.StatusNoContent),
		func(ctx context.Context, in *playlistPath) (*struct{}, error) {
			pl, err := editable(ctx, in.PlaylistID)
			if err != nil {
				return nil, err
			}
			covers := s.coversOf(ctx, "playlist_id = $1", pl.ID)
			if _, err := s.db.Exec(ctx, `DELETE FROM music_playlists WHERE id = $1`, pl.ID); err != nil {
				return nil, err
			}
			_ = s.blobs.RemoveBlobs(ctx, covers)
			if sid, err := s.community.ServerID(ctx); err == nil {
				s.bus.Publish(events.Event{Type: "MUSIC_PLAYLIST_DELETE", Data: PlaylistDeleted{pl.ID}, Scope: events.Scope{CommunityID: sid}})
			}
			return nil, nil
		})

	huma.Register(api, op("add-music-playlist-items", http.MethodPost, "/api/server/music/playlists/{playlistID}/items", http.StatusCreated),
		func(ctx context.Context, in *struct {
			PlaylistID string `path:"playlistID"`
			Body       PlaylistAdd
		}) (*struct{ Body PlaylistAddResult }, error) {
			pl, err := editable(ctx, in.PlaylistID)
			if err != nil {
				return nil, err
			}
			var tracks []MusicTrack
			var res PlaylistAddResult
			query := strings.TrimSpace(in.Body.Query)
			switch {
			case in.Body.TrackID != nil:
				lt, err := s.libraryTrack(ctx, *in.Body.TrackID)
				if err != nil {
					return nil, err
				}
				tracks = []MusicTrack{libraryTrackOf(lt)}
			case in.Body.AttachmentID != nil:
				t, err := s.attachmentTrack(ctx, *in.Body.AttachmentID)
				if err != nil {
					return nil, err
				}
				tracks = []MusicTrack{t}
			case in.Body.FromChannel != nil:
				ch, err := voiceChannel(ctx, in.Body.FromChannel.String())
				if err != nil {
					return nil, err
				}
				st := s.state(ch.ID)
				if st.Current != nil {
					tracks = append(tracks, *st.Current)
				}
				tracks = append(tracks, st.Queue...)
				if len(tracks) == 0 {
					return nil, httpx.BadRequest("NOTHING_PLAYING", "nothing is playing or queued there")
				}
			case query != "":
				tracks, _, res.Dropped, err = s.lookup(ctx, query, in.Body.Playlist)
				if err != nil {
					return nil, err
				}
			default:
				return nil, httpx.BadRequest("VALIDATION_FAILED", "give a query, a track_id, an attachment_id or from_channel")
			}
			if res.Added, err = s.insertItems(ctx, pl.ID, tracks); err != nil {
				return nil, err
			}
			res.Skipped = len(tracks) - res.Added
			if res.Added == 0 && res.Skipped > 0 {
				return nil, httpx.BadRequest("PLAYLIST_FULL", fmt.Sprintf("the playlist is full (%d tracks)", maxPlaylistItems))
			}
			s.publishPlaylist(ctx, pl.ID)
			return &struct{ Body PlaylistAddResult }{res}, nil
		})

	type itemPath struct {
		PlaylistID string `path:"playlistID"`
		ItemID     string `path:"itemID"`
	}
	item := func(ctx context.Context, in itemPath) (MusicPlaylist, id.ID, error) {
		pl, err := editable(ctx, in.PlaylistID)
		if err != nil {
			return pl, 0, err
		}
		iid, err := httpx.ParseID(in.ItemID, "item")
		return pl, iid, err
	}

	huma.Register(api, op("move-music-playlist-item", http.MethodPut, "/api/server/music/playlists/{playlistID}/items/{itemID}/position", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			PlaylistID string `path:"playlistID"`
			ItemID     string `path:"itemID"`
			Body       PlaylistMove
		}) (*struct{}, error) {
			pl, iid, err := item(ctx, itemPath{in.PlaylistID, in.ItemID})
			if err != nil {
				return nil, err
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			rows, err := tx.Query(ctx, `SELECT id FROM music_playlist_items WHERE playlist_id = $1 ORDER BY position FOR UPDATE`, pl.ID)
			if err != nil {
				return nil, err
			}
			order, err := pgx.CollectRows(rows, pgx.RowTo[id.ID])
			if err != nil {
				return nil, err
			}
			from := -1
			for i, x := range order {
				if x == iid {
					from = i
				}
			}
			if from < 0 {
				return nil, httpx.NotFound("item")
			}
			to := min(in.Body.Position, len(order)-1)
			moved := append(append([]id.ID{}, order[:from]...), order[from+1:]...)
			moved = append(moved[:to], append([]id.ID{iid}, moved[to:]...)...)
			if _, err := tx.Exec(ctx, `UPDATE music_playlist_items i SET position = v.n - 1
				FROM unnest($1::bigint[]) WITH ORDINALITY AS v(id, n) WHERE i.id = v.id`, moved); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publishPlaylist(ctx, pl.ID)
			return nil, nil
		})

	huma.Register(api, op("remove-music-playlist-item", http.MethodDelete, "/api/server/music/playlists/{playlistID}/items/{itemID}", http.StatusNoContent),
		func(ctx context.Context, in *itemPath) (*struct{}, error) {
			pl, iid, err := item(ctx, *in)
			if err != nil {
				return nil, err
			}
			covers := s.coversOf(ctx, "id = $1", iid)
			tag, err := s.db.Exec(ctx, `DELETE FROM music_playlist_items WHERE id = $1 AND playlist_id = $2`, iid, pl.ID)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.NotFound("item")
			}
			_ = s.blobs.RemoveBlobs(ctx, covers)
			s.renumber(ctx, pl.ID)
			s.publishPlaylist(ctx, pl.ID)
			return nil, nil
		})
}
