package messages

import (
	"context"

	"github.com/datrope/datrope/server/internal/id"
)

// PostAs posts content into a channel under a bare name, with no person or
// webhook behind it: stream alerts, say. Clients show it like a webhook
// message whose webhook is gone.
func (s *Service) PostAs(ctx context.Context, channelID id.ID, name, content string) (*Message, error) {
	m := &Message{ID: id.New(), ChannelID: channelID, Content: content, Mentions: []id.ID{}, Webhook: &WebhookAuthor{Name: name}}
	m.CreatedAt = m.ID.Time()
	if _, err := s.db.Exec(ctx, `INSERT INTO messages (id, channel_id, content, author_name) VALUES ($1, $2, $3, $4)`,
		m.ID, channelID, content, name); err != nil {
		return nil, err
	}
	one := []Message{*m}
	if err := s.hydrate(ctx, one); err != nil {
		return nil, err
	}
	m = &one[0]
	s.publish("MESSAGE_CREATE", channelID, m)
	s.attachPreview(*m)
	return m, nil
}
