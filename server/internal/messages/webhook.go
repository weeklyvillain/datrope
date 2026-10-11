package messages

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/linkpreview"
	"github.com/datrope/datrope/server/internal/perms"
)

// WebhookAuthor is who a webhook message shows as. The name and avatar are
// copied onto the message when it is posted, so renaming or deleting the
// webhook later does not change it.
type WebhookAuthor struct {
	ID        *id.ID `json:"id,omitempty" doc:"Absent once the webhook is deleted"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url,omitempty" doc:"Absent when it has none; clients draw the webhook icon"`
}

// WebhookEmbed is a Discord-style rich embed posted by a webhook. It is not
// the link preview (Message.Embed). Image URLs point at this instance's
// copies; url fields are plain links.
type WebhookEmbed struct {
	Title       string       `json:"title,omitempty"`
	URL         string       `json:"url,omitempty" doc:"Makes the title a link"`
	Description string       `json:"description,omitempty" doc:"Markdown"`
	Color       *int         `json:"color,omitempty" doc:"The accent colour, 0xRRGGBB"`
	Timestamp   string       `json:"timestamp,omitempty" doc:"RFC 3339, UTC"`
	Author      *EmbedAuthor `json:"author,omitempty"`
	Fields      []EmbedField `json:"fields,omitempty"`
	Thumbnail   *EmbedImage  `json:"thumbnail,omitempty"`
	Image       *EmbedImage  `json:"image,omitempty"`
	Footer      *EmbedFooter `json:"footer,omitempty"`
}

type EmbedAuthor struct {
	Name    string `json:"name"`
	URL     string `json:"url,omitempty"`
	IconURL string `json:"icon_url,omitempty"`
}

type EmbedField struct {
	Name   string `json:"name"`
	Value  string `json:"value" doc:"Markdown"`
	Inline bool   `json:"inline,omitempty" doc:"Up to three inline fields share a row"`
}

type EmbedImage struct {
	URL string `json:"url"`
}

type EmbedFooter struct {
	Text    string `json:"text"`
	IconURL string `json:"icon_url,omitempty"`
}

// imageURL is where a message's stored image (a webhook avatar or an embed
// image) is served.
func imageURL(messageID id.ID, sum string) string {
	return "/api/messages/" + messageID.String() + "/images/" + sum
}

// deleteImages removes a deleted message's image rows inside tx and returns
// their blob sums, to pass to RemoveBlobs after the commit.
func deleteImages(ctx context.Context, tx pgx.Tx, messageID id.ID) ([]string, error) {
	rows, err := tx.Query(ctx, `DELETE FROM message_images WHERE message_id = $1 RETURNING sha256`, messageID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// Blobs is what this package needs from files to keep webhook messages' images.
type Blobs interface {
	StoreImageBlob(ctx context.Context, tx pgx.Tx, data []byte) (sum, contentType string, err error)
	ServePrivateBlob(w http.ResponseWriter, r *http.Request, sum, contentType string)
}

func (s *Service) SetBlobs(b Blobs) { s.blobs = b }

// ErrWebhookGone means the webhook was deleted while its message was being posted.
var ErrWebhookGone = errors.New("messages: the webhook was deleted")

// ErrEmptyWebhookMessage means a webhook message had no content, and every
// embed was left with nothing to show once its unusable images were dropped.
var ErrEmptyWebhookMessage = errors.New("messages: the webhook message is empty")

// WebhookPost is a message a webhook posts. Its image fields (AvatarURL and
// the embeds' image, thumbnail and icon URLs) still name remote images;
// Images holds the ones that were downloaded. The others are dropped.
type WebhookPost struct {
	WebhookID id.ID
	ChannelID id.ID
	Username  string // overrides the webhook's name for this message; "" keeps it
	Content   string
	AvatarURL string // "" for the webhook's own avatar
	Embeds    []WebhookEmbed
	Images    map[string][]byte // remote URL -> downloaded bytes
}

// ImageURLs lists the remote images the post names, each once: the avatar
// first, then the embeds' in order.
func (p WebhookPost) ImageURLs() []string {
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	add(p.AvatarURL)
	for _, e := range p.Embeds {
		if e.Author != nil {
			add(e.Author.IconURL)
		}
		if e.Thumbnail != nil {
			add(e.Thumbnail.URL)
		}
		if e.Image != nil {
			add(e.Image.URL)
		}
		if e.Footer != nil {
			add(e.Footer.IconURL)
		}
	}
	return out
}

// localEmbeds returns copies of in with every remote image replaced by
// local(remote), and dropped where local returns "".
func localEmbeds(in []WebhookEmbed, local func(remote string) string) []WebhookEmbed {
	image := func(img *EmbedImage) *EmbedImage {
		if img == nil {
			return nil
		}
		if u := local(img.URL); u != "" {
			return &EmbedImage{URL: u}
		}
		return nil
	}
	out := make([]WebhookEmbed, 0, len(in))
	for _, e := range in {
		if e.Author != nil {
			a := *e.Author
			if a.IconURL != "" {
				a.IconURL = local(a.IconURL)
			}
			e.Author = &a
		}
		if e.Footer != nil {
			f := *e.Footer
			if f.IconURL != "" {
				f.IconURL = local(f.IconURL)
			}
			e.Footer = &f
		}
		e.Thumbnail, e.Image = image(e.Thumbnail), image(e.Image)
		out = append(out, e)
	}
	return out
}

// visible reports whether e shows anything: an embed whose images were all
// dropped may not.
func (e WebhookEmbed) visible() bool {
	return e.Title != "" || e.Description != "" || e.Author != nil || len(e.Fields) > 0 ||
		e.Thumbnail != nil || e.Image != nil || e.Footer != nil
}

type storedImage struct{ sum, contentType string }

// PostWebhook stores and publishes a webhook's message. @everyone and @here
// never mention anyone, not even users with those names; other user mentions,
// and mentionable roles work as in any message.
func (s *Service) PostWebhook(ctx context.Context, p WebhookPost) (*Message, error) {
	names := slices.DeleteFunc(parseMentions(p.Content), func(n string) bool { return n == "everyone" || n == "here" })
	mentions, err := s.resolveMentions(ctx, names)
	if err != nil {
		return nil, err
	}
	roles, err := s.roleMentionIDs(ctx, p.ChannelID, p.Content, false, maxMentions-len(mentions))
	if err != nil {
		return nil, err
	}
	m := &Message{ID: id.New(), ChannelID: p.ChannelID, Content: p.Content, Mentions: mentions, MentionRoles: roles, Attachments: []files.Attachment{}}
	m.CreatedAt = m.ID.Time()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// FOR SHARE: the webhook's avatar cannot be replaced (and its blob
	// removed) before this message holds its own reference to it.
	var name string
	var ownSum, ownType *string
	err = tx.QueryRow(ctx, `SELECT name, avatar_sha256, avatar_content_type FROM webhooks WHERE id = $1 FOR SHARE`, p.WebhookID).
		Scan(&name, &ownSum, &ownType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWebhookGone
	}
	if err != nil {
		return nil, err
	}
	if p.Username != "" {
		name = p.Username
	}
	stored := map[string]storedImage{} // remote URL -> this instance's copy
	for _, u := range p.ImageURLs() {
		data, ok := p.Images[u]
		if !ok {
			continue
		}
		sum, ct, err := s.blobs.StoreImageBlob(ctx, tx, data)
		var unreadable *httpx.Error
		if errors.As(err, &unreadable) { // served as an image, but not one we can read
			slog.InfoContext(ctx, "webhook image dropped", "url", linkpreview.LogURL(u), "err", err)
			continue
		}
		if err != nil {
			return nil, err
		}
		stored[u] = storedImage{sum, ct}
	}
	keep := map[string]string{} // sha256 -> content type: this message's message_images rows
	var avatar *string
	if img, ok := stored[p.AvatarURL]; ok {
		avatar = &img.sum
		keep[img.sum] = img.contentType
	} else if ownSum != nil && ownType != nil { // no avatar_url, or it failed: the webhook's own
		avatar = ownSum
		keep[*ownSum] = *ownType
	}
	m.Embeds = localEmbeds(p.Embeds, func(remote string) string {
		img, ok := stored[remote]
		if !ok {
			return ""
		}
		keep[img.sum] = img.contentType // an embed showing a stored image is visible, so kept
		return imageURL(m.ID, img.sum)
	})
	m.Embeds = slices.DeleteFunc(m.Embeds, func(e WebhookEmbed) bool { return !e.visible() })
	if m.Content == "" && len(m.Embeds) == 0 {
		return nil, ErrEmptyWebhookMessage
	}
	var embeds []byte
	if len(m.Embeds) == 0 {
		m.Embeds = nil
	} else if embeds, err = json.Marshal(m.Embeds); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO messages (id, channel_id, content, mentions, webhook_id, author_name, author_avatar_sha256, embeds, mention_roles)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		m.ID, m.ChannelID, m.Content, id.Int64s(mentions), p.WebhookID, name, avatar, embeds, id.Int64s(roles)); err != nil {
		return nil, err
	}
	for sum, ct := range keep {
		if _, err := tx.Exec(ctx, `INSERT INTO message_images (message_id, sha256, content_type) VALUES ($1, $2, $3)`,
			m.ID, sum, ct); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	m.Webhook = &WebhookAuthor{ID: &p.WebhookID, Name: name}
	if avatar != nil {
		m.Webhook.AvatarURL = imageURL(m.ID, *avatar)
	}
	one := []Message{*m}
	if err := s.hydrate(ctx, one); err != nil {
		return nil, err
	}
	m = &one[0]
	s.publish("MESSAGE_CREATE", m.ChannelID, m)
	s.attachPreview(*m)
	return m, nil
}

// ImageHandler serves GET /api/messages/{messageID}/images/{sha256}: a
// webhook message's avatar or embed image, to whoever can read its channel.
// It must run behind auth.RequireHTTP.
func (s *Service) ImageHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.serveImage(w, r); err != nil {
			httpx.WriteHTTPError(w, r, err)
		}
	})
}

func (s *Service) serveImage(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	mid, err := httpx.ParseID(r.PathValue("messageID"), "image")
	if err != nil {
		return err
	}
	sum := r.PathValue("sha256")
	if !files.ValidSum(sum) {
		return httpx.NotFound("image")
	}
	var channelID id.ID
	var contentType string
	err = s.db.QueryRow(ctx, `
		SELECT m.channel_id, i.content_type FROM message_images i JOIN messages m ON m.id = i.message_id
		WHERE i.message_id = $1 AND i.sha256 = $2`, mid, sum).Scan(&channelID, &contentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("image")
	}
	if err != nil {
		return err
	}
	if _, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, channelID, perms.ReadHistory); err != nil {
		var he *httpx.Error
		if errors.As(err, &he) {
			return httpx.NotFound("image") // do not reveal images in channels you cannot read
		}
		return err
	}
	s.blobs.ServePrivateBlob(w, r, sum, contentType)
	return nil
}
