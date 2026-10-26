package channels

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
)

// NotifySetting is how a user wants to hear about one channel; it is also the
// CHANNEL_NOTIFY_UPDATE event, sent only to that user.
type NotifySetting struct {
	ChannelID id.ID  `json:"channel_id"`
	Level     string `json:"level" enum:"default,all,mentions,nothing" doc:"default follows the device's own level"`
	Muted     bool   `json:"muted" doc:"Hides the channel's unread marker; notifies at most for mentions"`
}

type NotifyRequest struct {
	Level string `json:"level" enum:"default,all,mentions,nothing"`
	Muted bool   `json:"muted,omitempty"`
}

// NotifySettings lists the user's settings for these channels; channels left
// at the default have none.
func (s *Service) NotifySettings(ctx context.Context, userID id.ID, channelIDs []id.ID) ([]NotifySetting, error) {
	rows, err := s.db.Query(ctx, `SELECT channel_id, level, muted FROM channel_notify_settings
		WHERE user_id = $1 AND channel_id = ANY($2)`, userID, id.Int64s(channelIDs))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (NotifySetting, error) {
		var n NotifySetting
		err := r.Scan(&n.ChannelID, &n.Level, &n.Muted)
		return n, err
	})
}

func (s *Service) setNotify(ctx context.Context, userID id.ID, c *Channel, in NotifyRequest) (*NotifySetting, error) {
	if c.Type == TypeThread {
		return nil, httpx.BadRequest("NOTIFY_THREAD", "a thread follows its channel's notification setting")
	}
	var err error
	if in.Level == "default" && !in.Muted { // the default needs no row
		_, err = s.db.Exec(ctx, `DELETE FROM channel_notify_settings WHERE user_id = $1 AND channel_id = $2`, userID, c.ID)
	} else {
		_, err = s.db.Exec(ctx, `
			INSERT INTO channel_notify_settings (user_id, channel_id, level, muted) VALUES ($1, $2, $3, $4)
			ON CONFLICT (user_id, channel_id) DO UPDATE SET level = EXCLUDED.level, muted = EXCLUDED.muted`,
			userID, c.ID, in.Level, in.Muted)
	}
	if err != nil {
		return nil, err
	}
	n := &NotifySetting{ChannelID: c.ID, Level: in.Level, Muted: in.Muted}
	s.bus.Publish(events.Event{Type: "CHANNEL_NOTIFY_UPDATE", Data: n, Scope: events.Scope{UserIDs: []id.ID{userID}}})
	return n, nil
}
