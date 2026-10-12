// Package albums is personal, shareable collections of files: channel files
// picked into an album, and files uploaded straight into one (spec: albums).
package albums

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
)

const (
	maxAlbums        = 100
	maxItems         = 5000
	maxCollaborators = 25
)

const (
	RoleOwner        = "owner"
	RoleCollaborator = "collaborator"
	RoleViewer       = "viewer"
)

// Album is an album as a caller sees it.
type Album struct {
	ID         id.ID             `json:"id"`
	Title      string            `json:"title"`
	Visibility string            `json:"visibility" enum:"private,server"`
	OwnerID    id.ID             `json:"owner_id"`
	MemberIDs  []id.ID           `json:"member_ids" doc:"Collaborators"`
	ItemCount  int               `json:"item_count" doc:"Every item, including files you cannot see"`
	Cover      *files.Attachment `json:"cover,omitempty" doc:"The newest image you can see; absent in events"`
	CreatedAt  time.Time         `json:"created_at"`
	UpdatedAt  time.Time         `json:"updated_at"`
	Role       string            `json:"role,omitempty" enum:"owner,collaborator,viewer" doc:"Yours"`
	Contains   *bool             `json:"contains,omitempty" doc:"With contains=: whether the file is in it"`
}

// AlbumDeleted is the ALBUM_DELETE event.
type AlbumDeleted struct {
	ID id.ID `json:"id"`
}

// ItemsChanged is the ALBUM_ITEMS_UPDATE event: refetch the album's files.
type ItemsChanged struct {
	AlbumID id.ID `json:"album_id"`
}

type AlbumCreate struct {
	Title      string `json:"title" minLength:"1" maxLength:"100"`
	Visibility string `json:"visibility" enum:"private,server"`
}

type AlbumUpdate struct {
	Title      *string `json:"title,omitempty" minLength:"1" maxLength:"100"`
	Visibility *string `json:"visibility,omitempty" enum:"private,server"`
}

type Channels interface {
	Readable(ctx context.Context, userID id.ID) ([]id.ID, error)
}

type Members interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
	ServerID(ctx context.Context) (id.ID, error)
}

type Files interface {
	ForIDs(ctx context.Context, ids []id.ID) (map[id.ID]files.Attachment, error)
	RemoveBlobs(ctx context.Context, sums []string) error
}

type Messages interface {
	FileItems(ctx context.Context, hits []messages.FileHit) ([]messages.FileItem, error)
}

type Service struct {
	db       *pgxpool.Pool
	bus      *events.Bus
	channels Channels
	members  Members
	files    Files
	messages Messages
}

func NewService(pool *pgxpool.Pool, bus *events.Bus, ch Channels, m Members, fs Files, msgs Messages) *Service {
	return &Service{db: pool, bus: bus, channels: ch, members: m, files: fs, messages: msgs}
}

// row is an album's stored fields.
type row struct {
	id         id.ID
	ownerID    id.ID
	title      string
	visibility string
	updatedAt  time.Time
	memberIDs  []id.ID
}

func (r *row) has(userID id.ID) bool {
	for _, m := range r.memberIDs {
		if m == userID {
			return true
		}
	}
	return false
}

const rowCols = `a.id, a.owner_id, a.title, a.visibility, a.updated_at,
	ARRAY(SELECT m.user_id FROM album_members m WHERE m.album_id = a.id ORDER BY m.user_id)`

func scanRow(r pgx.Row) (*row, error) {
	var a row
	var members []int64
	if err := r.Scan(&a.id, &a.ownerID, &a.title, &a.visibility, &a.updatedAt, &members); err != nil {
		return nil, err
	}
	for _, m := range members {
		a.memberIDs = append(a.memberIDs, id.ID(m))
	}
	return &a, nil
}

// base is the caller's server-wide permissions; 0 means not a member (or gated), who sees no albums.
func (s *Service) base(ctx context.Context, userID id.ID) (perms.Perms, error) {
	return s.members.BasePerms(ctx, userID)
}

// access loads an album the caller can see and says how: owner, collaborator or viewer.
// Anything else is 404, so private albums don't reveal that they exist.
func (s *Service) access(ctx context.Context, userID, albumID id.ID) (*row, string, error) {
	p, err := s.base(ctx, userID)
	if err != nil {
		return nil, "", err
	}
	a, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && p == 0) {
		return nil, "", httpx.NotFound("album")
	}
	if err != nil {
		return nil, "", err
	}
	switch {
	case a.ownerID == userID:
		return a, RoleOwner, nil
	case a.has(userID):
		return a, RoleCollaborator, nil
	case a.visibility == "server":
		return a, RoleViewer, nil
	}
	return nil, "", httpx.NotFound("album")
}

// editable is access for adding and removing files: the owner or a collaborator.
func (s *Service) editable(ctx context.Context, userID, albumID id.ID) (*row, string, error) {
	a, role, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, "", err
	}
	if role == RoleViewer {
		return nil, "", httpx.MissingPermission()
	}
	return a, role, nil
}

// owned is access for settings: only the owner.
func (s *Service) owned(ctx context.Context, userID, albumID id.ID) (*row, error) {
	a, role, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	if role != RoleOwner {
		return nil, httpx.MissingPermission()
	}
	return a, nil
}

// CanView implements files.Albums: may userID download the album's uploads?
func (s *Service) CanView(ctx context.Context, userID, albumID id.ID) (bool, error) {
	_, _, err := s.access(ctx, userID, albumID)
	var he *httpx.Error
	if errors.As(err, &he) {
		return false, nil
	}
	return err == nil, err
}

// CheckUpload implements files.Albums: the owner or a collaborator with AttachFiles server-wide,
// while the album has room.
func (s *Service) CheckUpload(ctx context.Context, userID, albumID id.ID) error {
	if _, _, err := s.editable(ctx, userID, albumID); err != nil {
		return err
	}
	p, err := s.base(ctx, userID)
	if err != nil {
		return err
	}
	if !p.Has(perms.AttachFiles) {
		return httpx.MissingPermission()
	}
	return s.checkRoom(ctx, albumID)
}

func (s *Service) checkRoom(ctx context.Context, albumID id.ID) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM album_items WHERE album_id = $1`, albumID).Scan(&n); err != nil {
		return err
	}
	if n >= maxItems {
		return httpx.BadRequest("ALBUM_FULL", fmt.Sprintf("the album has the most files it can hold (%d)", maxItems))
	}
	return nil
}

// readableSQL is the condition "the caller may see attachment t", with $sc the caller's
// readable channels: an upload into this album, or a sent file in a readable channel or its thread.
const readableSQL = `(t.album_id = a.id OR (t.message_id IS NOT NULL AND (t.channel_id = ANY(%[1]s)
	OR EXISTS (SELECT 1 FROM channels c WHERE c.id = t.channel_id AND c.type = 'thread' AND c.parent_channel_id = ANY(%[1]s)))))`

// list returns the albums userID can see, most recently changed first; with contains set, each says
// whether that attachment is in it.
func (s *Service) list(ctx context.Context, userID id.ID, contains *id.ID) ([]Album, error) {
	out := []Album{}
	p, err := s.base(ctx, userID)
	if err != nil || p == 0 {
		return out, err
	}
	scope, err := s.channels.Readable(ctx, userID)
	if err != nil {
		return nil, err
	}
	var containsArg *int64
	if contains != nil {
		c := int64(*contains)
		containsArg = &c
	}
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+`,
		(SELECT count(*) FROM album_items i WHERE i.album_id = a.id),
		(SELECT t.id FROM album_items i JOIN attachments t ON t.id = i.attachment_id
			WHERE i.album_id = a.id AND t.inline AND `+fmt.Sprintf(readableSQL, "$2")+` ORDER BY t.id DESC LIMIT 1),
		$3::bigint IS NOT NULL AND EXISTS (SELECT 1 FROM album_items i WHERE i.album_id = a.id AND i.attachment_id = $3)
		FROM albums a
		WHERE a.visibility = 'server' OR a.owner_id = $1
			OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = $1)
		ORDER BY a.updated_at DESC, a.id DESC`, userID, id.Int64s(scope), containsArg)
	if err != nil {
		return nil, err
	}
	type listed struct {
		row
		count int
		cover *int64
		has   bool
	}
	var got []listed
	for rows.Next() {
		var l listed
		var members []int64
		if err := rows.Scan(&l.id, &l.ownerID, &l.title, &l.visibility, &l.updatedAt, &members, &l.count, &l.cover, &l.has); err != nil {
			rows.Close()
			return nil, err
		}
		for _, m := range members {
			l.memberIDs = append(l.memberIDs, id.ID(m))
		}
		got = append(got, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var coverIDs []id.ID
	for _, l := range got {
		if l.cover != nil {
			coverIDs = append(coverIDs, id.ID(*l.cover))
		}
	}
	covers, err := s.files.ForIDs(ctx, coverIDs)
	if err != nil {
		return nil, err
	}
	for _, l := range got {
		a := toAlbum(&l.row, l.count, roleOf(&l.row, userID))
		if l.cover != nil {
			if c, ok := covers[id.ID(*l.cover)]; ok {
				a.Cover = &c
			}
		}
		if contains != nil {
			has := l.has
			a.Contains = &has
		}
		out = append(out, a)
	}
	return out, nil
}

func roleOf(r *row, userID id.ID) string {
	switch {
	case r.ownerID == userID:
		return RoleOwner
	case r.has(userID):
		return RoleCollaborator
	}
	return RoleViewer
}

func toAlbum(r *row, count int, role string) Album {
	members := r.memberIDs
	if members == nil {
		members = []id.ID{}
	}
	return Album{ID: r.id, Title: r.title, Visibility: r.visibility, OwnerID: r.ownerID, MemberIDs: members,
		ItemCount: count, CreatedAt: r.id.Time(), UpdatedAt: r.updatedAt, Role: role}
}

// get is one album as the caller sees it.
func (s *Service) get(ctx context.Context, userID, albumID id.ID) (*Album, error) {
	if _, _, err := s.access(ctx, userID, albumID); err != nil {
		return nil, err
	}
	all, err := s.list(ctx, userID, nil)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == albumID {
			return &all[i], nil
		}
	}
	return nil, httpx.NotFound("album")
}

func blankTitle() error { return httpx.BadRequest("VALIDATION_FAILED", "title must not be blank") }

func (s *Service) create(ctx context.Context, userID id.ID, in AlbumCreate) (*Album, error) {
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return nil, blankTitle()
	}
	p, err := s.base(ctx, userID)
	if err != nil {
		return nil, err
	}
	if p == 0 {
		return nil, httpx.MissingPermission()
	}
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM albums WHERE owner_id = $1`, userID).Scan(&n); err != nil {
		return nil, err
	}
	if n >= maxAlbums {
		return nil, httpx.BadRequest("ALBUMS_FULL", fmt.Sprintf("you have the most albums you can have (%d)", maxAlbums))
	}
	aid := id.New()
	if _, err := s.db.Exec(ctx, `INSERT INTO albums (id, owner_id, title, visibility) VALUES ($1, $2, $3, $4)`,
		aid, userID, in.Title, in.Visibility); err != nil {
		return nil, err
	}
	a, err := s.get(ctx, userID, aid)
	if err != nil {
		return nil, err
	}
	s.publishUpdate(ctx, a, nil)
	return a, nil
}

func (s *Service) update(ctx context.Context, userID, albumID id.ID, in AlbumUpdate) (*Album, error) {
	if in.Title != nil {
		t := strings.TrimSpace(*in.Title)
		if t == "" {
			return nil, blankTitle()
		}
		in.Title = &t
	}
	before, err := s.owned(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(ctx, `UPDATE albums SET title = coalesce($2, title), visibility = coalesce($3, visibility), updated_at = now()
		WHERE id = $1`, albumID, in.Title, in.Visibility); err != nil {
		return nil, err
	}
	a, err := s.get(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	s.publishUpdate(ctx, a, before)
	return a, nil
}

// remove deletes an album and its uploads: by its owner, or a server-visible one by a moderator.
func (s *Service) remove(ctx context.Context, userID, albumID id.ID) error {
	a, role, err := s.access(ctx, userID, albumID)
	if err != nil {
		return err
	}
	moderating := false
	if role != RoleOwner {
		p, err := s.base(ctx, userID)
		if err != nil {
			return err
		}
		if a.visibility != "server" || !p.Has(perms.ManageMessages) {
			return httpx.MissingPermission()
		}
		moderating = true
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT sha256, coalesce(thumb_sha256, '') FROM attachments WHERE album_id = $1`, albumID)
	if err != nil {
		return err
	}
	var sums []string
	for rows.Next() {
		var sum, thumb string
		if err := rows.Scan(&sum, &thumb); err != nil {
			rows.Close()
			return err
		}
		sums = append(sums, sum)
		if thumb != "" {
			sums = append(sums, thumb)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM albums WHERE id = $1`, albumID); err != nil { // cascades to members, items, uploads
		return err
	}
	if moderating {
		if err := audit.Record(ctx, tx, audit.AlbumDelete, albumID, audit.LogDetails{Name: a.title}); err != nil {
			return err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	s.publishDelete(ctx, a)
	return s.files.RemoveBlobs(ctx, sums)
}

// addMember makes a server member a collaborator (owner only).
func (s *Service) addMember(ctx context.Context, userID, albumID, memberID id.ID) error {
	a, err := s.owned(ctx, userID, albumID)
	if err != nil {
		return err
	}
	if memberID == a.ownerID || a.has(memberID) {
		return nil
	}
	if p, err := s.base(ctx, memberID); err != nil {
		return err
	} else if p == 0 {
		return httpx.NotFound("member")
	}
	if len(a.memberIDs) >= maxCollaborators {
		return httpx.BadRequest("COLLABORATORS_FULL", fmt.Sprintf("an album has at most %d collaborators", maxCollaborators))
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO album_members (album_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, albumID, memberID); err != nil {
		return err
	}
	return s.touchAndPublish(ctx, albumID, a)
}

// removeMember: the owner removes a collaborator, or a collaborator leaves.
func (s *Service) removeMember(ctx context.Context, userID, albumID, memberID id.ID) error {
	a, role, err := s.access(ctx, userID, albumID)
	if err != nil {
		return err
	}
	if role != RoleOwner && userID != memberID {
		return httpx.MissingPermission()
	}
	tag, err := s.db.Exec(ctx, `DELETE FROM album_members WHERE album_id = $1 AND user_id = $2`, albumID, memberID)
	if err != nil || tag.RowsAffected() == 0 {
		return err
	}
	return s.touchAndPublish(ctx, albumID, a)
}

// touchAndPublish bumps the album and announces it from its stored row, so it doesn't depend on
// any viewer's access (the caller may just have left a private album).
func (s *Service) touchAndPublish(ctx context.Context, albumID id.ID, before *row) error {
	if _, err := s.db.Exec(ctx, `UPDATE albums SET updated_at = now() WHERE id = $1`, albumID); err != nil {
		return err
	}
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if err != nil {
		return err
	}
	var count int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM album_items WHERE album_id = $1`, albumID).Scan(&count); err != nil {
		return err
	}
	a := toAlbum(r, count, "")
	s.publishUpdate(ctx, &a, before)
	return nil
}

// audience is who hears about an album: the whole server, or its owner and collaborators.
func (s *Service) audience(ctx context.Context, visibility string, ownerID id.ID, memberIDs []id.ID) events.Scope {
	if visibility == "server" {
		if sid, err := s.members.ServerID(ctx); err == nil {
			return events.Scope{CommunityID: sid}
		}
	}
	// Only people still on the server: a kicked collaborator hears nothing.
	users := []id.ID{}
	for _, u := range append([]id.ID{ownerID}, memberIDs...) {
		if p, err := s.base(ctx, u); err == nil && p != 0 {
			users = append(users, u)
		}
	}
	return events.Scope{UserIDs: users}
}

// publishUpdate sends ALBUM_UPDATE to its audience, and ALBUM_DELETE to anyone who could see it
// before (before may be nil) and no longer can.
func (s *Service) publishUpdate(ctx context.Context, a *Album, before *row) {
	if before != nil {
		lost := []id.ID{}
		for _, m := range before.memberIDs {
			if !contains(a.MemberIDs, m) {
				lost = append(lost, m)
			}
		}
		switch {
		case before.visibility == "server" && a.Visibility == "private":
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: s.audience(ctx, "server", a.OwnerID, nil)})
		case a.Visibility == "private" && len(lost) > 0:
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: events.Scope{UserIDs: lost}})
		}
	}
	shown := *a
	shown.Role, shown.Contains, shown.Cover = "", nil, nil
	s.bus.Publish(events.Event{Type: "ALBUM_UPDATE", Data: shown, Scope: s.audience(ctx, a.Visibility, a.OwnerID, a.MemberIDs)})
}

func (s *Service) publishDelete(ctx context.Context, r *row) {
	s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: r.id}, Scope: s.audience(ctx, r.visibility, r.ownerID, r.memberIDs)})
}

func (s *Service) publishItems(ctx context.Context, albumID id.ID) {
	var visibility string
	var ownerID id.ID
	var members []int64
	err := s.db.QueryRow(ctx, `SELECT a.visibility, a.owner_id, ARRAY(SELECT user_id FROM album_members WHERE album_id = a.id)
		FROM albums a WHERE a.id = $1`, albumID).Scan(&visibility, &ownerID, &members)
	if err != nil {
		return
	}
	ids := make([]id.ID, len(members))
	for i, m := range members {
		ids[i] = id.ID(m)
	}
	s.bus.Publish(events.Event{Type: "ALBUM_ITEMS_UPDATE", Data: ItemsChanged{AlbumID: albumID}, Scope: s.audience(ctx, visibility, ownerID, ids)})
}

func contains(ids []id.ID, x id.ID) bool {
	for _, v := range ids {
		if v == x {
			return true
		}
	}
	return false
}
