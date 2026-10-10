package messages

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// Threads is what this package needs from channels to start and list threads.
type Threads interface {
	CreateThread(ctx context.Context, parent *channels.Channel, messageID, creatorID id.ID, name string) (*channels.Channel, bool, error)
	ThreadsOf(ctx context.Context, parentID id.ID) ([]channels.Channel, error)
	CreatePost(ctx context.Context, tx pgx.Tx, forum *channels.Channel, creatorID id.ID, title string, tags []string) (*channels.Channel, error)
	UpdatePost(ctx context.Context, post *channels.Channel, title *string, tags *[]string) (*channels.Channel, error)
	DeletePost(ctx context.Context, post *channels.Channel) error
	// ThreadPerms is what a user may do in parent's threads (no webhook-channel mask).
	ThreadPerms(ctx context.Context, userID id.ID, parent *channels.Channel) (perms.Perms, error)
}

func (s *Service) SetThreads(t Threads) { s.threads = t }

type ThreadSummary struct {
	ID            id.ID             `json:"id"`
	Name          string            `json:"name"`
	MessageCount  int               `json:"message_count"`
	LastMessageAt *time.Time        `json:"last_message_at,omitempty"`
	LastMessageID *id.ID            `json:"last_message_id,omitempty"`
	Participants  []auth.PublicUser `json:"participants" doc:"Up to three of the first people who posted"`
}

type ThreadUpdate struct {
	ChannelID id.ID         `json:"channel_id" doc:"The parent channel"`
	MessageID id.ID         `json:"message_id" doc:"The parent message"`
	Thread    ThreadSummary `json:"thread"`
}

type ThreadListItem struct {
	Channel         channels.Channel `json:"channel"`
	ParentMessageID *id.ID           `json:"parent_message_id,omitempty"`
	Summary         ThreadSummary    `json:"summary"`
	Author          *auth.PublicUser `json:"author,omitempty"`
	Excerpt         string           `json:"excerpt,omitempty" doc:"Forum posts: the start of the first message"`
	FirstMessageID  *id.ID           `json:"first_message_id,omitempty"`
}

// PostUpdate tells a forum that one of its posts was created or changed.
type PostUpdate struct {
	ChannelID id.ID          `json:"channel_id" doc:"The forum"`
	Post      ThreadListItem `json:"post"`
}

// PostDeleted tells a forum that one of its posts was deleted.
type PostDeleted struct {
	ChannelID id.ID `json:"channel_id" doc:"The forum"`
	ID        id.ID `json:"id" doc:"The post"`
}

type CreateThreadRequest struct {
	Name string `json:"name,omitempty" maxLength:"100"`
}

// summaries computes thread summaries for threads keyed by thread ID.
func (s *Service) summaries(ctx context.Context, threads map[id.ID]string) (map[id.ID]*ThreadSummary, error) {
	out := map[id.ID]*ThreadSummary{}
	if len(threads) == 0 {
		return out, nil
	}
	ids := make([]id.ID, 0, len(threads))
	for tid, name := range threads {
		ids = append(ids, tid)
		out[tid] = &ThreadSummary{ID: tid, Name: name, Participants: []auth.PublicUser{}}
	}
	rows, err := s.db.Query(ctx, `
		SELECT channel_id, count(*) FILTER (WHERE NOT deleted), max(id) FILTER (WHERE NOT deleted),
		       coalesce(array_agg(author_id ORDER BY id) FILTER (WHERE NOT deleted AND author_id IS NOT NULL), '{}')
		FROM messages WHERE channel_id = ANY($1) GROUP BY channel_id`, id.Int64s(ids))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var authors []id.ID
	firstPosters := map[id.ID][]id.ID{}
	for rows.Next() {
		var tid id.ID
		var count int
		var last *int64
		var all []int64
		if err := rows.Scan(&tid, &count, &last, &all); err != nil {
			return nil, err
		}
		sm := out[tid]
		sm.MessageCount = count
		if last != nil {
			lid := id.ID(*last)
			t := lid.Time()
			sm.LastMessageAt, sm.LastMessageID = &t, &lid
		}
		seen := map[id.ID]bool{}
		for _, a := range all {
			if uid := id.ID(a); !seen[uid] && len(firstPosters[tid]) < 3 {
				seen[uid] = true
				firstPosters[tid] = append(firstPosters[tid], uid)
				authors = append(authors, uid)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(authors) == 0 {
		return out, nil
	}
	users, err := s.users.PublicUsers(ctx, authors)
	if err != nil {
		return nil, err
	}
	for tid, us := range firstPosters {
		for _, u := range us {
			out[tid].Participants = append(out[tid].Participants, users[u])
		}
	}
	return out, nil
}

// withThreads fills Message.Thread for parent messages.
func (s *Service) withThreads(ctx context.Context, ms []Message) error {
	if len(ms) == 0 {
		return nil
	}
	ids := make([]id.ID, 0, len(ms))
	for _, m := range ms {
		ids = append(ids, m.ID)
	}
	rows, err := s.db.Query(ctx, `SELECT id, name, parent_message_id FROM channels WHERE type = 'thread' AND parent_message_id = ANY($1)`, id.Int64s(ids))
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[id.ID]string{}
	byParent := map[id.ID]id.ID{}
	for rows.Next() {
		var tid, pid id.ID
		var name string
		if err := rows.Scan(&tid, &name, &pid); err != nil {
			return err
		}
		names[tid] = name
		byParent[pid] = tid
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(names) == 0 {
		return nil
	}
	sums, err := s.summaries(ctx, names)
	if err != nil {
		return err
	}
	for i := range ms {
		if tid, ok := byParent[ms[i].ID]; ok {
			ms[i].Thread = sums[tid]
		}
	}
	return nil
}

const excerptRunes = 200

// threadItems builds thread list items. Threads with no parent message are
// forum posts and also get their author and the start of their first message.
func (s *Service) threadItems(ctx context.Context, list []channels.Channel) ([]ThreadListItem, error) {
	names := map[id.ID]string{}
	var posts, creators []id.ID
	for _, t := range list {
		names[t.ID] = t.Name
		if t.ParentMessageID == nil {
			posts = append(posts, t.ID)
			if t.CreatedBy != nil {
				creators = append(creators, *t.CreatedBy)
			}
		}
	}
	sums, err := s.summaries(ctx, names)
	if err != nil {
		return nil, err
	}
	type first struct {
		id      id.ID
		content string
	}
	firsts := map[id.ID]first{}
	if len(posts) > 0 {
		rows, err := s.db.Query(ctx, `
			SELECT DISTINCT ON (channel_id) channel_id, id, content FROM messages
			WHERE channel_id = ANY($1) AND NOT deleted ORDER BY channel_id, id`, id.Int64s(posts))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var cid id.ID
			var f first
			if err := rows.Scan(&cid, &f.id, &f.content); err != nil {
				return nil, err
			}
			firsts[cid] = f
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	users := map[id.ID]auth.PublicUser{}
	if len(creators) > 0 {
		if users, err = s.users.PublicUsers(ctx, creators); err != nil {
			return nil, err
		}
	}
	out := make([]ThreadListItem, 0, len(list))
	for _, t := range list {
		item := ThreadListItem{Channel: t, ParentMessageID: t.ParentMessageID, Summary: *sums[t.ID]}
		if t.ParentMessageID == nil {
			if t.CreatedBy != nil {
				if u, ok := users[*t.CreatedBy]; ok {
					item.Author = &u
				}
			}
			if f, ok := firsts[t.ID]; ok {
				item.FirstMessageID = &f.id
				item.Excerpt = f.content
				if r := []rune(f.content); len(r) > excerptRunes {
					item.Excerpt = string(r[:excerptRunes])
				}
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// postItem builds the list item for one forum post.
func (s *Service) postItem(ctx context.Context, post *channels.Channel) (*ThreadListItem, error) {
	items, err := s.threadItems(ctx, []channels.Channel{*post})
	if err != nil {
		return nil, err
	}
	return &items[0], nil
}

// isForumPost reports whether a channel is a post in a forum.
func (s *Service) isForumPost(ctx context.Context, ch *channels.Channel) (bool, error) {
	if ch.Type != channels.TypeThread || ch.ParentMessageID != nil {
		return false, nil
	}
	var typ string
	if err := s.db.QueryRow(ctx, `SELECT type FROM channels WHERE id = $1`, *ch.ParentChannelID).Scan(&typ); err != nil {
		return false, err
	}
	return typ == channels.TypeForum, nil
}

// publishThread sends THREAD_UPDATE for a thread channel to its parent
// channel, or POST_UPDATE for a forum post to its forum. It runs after the
// change is committed, so failures are dropped.
func (s *Service) publishThread(ctx context.Context, thread *channels.Channel) {
	if thread.Type != channels.TypeThread {
		return
	}
	if thread.ParentMessageID == nil {
		if ok, err := s.isForumPost(ctx, thread); err != nil || !ok {
			return
		}
		item, err := s.postItem(ctx, thread)
		if err != nil {
			return
		}
		s.publish("POST_UPDATE", *thread.ParentChannelID, PostUpdate{ChannelID: *thread.ParentChannelID, Post: *item})
		return
	}
	sums, err := s.summaries(ctx, map[id.ID]string{thread.ID: thread.Name})
	if err != nil {
		return
	}
	s.publish("THREAD_UPDATE", *thread.ParentChannelID,
		ThreadUpdate{ChannelID: *thread.ParentChannelID, MessageID: *thread.ParentMessageID, Thread: *sums[thread.ID]})
}

type createThreadResponse struct {
	Status int
	Body   *channels.Channel
}

func registerThreads(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("create-thread", http.MethodPost, "/api/channels/{id}/messages/{messageID}/thread", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID        string `path:"id"`
			MessageID string `path:"messageID"`
			Body      CreateThreadRequest
		}) (*createThreadResponse, error) {
			// Not through access: the type check runs before the permission
			// check, so DMs, which never hold CREATE_THREADS, and the welcome
			// channel answer NO_THREADS_HERE.
			chID, err := httpx.ParseID(in.ID, "channel")
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			ch, have, err := s.channels.Access(ctx, me, chID, 0)
			if err != nil {
				return nil, err
			}
			switch ch.Type {
			case channels.TypeText, channels.TypeVoice, channels.TypeWebhook, channels.TypeAnnouncement, channels.TypeGallery:
			default:
				return nil, httpx.BadRequest("NO_THREADS_HERE", "threads can only be started in text, voice, webhook, announcement and gallery channels")
			}
			// Posting in the thread is what counts: a webhook channel's mask does not apply there.
			inThread, err := s.threads.ThreadPerms(ctx, me, ch)
			if err != nil {
				return nil, err
			}
			if !have.Has(perms.CreateThreads) || !inThread.Has(perms.SendMessages) {
				return nil, httpx.MissingPermission()
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			name := in.Body.Name
			if name == "" {
				name = firstLine(m.Content, 40)
			}
			thread, created, err := s.threads.CreateThread(ctx, ch, m.ID, me, name)
			if err != nil {
				return nil, err
			}
			status := http.StatusOK
			if created {
				status = http.StatusCreated
				s.publishThread(ctx, thread)
			}
			return &createThreadResponse{status, thread}, nil
		})

	huma.Register(api, op("list-threads", http.MethodGet, "/api/channels/{id}/threads", 0),
		func(ctx context.Context, in *channelPath) (*struct{ Body []ThreadListItem }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			list, err := s.threads.ThreadsOf(ctx, ch.ID)
			if err != nil {
				return nil, err
			}
			out, err := s.threadItems(ctx, list)
			if err != nil {
				return nil, err
			}
			// Latest activity first; empty threads last, newest first.
			sort.Slice(out, func(i, j int) bool {
				a, b := out[i].Summary.LastMessageAt, out[j].Summary.LastMessageAt
				switch {
				case a == nil && b == nil:
					return out[i].Channel.ID > out[j].Channel.ID
				case a == nil:
					return false
				case b == nil:
					return true
				}
				return a.After(*b)
			})
			return &struct{ Body []ThreadListItem }{out}, nil
		})
}

// firstLine returns the first line of s, cut to n runes, or Thread if empty.
func firstLine(s string, n int) string {
	for i, r := range s {
		if r == '\n' {
			s = s[:i]
			break
		}
	}
	if r := []rune(s); len(r) > n {
		s = string(r[:n])
	}
	if s == "" {
		return "Thread"
	}
	return s
}
