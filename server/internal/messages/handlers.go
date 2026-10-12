package messages

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

type SendRequest struct {
	Title         string       `json:"title,omitempty" maxLength:"100" doc:"Announcements only"`
	Content       string       `json:"content,omitempty" maxLength:"4000"`
	Nonce         string       `json:"nonce,omitempty" maxLength:"64" doc:"Client-chosen; echoed in MESSAGE_CREATE so the sender can match its pending message"`
	AttachmentIDs []id.ID      `json:"attachment_ids,omitempty" maxItems:"10" doc:"Uploads (POST /api/attachments) to send with the message"`
	ReplyToID     *id.ID       `json:"reply_to_id,omitempty" doc:"Reply to this message (same channel)"`
	Poll          *PollRequest `json:"poll,omitempty" doc:"Makes the message a poll; content may then be empty"`
}

type EditRequest struct {
	Title   *string `json:"title,omitempty" maxLength:"100" doc:"Announcements only; omit to keep the title"`
	Content string  `json:"content" maxLength:"4000"`
}

type AckRequest struct {
	MessageID id.ID `json:"message_id"`
}

type channelPath struct {
	ID string `path:"id"`
}

type messagePath struct {
	ID        string `path:"id"`
	MessageID string `path:"messageID"`
}

func Register(api huma.API, s *Service) {
	tags := []string{"messages"}
	op := func(id, method, path string, status int) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Tags: tags, Security: httpx.Authed, DefaultStatus: status}
	}
	// access resolves the channel for the signed-in user.
	access := func(ctx context.Context, raw string, need perms.Perms) (*channels.Channel, perms.Perms, error) {
		chID, err := httpx.ParseID(raw, "channel")
		if err != nil {
			return nil, 0, err
		}
		ch, p, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, need)
		if err == nil && ch.Type == channels.TypeWelcome {
			return nil, 0, httpx.BadRequest("NO_MESSAGES_HERE", "the welcome channel has no messages")
		}
		return ch, p, err
	}

	registerReactions(api, s, op, access)
	registerPolls(api, s, op, access)
	registerPins(api, s, op, access)
	registerThreads(api, s, op, access)
	registerPosts(api, s, op, access)
	registerSearch(api, s, op)
	registerFiles(api, s, op)
	registerInbox(api, s, op)
	registerLeaveDM(api, s, op)

	huma.Register(api, op("list-messages", http.MethodGet, "/api/channels/{id}/messages", 0),
		func(ctx context.Context, in *struct {
			ID     string `path:"id"`
			Before string `query:"before" doc:"Only messages older than this ID"`
			After  string `query:"after" doc:"Only messages newer than this ID"`
			Around string `query:"around" doc:"Messages around this ID, itself included"`
			Limit  int    `query:"limit" minimum:"1" maximum:"100" default:"50"`
		}) (*struct{ Body []Message }, error) {
			ch, _, err := access(ctx, in.ID, perms.ReadHistory)
			if err != nil {
				return nil, err
			}
			var ptrs [3]*id.ID
			n := 0
			for i, f := range []struct{ name, raw string }{{"before", in.Before}, {"after", in.After}, {"around", in.Around}} {
				if f.raw == "" {
					continue
				}
				v, err := id.Parse(f.raw)
				if err != nil {
					return nil, httpx.BadRequest("VALIDATION_FAILED", f.name+" must be a message ID")
				}
				ptrs[i] = &v
				n++
			}
			if n > 1 {
				return nil, httpx.BadRequest("VALIDATION_FAILED", "use only one of before, after and around")
			}
			ms, err := s.list(ctx, ch.ID, ptrs[0], ptrs[1], ptrs[2], in.Limit)
			if err != nil {
				return nil, err
			}
			if err := s.withMyVotes(ctx, ms, auth.Current(ctx).User.ID); err != nil {
				return nil, err
			}
			return &struct{ Body []Message }{ms}, nil
		})

	huma.Register(api, op("send-message", http.MethodPost, "/api/channels/{id}/messages", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body SendRequest
		}) (*struct{ Body *Message }, error) {
			need := perms.SendMessages
			if len(in.Body.AttachmentIDs) > 0 {
				need |= perms.AttachFiles
			}
			ch, have, err := access(ctx, in.ID, need)
			if err != nil {
				return nil, err
			}
			if ch.Type == channels.TypeForum {
				return nil, httpx.BadRequest("NOT_ALLOWED_HERE", "a forum takes posts, not messages")
			}
			title := strings.TrimSpace(in.Body.Title)
			if err := checkTitle(ch, in.Body.Title); err != nil {
				return nil, err
			}
			if ch.Type == channels.TypeAnnouncement && !have.Has(perms.ManageMessages) {
				return nil, httpx.MissingPermission()
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" && len(in.Body.AttachmentIDs) == 0 && in.Body.Poll == nil {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs text, an attachment or a poll")
			}
			if in.Body.Poll != nil {
				if err := s.checkPoll(ctx, in.Body.Poll); err != nil {
					return nil, err
				}
			}
			if ch.Type == channels.TypeGallery && len(in.Body.AttachmentIDs) == 0 {
				return nil, errMediaOnly()
			}
			if in.Body.ReplyToID != nil {
				if err := s.checkReply(ctx, ch.ID, *in.Body.ReplyToID); err != nil {
					return nil, err
				}
			}
			mentions, err := s.mentionIDs(ctx, content)
			if err != nil {
				return nil, err
			}
			everyone := have.Has(perms.MentionEveryone) && mentionsEveryone(content)
			roles, err := s.roleMentionIDs(ctx, ch.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))
			if err != nil {
				return nil, err
			}
			u := auth.Current(ctx).User
			author := u.Public()
			m := &Message{ID: id.New(), ChannelID: ch.ID, Author: &author, Title: title, Content: content, Nonce: in.Body.Nonce, Mentions: mentions,
				MentionEveryone: everyone, MentionRoles: roles, replyToID: in.Body.ReplyToID}
			m.CreatedAt = m.ID.Time()
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, mentions, title, mention_everyone, mention_roles) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
				m.ID, m.ChannelID, u.ID, m.Content, in.Body.ReplyToID, id.Int64s(mentions), m.Title, everyone, id.Int64s(roles)); err != nil {
				return nil, err
			}
			if m.Attachments, err = s.attachments.Claim(ctx, tx, m.ID, ch.ID, u.ID, in.Body.AttachmentIDs); err != nil {
				return nil, err
			}
			if in.Body.Poll != nil {
				if err := insertPoll(ctx, tx, m.ID, m.CreatedAt, in.Body.Poll); err != nil {
					return nil, err
				}
			}
			// A reply in a forum post is also read in the forum, whose newest
			// message is the newest across its posts.
			read := []id.ID{ch.ID}
			if post, err := s.isForumPost(ctx, ch); err != nil {
				return nil, err
			} else if post {
				read = append(read, *ch.ParentChannelID)
			}
			if err := markRead(ctx, tx, u.ID, m.ID, read...); err != nil {
				return nil, err
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			one := []Message{*m}
			if err := s.hydrate(ctx, one); err != nil {
				return nil, err
			}
			m = &one[0]
			s.publish("MESSAGE_CREATE", ch.ID, m)
			s.publishThread(ctx, ch)
			s.attachPreview(*m)
			return &struct{ Body *Message }{m}, nil
		})

	huma.Register(api, op("edit-message", http.MethodPatch, "/api/channels/{id}/messages/{messageID}", 0),
		func(ctx context.Context, in *struct {
			ID        string `path:"id"`
			MessageID string `path:"messageID"`
			Body      EditRequest
		}) (*struct{ Body *Message }, error) {
			ch, have, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			if m.Author == nil || m.Author.ID != auth.Current(ctx).User.ID { // nobody edits a webhook's message
				return nil, httpx.MissingPermission()
			}
			var isPoll bool
			if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM polls WHERE message_id = $1)`, m.ID).Scan(&isPoll); err != nil {
				return nil, err
			}
			if isPoll {
				return nil, errPollNotEditable()
			}
			var title *string
			if in.Body.Title != nil {
				if err := checkTitle(ch, *in.Body.Title); err != nil {
					return nil, err
				}
				t := strings.TrimSpace(*in.Body.Title)
				title = &t
			}
			current, err := s.attachments.ForMessages(ctx, []id.ID{m.ID})
			if err != nil {
				return nil, err
			}
			content := strings.TrimSpace(in.Body.Content)
			if content == "" && len(current[m.ID]) == 0 {
				return nil, httpx.BadRequest("EMPTY_MESSAGE", "a message needs text or an attachment")
			}
			mentions, err := s.mentionIDs(ctx, content)
			if err != nil {
				return nil, err
			}
			everyone := have.Has(perms.MentionEveryone) && mentionsEveryone(content)
			roles, err := s.roleMentionIDs(ctx, ch.ID, content, have.Has(perms.MentionRoles), maxMentions-len(mentions))
			if err != nil {
				return nil, err
			}
			// A changed first link drops the old embed now; attachPreview fetches the new one.
			linkChanged := firstLink(content) != firstLink(m.Content)
			updated, err := scanMessage(s.db.QueryRow(ctx, `
				UPDATE messages SET content = $2, mentions = $3, edited_at = now(), embed = CASE WHEN $4 THEN NULL ELSE embed END,
					title = COALESCE($5, title), mention_everyone = $6, mention_roles = $7
				WHERE id = $1 AND NOT deleted RETURNING `+messageCols,
				m.ID, content, id.Int64s(mentions), linkChanged, title, everyone, id.Int64s(roles)))
			if errors.Is(err, pgx.ErrNoRows) { // deleted since s.get
				return nil, httpx.NotFound("message")
			}
			if err != nil {
				return nil, err
			}
			one := []Message{*updated}
			if err := s.hydrate(ctx, one); err != nil {
				return nil, err
			}
			updated = &one[0]
			s.publish("MESSAGE_UPDATE", ch.ID, updated)
			if ch.Type == channels.TypeThread && ch.ParentMessageID == nil {
				s.publishThread(ctx, ch) // a forum post: refresh its excerpt
			}
			if linkChanged {
				s.attachPreview(*updated)
			}
			return &struct{ Body *Message }{updated}, nil
		})

	huma.Register(api, op("delete-message", http.MethodDelete, "/api/channels/{id}/messages/{messageID}", http.StatusNoContent),
		func(ctx context.Context, in *messagePath) (*struct{}, error) {
			ch, have, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			m, err := s.get(ctx, ch.ID, in.MessageID)
			if err != nil {
				return nil, err
			}
			me := auth.Current(ctx).User.ID
			mine := m.Author != nil && m.Author.ID == me
			if !mine && !have.Has(perms.ManageMessages) {
				return nil, httpx.MissingPermission()
			}
			// A webhook message has no author to outrank: MANAGE_MESSAGES is enough.
			if !mine && m.Author != nil && ch.Type != channels.TypeDM {
				ok, err := s.ranks.Outranks(ctx, me, m.Author.ID)
				if err != nil {
					return nil, err
				}
				if !ok {
					return nil, httpx.MissingPermission()
				}
			}
			tx, err := s.db.Begin(ctx)
			if err != nil {
				return nil, err
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `UPDATE messages SET content = '', deleted = TRUE, embed = NULL, embeds = NULL, author_avatar_sha256 = NULL,
				pinned_at = NULL, pinned_by = NULL WHERE id = $1`, m.ID); err != nil {
				return nil, err
			}
			if _, err := tx.Exec(ctx, `DELETE FROM message_reactions WHERE message_id = $1`, m.ID); err != nil {
				return nil, err
			}
			// Soft delete: the FK cascade never fires, so the poll (options and votes cascade) goes here.
			if _, err := tx.Exec(ctx, `DELETE FROM polls WHERE message_id = $1`, m.ID); err != nil {
				return nil, err
			}
			sums, err := s.attachments.DeleteForMessage(ctx, tx, m.ID)
			if err != nil {
				return nil, err
			}
			images, err := deleteImages(ctx, tx, m.ID)
			if err != nil {
				return nil, err
			}
			sums = append(sums, images...)
			// A moderator removing someone else's message is logged; webhook messages have no author to name.
			if !mine && m.Author != nil && ch.CommunityID != nil {
				if err := audit.Record(ctx, tx, audit.MessageDelete, m.Author.ID, audit.LogDetails{Channel: &audit.LogRef{ID: ch.ID, Name: ch.Name}}); err != nil {
					return nil, err
				}
			}
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			s.publish("MESSAGE_DELETE", ch.ID, MessageDeleted{ID: m.ID, ChannelID: ch.ID})
			s.publishThread(ctx, ch)
			if err := s.attachments.RemoveBlobs(ctx, sums); err != nil {
				slog.WarnContext(ctx, "removing blobs of a deleted message; the sweep will retry", "message", m.ID, "err", err)
			}
			return nil, nil
		})

	huma.Register(api, op("start-typing", http.MethodPost, "/api/channels/{id}/typing", http.StatusNoContent),
		func(ctx context.Context, in *channelPath) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, perms.SendMessages)
			if err != nil {
				return nil, err
			}
			s.publish("TYPING_START", ch.ID, TypingStart{ChannelID: ch.ID, UserID: auth.Current(ctx).User.ID, At: time.Now()})
			return nil, nil
		})

	huma.Register(api, op("ack-channel", http.MethodPost, "/api/channels/{id}/ack", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body AckRequest
		}) (*struct{}, error) {
			ch, _, err := access(ctx, in.ID, 0)
			if err != nil {
				return nil, err
			}
			_, err = s.db.Exec(ctx, `
				INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES ($1, $2, $3)
				ON CONFLICT (user_id, channel_id)
				DO UPDATE SET last_message_id = GREATEST(read_states.last_message_id, EXCLUDED.last_message_id)`,
				auth.Current(ctx).User.ID, ch.ID, in.Body.MessageID)
			return nil, err
		})
}

func errMediaOnly() error {
	return httpx.BadRequest("MEDIA_ONLY", "gallery posts need a file")
}

// checkTitle allows a title only on announcements.
func checkTitle(ch *channels.Channel, title string) error {
	if title != "" && ch.Type != channels.TypeAnnouncement {
		return httpx.BadRequest("NOT_ALLOWED_HERE", "only announcements have titles")
	}
	return nil
}
