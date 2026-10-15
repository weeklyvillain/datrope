package messages

import (
	"context"
	"net/http"
	"strings"

	"github.com/danielgtaylor/huma/v2"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type CreatePostRequest struct {
	Title         string   `json:"title" minLength:"1" maxLength:"100"`
	Content       string   `json:"content" maxLength:"4000"`
	Tags          []string `json:"tags,omitempty" maxItems:"5" doc:"From the forum tags"`
	AttachmentIDs []id.ID  `json:"attachment_ids,omitempty" maxItems:"10" doc:"Uploads to the forum (POST /api/attachments?channel_id=<forum>)"`
	TZ            string   `json:"tz,omitempty" maxLength:"64" doc:"The sender's IANA time zone"`
}

type UpdatePostRequest struct {
	Title *string   `json:"title,omitempty" minLength:"1" maxLength:"100"`
	Tags  *[]string `json:"tags,omitempty" maxItems:"5" doc:"Replaces the tags"`
}

func registerPosts(api huma.API, s *Service, op func(string, string, string, int) huma.Operation, access accessFunc) {
	huma.Register(api, op("create-post", http.MethodPost, "/api/channels/{id}/posts", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body CreatePostRequest
		}) (*struct{ Body *ThreadListItem }, error) {
			// The type check runs before the permission check, as for threads.
			forum, have, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			if forum.Type != channels.TypeForum {
				return nil, httpx.BadRequest("NOT_A_FORUM", "posts can only be created in forums")
			}
			need := perms.CreateThreads | perms.SendMessages
			if len(in.Body.AttachmentIDs) > 0 {
				need |= perms.AttachFiles
			}
			if !have.Has(need) {
				return nil, httpx.MissingPermission()
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" && len(in.Body.AttachmentIDs) == 0 {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs text or an attachment")
			}
			mentions, err := s.mentionIDs(ctx, content)
			if err != nil {
				return nil, err
			}
			roles, err := s.roleMentionIDs(ctx, forum.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))
			if err != nil {
				return nil, err
			}
			u := auth.Current(ctx).User
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			post, err := s.threads.CreatePost(ctx, tx, forum, u.ID, in.Body.Title, in.Body.Tags)
			if err != nil {
				return nil, err
			}
			author := u.Public()
			everyone := have.Has(perms.MentionEveryone) && mentionsEveryone(content)
			m := &Message{ID: id.New(), ChannelID: post.ID, Author: &author, Content: content, Mentions: mentions, MentionEveryone: everyone, MentionRoles: roles}
			m.CreatedAt = m.ID.Time()
			tz := cleanTZ(in.Body.TZ)
			if tz != nil {
				m.TZ = *tz
			}
			if _, err := tx.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, mentions, mention_everyone, mention_roles, tz) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				m.ID, post.ID, u.ID, m.Content, id.Int64s(mentions), everyone, id.Int64s(roles), tz); err != nil {
				return nil, err
			}
			// Uploads go to the forum, since the post does not exist yet; once
			// claimed they move to the post so they live and die with it.
			if _, err := s.attachments.Claim(ctx, tx, m.ID, forum.ID, u.ID, in.Body.AttachmentIDs); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `UPDATE attachments SET channel_id = $2 WHERE message_id = $1`, m.ID, post.ID); err != nil {
				return nil, err
			}
			if err := markRead(ctx, tx, u.ID, m.ID, post.ID, forum.ID); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			one := []Message{*m}
			if err := s.hydrate(ctx, one); err != nil {
				return nil, err
			}
			s.publish("MESSAGE_CREATE", post.ID, &one[0])
			item, err := s.postItem(ctx, post)
			if err != nil {
				return nil, err
			}
			s.publish("POST_UPDATE", forum.ID, PostUpdate{ChannelID: forum.ID, Post: *item})
			s.attachPreview(one[0])
			return &struct{ Body *ThreadListItem }{item}, nil
		})

	// postAccess loads a forum post the caller may change: their own, or with
	// MANAGE_MESSAGES one by a member they outrank (or whose author is gone).
	postAccess := func(ctx context.Context, raw string) (*channels.Channel, error) {
		post, have, err := access(ctx, raw, 0)
		if err != nil {
			return nil, err
		}
		ok, err := s.isForumPost(ctx, post)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, httpx.BadRequest("NOT_A_POST", "this channel is not a forum post")
		}
		me := auth.Current(ctx).User.ID
		if post.CreatedBy != nil && *post.CreatedBy == me {
			return post, nil
		}
		if !have.Has(perms.ManageMessages) {
			return nil, httpx.MissingPermission()
		}
		if post.CreatedBy != nil {
			ok, err := s.ranks.Outranks(ctx, me, *post.CreatedBy)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, httpx.MissingPermission()
			}
		}
		return post, nil
	}

	huma.Register(api, op("update-post", http.MethodPatch, "/api/channels/{id}/post", 0),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body UpdatePostRequest
		}) (*struct{ Body *ThreadListItem }, error) {
			post, err := postAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if post, err = s.threads.UpdatePost(ctx, post, in.Body.Title, in.Body.Tags); err != nil {
				return nil, err
			}
			item, err := s.postItem(ctx, post)
			if err != nil {
				return nil, err
			}
			s.publish("POST_UPDATE", *post.ParentChannelID, PostUpdate{ChannelID: *post.ParentChannelID, Post: *item})
			return &struct{ Body *ThreadListItem }{item}, nil
		})

	huma.Register(api, op("delete-post", http.MethodDelete, "/api/channels/{id}/post", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			post, err := postAccess(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			if err := s.threads.DeletePost(ctx, post); err != nil {
				return nil, err
			}
			if err := s.auditPostDelete(ctx, post); err != nil {
				return nil, err
			}
			s.publish("POST_DELETE", *post.ParentChannelID, PostDeleted{ChannelID: *post.ParentChannelID, ID: post.ID})
			return nil, nil
		})
}

// auditPostDelete logs a moderator removing someone else's forum post: the
// target is its author, Name its title and Channel the forum it was in.
func (s *Service) auditPostDelete(ctx context.Context, post *channels.Channel) error {
	if post.CreatedBy == nil || *post.CreatedBy == auth.Current(ctx).User.ID {
		return nil
	}
	forum, err := s.channels.Get(ctx, *post.ParentChannelID)
	if err != nil {
		return err
	}
	return audit.Record(ctx, s.db, audit.MessageDelete, *post.CreatedBy, audit.LogDetails{Name: post.Name, Channel: &audit.LogRef{ID: forum.ID, Name: forum.Name}})
}
