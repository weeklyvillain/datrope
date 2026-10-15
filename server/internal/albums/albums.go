// Package albums is folders of files inside a gallery channel: files its gallery shows, picked into
// an album (spec: gallery sources and wall).
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
	deckSize         = 3
)

const (
	RoleOwner        = "owner"
	RoleCollaborator = "collaborator"
	RoleViewer       = "viewer"
)

// Album is an album as a caller sees it.
type Album struct {
	ID         id.ID              `json:"id"`
	GalleryID  id.ID              `json:"gallery_id"`
	Title      string             `json:"title"`
	Visibility string             `json:"visibility" enum:"private,gallery"`
	OwnerID    id.ID              `json:"owner_id"`
	MemberIDs  []id.ID            `json:"member_ids" doc:"Collaborators"`
	ItemCount  int                `json:"item_count" doc:"Every item, including files you cannot see"`
	Deck       []files.Attachment `json:"deck" doc:"Up to three of the newest images you can see, newest first; empty in events and in contains= listings"`
	CreatedAt  time.Time          `json:"created_at"`
	UpdatedAt  time.Time          `json:"updated_at"`
	Role       string             `json:"role,omitempty" enum:"owner,collaborator,viewer" doc:"Yours"`
	Contains   *bool              `json:"contains,omitempty" doc:"With contains=: whether the file is in it"`
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
	Visibility string `json:"visibility" enum:"private,gallery"`
}

type AlbumUpdate struct {
	Title      *string `json:"title,omitempty" minLength:"1" maxLength:"100"`
	Visibility *string `json:"visibility,omitempty" enum:"private,gallery"`
}

type Channels interface {
	GalleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error)
	Readable(ctx context.Context, userID id.ID) ([]id.ID, error)
}

type Members interface {
	BasePerms(ctx context.Context, userID id.ID) (perms.Perms, error)
}

type Files interface {
	ForIDs(ctx context.Context, ids []id.ID) (map[id.ID]files.Attachment, error)
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
	galleryID  id.ID
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

const rowCols = `a.id, a.gallery_id, a.owner_id, a.title, a.visibility, a.updated_at,
	ARRAY(SELECT m.user_id FROM album_members m WHERE m.album_id = a.id ORDER BY m.user_id)`

func scanRow(r pgx.Row, extra ...any) (*row, error) {
	var a row
	var members []int64
	dest := append([]any{&a.id, &a.galleryID, &a.ownerID, &a.title, &a.visibility, &a.updatedAt, &members}, extra...)
	if err := r.Scan(dest...); err != nil {
		return nil, err
	}
	for _, m := range members {
		a.memberIDs = append(a.memberIDs, id.ID(m))
	}
	return &a, nil
}

// inScopeSQL is "attachment %[1]s was posted in a channel of scope %[2]s, or a thread of one", with
// c joined as its channel.
const inScopeSQL = `(%[1]s.channel_id = ANY(%[2]s) OR (c.type = 'thread' AND c.parent_channel_id = ANY(%[2]s)))`

// galleryScope is the channels a gallery shows userID. Not being a member (or being gated) is a
// missing channel, like a gallery you can't see.
func (s *Service) galleryScope(ctx context.Context, userID, galleryID id.ID) ([]id.ID, error) {
	p, err := s.members.BasePerms(ctx, userID)
	if err != nil {
		return nil, err
	}
	if p == 0 {
		return nil, httpx.NotFound("channel")
	}
	return s.channels.GalleryScope(ctx, userID, galleryID)
}

// access loads an album the caller can see, how (owner, collaborator or viewer) and its gallery's
// scope for them. Anything else is 404, so private albums don't reveal that they exist.
func (s *Service) access(ctx context.Context, userID, albumID id.ID) (*row, string, []id.ID, error) {
	a, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil, httpx.NotFound("album")
	}
	if err != nil {
		return nil, "", nil, err
	}
	sc, err := s.galleryScope(ctx, userID, a.galleryID)
	var he *httpx.Error
	if errors.As(err, &he) {
		return nil, "", nil, httpx.NotFound("album")
	}
	if err != nil {
		return nil, "", nil, err
	}
	switch {
	case a.ownerID == userID:
		return a, RoleOwner, sc, nil
	case a.has(userID):
		return a, RoleCollaborator, sc, nil
	case a.visibility == "gallery":
		return a, RoleViewer, sc, nil
	}
	return nil, "", nil, httpx.NotFound("album")
}

// editable is access for adding and removing files: the owner or a collaborator.
func (s *Service) editable(ctx context.Context, userID, albumID id.ID) (*row, []id.ID, error) {
	a, role, sc, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, nil, err
	}
	if role == RoleViewer {
		return nil, nil, httpx.MissingPermission()
	}
	return a, sc, nil
}

// owned is access for settings: only the owner.
func (s *Service) owned(ctx context.Context, userID, albumID id.ID) (*row, error) {
	a, role, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	if role != RoleOwner {
		return nil, httpx.MissingPermission()
	}
	return a, nil
}

// itemCountSQL counts album a's files that haven't expired, matching what its listing shows.
const itemCountSQL = `(SELECT count(*) FROM album_items i JOIN attachments t ON t.id = i.attachment_id
	WHERE i.album_id = a.id AND t.expired_at IS NULL)`

func (s *Service) checkRoom(ctx context.Context, albumID id.ID) error {
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM album_items i JOIN attachments t ON t.id = i.attachment_id WHERE i.album_id = $1 AND t.expired_at IS NULL`, albumID).Scan(&n); err != nil {
		return err
	}
	if n >= maxItems {
		return httpx.BadRequest("ALBUM_FULL", fmt.Sprintf("the album has the most files it can hold (%d)", maxItems))
	}
	return nil
}

// list returns a gallery's albums userID can see, most recently changed first, each with its deck.
func (s *Service) list(ctx context.Context, userID, galleryID id.ID) ([]Album, error) {
	sc, err := s.galleryScope(ctx, userID, galleryID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+`,
		`+itemCountSQL+`,
		ARRAY(SELECT t.id FROM album_items i JOIN attachments t ON t.id = i.attachment_id
			JOIN messages m ON m.id = t.message_id JOIN channels c ON c.id = t.channel_id
			WHERE i.album_id = a.id AND t.inline AND t.expired_at IS NULL AND NOT m.deleted AND `+fmt.Sprintf(inScopeSQL, "t", "$3")+`
			ORDER BY t.id DESC LIMIT `+fmt.Sprint(deckSize)+`)
		FROM albums a
		WHERE a.gallery_id = $2 AND (a.visibility = 'gallery' OR a.owner_id = $1
			OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = $1))
		ORDER BY a.updated_at DESC, a.id DESC`, userID, galleryID, id.Int64s(sc))
	if err != nil {
		return nil, err
	}
	type listed struct {
		*row
		count int
		deck  []int64
	}
	var got []listed
	for rows.Next() {
		var l listed
		if l.row, err = scanRow(rows, &l.count, &l.deck); err != nil {
			rows.Close()
			return nil, err
		}
		got = append(got, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	var deckIDs []id.ID
	for _, l := range got {
		for _, d := range l.deck {
			deckIDs = append(deckIDs, id.ID(d))
		}
	}
	atts, err := s.files.ForIDs(ctx, deckIDs)
	if err != nil {
		return nil, err
	}
	out := []Album{}
	for _, l := range got {
		a := toAlbum(l.row, l.count, roleOf(l.row, userID))
		for _, d := range l.deck {
			if att, ok := atts[id.ID(d)]; ok {
				a.Deck = append(a.Deck, att)
			}
		}
		out = append(out, a)
	}
	return out, nil
}

// listForFile returns the albums userID can edit whose gallery shows the attachment, each saying
// whether it holds it (no decks).
func (s *Service) listForFile(ctx context.Context, userID, attachmentID id.ID) ([]Album, error) {
	out := []Album{}
	p, err := s.members.BasePerms(ctx, userID)
	if err != nil || p == 0 {
		return out, err
	}
	rows, err := s.db.Query(ctx, `SELECT `+rowCols+`,
		`+itemCountSQL+`,
		EXISTS (SELECT 1 FROM album_items i WHERE i.album_id = a.id AND i.attachment_id = $2)
		FROM albums a
		WHERE a.owner_id = $1 OR EXISTS (SELECT 1 FROM album_members m WHERE m.album_id = a.id AND m.user_id = $1)
		ORDER BY a.updated_at DESC, a.id DESC`, userID, attachmentID)
	if err != nil {
		return nil, err
	}
	type listed struct {
		*row
		count int
		has   bool
	}
	var got []listed
	for rows.Next() {
		var l listed
		if l.row, err = scanRow(rows, &l.count, &l.has); err != nil {
			rows.Close()
			return nil, err
		}
		got = append(got, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	shows := map[id.ID]bool{} // per gallery: does it show the file to userID?
	for _, l := range got {
		ok, seen := shows[l.galleryID]
		if !seen {
			sc, err := s.galleryScope(ctx, userID, l.galleryID)
			var he *httpx.Error
			switch {
			case errors.As(err, &he):
				ok = false
			case err != nil:
				return nil, err
			default:
				if ok, err = s.inScope(ctx, attachmentID, sc); err != nil {
					return nil, err
				}
			}
			shows[l.galleryID] = ok
		}
		if ok {
			a := toAlbum(l.row, l.count, roleOf(l.row, userID))
			has := l.has
			a.Contains = &has
			out = append(out, a)
		}
	}
	return out, nil
}

// inScope says whether a sent, undeleted attachment was posted in scope (or a thread of it).
func (s *Service) inScope(ctx context.Context, attachmentID id.ID, scope []id.ID) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM attachments t JOIN channels c ON c.id = t.channel_id
		JOIN messages m ON m.id = t.message_id
		WHERE t.id = $1 AND t.expired_at IS NULL AND NOT m.deleted AND `+fmt.Sprintf(inScopeSQL, "t", "$2")+`)`,
		attachmentID, id.Int64s(scope)).Scan(&ok)
	return ok, err
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
	return Album{ID: r.id, GalleryID: r.galleryID, Title: r.title, Visibility: r.visibility, OwnerID: r.ownerID, MemberIDs: members,
		ItemCount: count, Deck: []files.Attachment{}, CreatedAt: r.id.Time(), UpdatedAt: r.updatedAt, Role: role}
}

// get is one album as the caller sees it.
func (s *Service) get(ctx context.Context, userID, albumID id.ID) (*Album, error) {
	a, _, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return nil, err
	}
	all, err := s.list(ctx, userID, a.galleryID)
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

func (s *Service) create(ctx context.Context, userID, galleryID id.ID, in AlbumCreate) (*Album, error) {
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		return nil, blankTitle()
	}
	if _, err := s.galleryScope(ctx, userID, galleryID); err != nil {
		return nil, err
	}
	var n int
	if err := s.db.QueryRow(ctx, `SELECT count(*) FROM albums WHERE owner_id = $1`, userID).Scan(&n); err != nil {
		return nil, err
	}
	if n >= maxAlbums {
		return nil, httpx.BadRequest("ALBUMS_FULL", fmt.Sprintf("you have the most albums you can have (%d)", maxAlbums))
	}
	aid := id.New()
	if _, err := s.db.Exec(ctx, `INSERT INTO albums (id, gallery_id, owner_id, title, visibility) VALUES ($1, $2, $3, $4, $5)`,
		aid, galleryID, userID, in.Title, in.Visibility); err != nil {
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

// remove deletes an album: by its owner, or a gallery-visible one by a moderator. Its files stay.
func (s *Service) remove(ctx context.Context, userID, albumID id.ID) error {
	a, role, _, err := s.access(ctx, userID, albumID)
	if err != nil {
		return err
	}
	moderating := false
	if role != RoleOwner {
		p, err := s.members.BasePerms(ctx, userID)
		if err != nil {
			return err
		}
		if a.visibility != "gallery" || !p.Has(perms.ManageMessages) {
			return httpx.MissingPermission()
		}
		moderating = true
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM albums WHERE id = $1`, albumID); err != nil { // cascades to members and items
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
	return nil
}

// addMember makes someone who can see the gallery a collaborator (owner only).
func (s *Service) addMember(ctx context.Context, userID, albumID, memberID id.ID) error {
	a, err := s.owned(ctx, userID, albumID)
	if err != nil {
		return err
	}
	if memberID == a.ownerID || a.has(memberID) {
		return nil
	}
	if _, err := s.galleryScope(ctx, memberID, a.galleryID); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return httpx.NotFound("member")
		}
		return err
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
	a, role, _, err := s.access(ctx, userID, albumID)
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
	var count int
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+`, `+itemCountSQL+`
		FROM albums a WHERE a.id = $1`, albumID), &count)
	if err != nil {
		return err
	}
	a := toAlbum(r, count, "")
	s.publishUpdate(ctx, &a, before)
	return nil
}

// audience is who hears about an album: everyone who can see its gallery, or its owner and
// collaborators who still can.
func (s *Service) audience(ctx context.Context, visibility string, galleryID, ownerID id.ID, memberIDs []id.ID) events.Scope {
	if visibility == "gallery" {
		return events.Scope{ChannelID: galleryID}
	}
	users := []id.ID{}
	for _, u := range append([]id.ID{ownerID}, memberIDs...) {
		if _, err := s.galleryScope(ctx, u, galleryID); err == nil {
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
		case before.visibility == "gallery" && a.Visibility == "private":
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: s.audience(ctx, "gallery", a.GalleryID, a.OwnerID, nil)})
		case a.Visibility == "private" && len(lost) > 0:
			s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: a.ID}, Scope: events.Scope{UserIDs: lost}})
		}
	}
	shown := *a
	shown.Role, shown.Contains, shown.Deck = "", nil, []files.Attachment{}
	s.bus.Publish(events.Event{Type: "ALBUM_UPDATE", Data: shown, Scope: s.audience(ctx, a.Visibility, a.GalleryID, a.OwnerID, a.MemberIDs)})
}

func (s *Service) publishDelete(ctx context.Context, r *row) {
	s.bus.Publish(events.Event{Type: "ALBUM_DELETE", Data: AlbumDeleted{ID: r.id}, Scope: s.audience(ctx, r.visibility, r.galleryID, r.ownerID, r.memberIDs)})
}

func (s *Service) publishItems(ctx context.Context, albumID id.ID) {
	r, err := scanRow(s.db.QueryRow(ctx, `SELECT `+rowCols+` FROM albums a WHERE a.id = $1`, albumID))
	if err != nil {
		return
	}
	s.bus.Publish(events.Event{Type: "ALBUM_ITEMS_UPDATE", Data: ItemsChanged{AlbumID: albumID}, Scope: s.audience(ctx, r.visibility, r.galleryID, r.ownerID, r.memberIDs)})
}

func contains(ids []id.ID, x id.ID) bool {
	for _, v := range ids {
		if v == x {
			return true
		}
	}
	return false
}
