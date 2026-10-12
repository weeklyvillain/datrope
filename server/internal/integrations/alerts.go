package integrations

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/datrope/datrope/server/internal/audit"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/perms"
)

// StreamAlert: a channel follows a Twitch streamer, a YouTube channel or an RSS/Atom feed.
type StreamAlert struct {
	ID          id.ID  `json:"id"`
	ChannelID   id.ID  `json:"channel_id"`
	Platform    string `json:"platform" enum:"twitch,youtube,rss"`
	Account     string `json:"account" doc:"A Twitch login, a YouTube channel ID or a feed URL"`
	DisplayName string `json:"display_name"`
	URL         string `json:"url"`
	TitleFilter string `json:"title_filter" doc:"RSS: only entries whose title contains this are posted (empty: all)"`
}

type CreateAlertRequest struct {
	Platform    string `json:"platform" enum:"twitch,youtube,rss"`
	Account     string `json:"account" minLength:"1" maxLength:"200" doc:"Twitch: a username or channel link. YouTube: a channel link, @handle or channel ID. RSS: the feed URL"`
	Name        string `json:"name,omitempty" maxLength:"100" doc:"RSS: the name messages are posted under (default: the feed's title)"`
	TitleFilter string `json:"title_filter,omitempty" maxLength:"100" doc:"RSS: post only entries whose title contains this, in any case"`
}

const maxAlertsPerChannel = 20

var twitchLogin = regexp.MustCompile(`^[A-Za-z0-9_]{3,25}$`)

func errBadAccount(msg string) error { return httpx.BadRequest("BAD_ACCOUNT", msg) }

func idOf(v int64) id.ID { return id.ID(v) }

// markdownSpecial are the characters escapeMarkdown escapes.
const markdownSpecial = "\\`*_~|[]()<>#@:"

// escapeMarkdown keeps names and titles from other sites from formatting a message.
func escapeMarkdown(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(markdownSpecial, r) {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

func alertURL(platform, account string) string {
	switch platform {
	case "twitch":
		return "https://www.twitch.tv/" + account
	case "rss":
		return account
	}
	return "https://www.youtube.com/channel/" + account
}

// twitchLoginOf accepts a username or a twitch.tv link.
func twitchLoginOf(input string) (string, bool) {
	in := strings.TrimSpace(input)
	for _, p := range []string{"https://", "http://", "www.", "m."} {
		in = strings.TrimPrefix(in, p)
	}
	if rest, ok := strings.CutPrefix(strings.ToLower(in), "twitch.tv/"); ok {
		in = strings.SplitN(rest, "/", 2)[0]
	}
	in = strings.TrimPrefix(in, "@")
	return strings.ToLower(in), twitchLogin.MatchString(in)
}

// alertChannel checks the caller may manage alerts in a channel: it must
// take messages, and they need MANAGE_CHANNELS there.
func (s *Service) alertChannel(ctx context.Context, raw string) (*channels.Channel, error) {
	chID, err := httpx.ParseID(raw, "channel")
	if err != nil {
		return nil, err
	}
	ch, _, err := s.channels.Access(ctx, auth.Current(ctx).User.ID, chID, perms.ManageChannels)
	if err != nil {
		return nil, err
	}
	if ch.Type != channels.TypeText && ch.Type != channels.TypeAnnouncement {
		return nil, httpx.BadRequest("NOT_ALLOWED_HERE", "stream alerts go to text and announcement channels")
	}
	return ch, nil
}

// recordAlert adds an audit log entry about an alert in ch. Its name is the
// feed URL for RSS, else the platform and the followed account's name.
func recordAlert(ctx context.Context, q audit.Execer, action audit.Action, ch *channels.Channel, alertID id.ID, platform, account, displayName string) error {
	name := platform + ": " + displayName
	if platform == "rss" {
		name = account
	}
	return audit.Record(ctx, q, action, alertID, audit.LogDetails{Name: name, Channel: &audit.LogRef{ID: ch.ID, Name: ch.Name}})
}

func (s *Service) listAlerts(ctx context.Context, channelID id.ID) ([]StreamAlert, error) {
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, platform, account, display_name, title_filter FROM stream_alerts WHERE channel_id = $1 ORDER BY id`, channelID)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (StreamAlert, error) {
		var a StreamAlert
		err := r.Scan(&a.ID, &a.ChannelID, &a.Platform, &a.Account, &a.DisplayName, &a.TitleFilter)
		a.URL = alertURL(a.Platform, a.Account)
		return a, err
	})
	if out == nil {
		out = []StreamAlert{}
	}
	return out, err
}

func registerAlerts(api huma.API, s *Service, op func(string, string, string, int) huma.Operation) {
	huma.Register(api, op("list-stream-alerts", http.MethodGet, "/api/channels/{id}/alerts", 0),
		func(ctx context.Context, in *struct {
			ID string `path:"id"`
		}) (*struct{ Body []StreamAlert }, error) {
			ch, err := s.alertChannel(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			list, err := s.listAlerts(ctx, ch.ID)
			return &struct{ Body []StreamAlert }{list}, err
		})

	huma.Register(api, op("create-stream-alert", http.MethodPost, "/api/channels/{id}/alerts", http.StatusCreated),
		func(ctx context.Context, in *struct {
			ID   string `path:"id"`
			Body CreateAlertRequest
		}) (*struct{ Body *StreamAlert }, error) {
			ch, err := s.alertChannel(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			a := &StreamAlert{ID: id.New(), ChannelID: ch.ID, Platform: in.Body.Platform}
			var last string
			switch in.Body.Platform {
			case "twitch":
				login, ok := twitchLoginOf(in.Body.Account)
				if !ok {
					return nil, errBadAccount("use a Twitch username or a twitch.tv link")
				}
				users, err := s.twitchUsers(ctx, "login", []string{login})
				if errors.Is(err, ErrNotConfigured) {
					return nil, httpx.BadRequest("NOT_CONFIGURED", "an instance admin has to add Twitch credentials first")
				}
				if err != nil {
					return nil, err
				}
				if len(users) == 0 {
					return nil, errBadAccount("that Twitch user was not found")
				}
				a.Account, a.DisplayName = strings.ToLower(users[0].Login), users[0].DisplayName
			case "rss":
				u, ok := feedURLOf(in.Body.Account)
				if !ok {
					return nil, errBadAccount("use a feed URL starting with https://")
				}
				f, err := s.fetchFeed(ctx, u)
				if err != nil {
					return nil, errBadAccount("that URL is not an RSS or Atom feed")
				}
				a.Account, a.DisplayName = u, feedName(in.Body.Name, f.Title, u)
				a.TitleFilter = strings.TrimSpace(in.Body.TitleFilter)
				if len(f.Entries) > 0 {
					last = f.Entries[0].ID // only entries after now are posted
				}
			default:
				channelID, name, err := s.resolveYouTube(ctx, in.Body.Account)
				if err != nil {
					return nil, err
				}
				a.Account, a.DisplayName = channelID, name
				if f, err := s.youtubeFeed(ctx, channelID); err == nil && len(f.Entries) > 0 {
					last = f.Entries[0].VideoID // only videos after now are announced
				}
			}
			a.URL = alertURL(a.Platform, a.Account)
			var n int
			if err := s.db.QueryRow(ctx, `SELECT count(*) FROM stream_alerts WHERE channel_id = $1`, ch.ID).Scan(&n); err != nil {
				return nil, err
			}
			if n >= maxAlertsPerChannel {
				return nil, httpx.BadRequest("ALERT_LIMIT", "a channel can follow at most 20 streamers and channels")
			}
			tag, err := s.db.Exec(ctx, `
				INSERT INTO stream_alerts (id, channel_id, platform, account, display_name, created_by, last_item, title_filter)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
				a.ID, ch.ID, a.Platform, a.Account, a.DisplayName, auth.Current(ctx).User.ID, last, a.TitleFilter)
			if err != nil {
				return nil, err
			}
			if tag.RowsAffected() == 0 {
				return nil, httpx.E(http.StatusConflict, "ALREADY_FOLLOWED", "this channel already follows them")
			}
			if err := recordAlert(ctx, s.db, audit.AlertCreate, ch, a.ID, a.Platform, a.Account, a.DisplayName); err != nil {
				return nil, err
			}
			return &struct{ Body *StreamAlert }{a}, nil
		})

	huma.Register(api, op("delete-stream-alert", http.MethodDelete, "/api/channels/{id}/alerts/{alertID}", http.StatusNoContent),
		func(ctx context.Context, in *struct {
			ID      string `path:"id"`
			AlertID string `path:"alertID"`
		}) (*struct{}, error) {
			ch, err := s.alertChannel(ctx, in.ID)
			if err != nil {
				return nil, err
			}
			aid, err := httpx.ParseID(in.AlertID, "alert")
			if err != nil {
				return nil, err
			}
			var platform, account, displayName string
			err = s.db.QueryRow(ctx, `DELETE FROM stream_alerts WHERE id = $1 AND channel_id = $2 RETURNING platform, account, display_name`,
				aid, ch.ID).Scan(&platform, &account, &displayName)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, httpx.NotFound("alert")
			}
			if err != nil {
				return nil, err
			}
			return nil, recordAlert(ctx, s.db, audit.AlertDelete, ch, aid, platform, account, displayName)
		})
}

// pollTwitchAlerts posts in each channel following a streamer who just went live.
func (s *Service) pollTwitchAlerts(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id, channel_id, account, live FROM stream_alerts WHERE platform = 'twitch'`)
	if err != nil {
		return err
	}
	type alert struct {
		id, channelID int64
		login         string
		live          bool
	}
	alerts, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (alert, error) {
		var a alert
		return a, r.Scan(&a.id, &a.channelID, &a.login, &a.live)
	})
	if err != nil || len(alerts) == 0 {
		return err
	}
	logins := []string{}
	seen := map[string]bool{}
	for _, a := range alerts {
		if !seen[a.login] {
			seen[a.login] = true
			logins = append(logins, a.login)
		}
	}
	streams, err := s.twitchLive(ctx, "user_login", logins)
	if err != nil {
		return err
	}
	live := map[string]twitchStream{}
	for _, st := range streams {
		live[strings.ToLower(st.UserLogin)] = st
	}
	for _, a := range alerts {
		st, now := live[a.login]
		if now == a.live {
			continue
		}
		if _, err := s.db.Exec(ctx, `UPDATE stream_alerts SET live = $2 WHERE id = $1`, a.id, now); err != nil {
			return err
		}
		if !now {
			continue
		}
		content := "🔴 **" + escapeMarkdown(st.UserName) + "** is live on Twitch"
		if st.GameName != "" {
			content += " playing " + escapeMarkdown(st.GameName)
		}
		if st.Title != "" {
			content += ": " + escapeMarkdown(st.Title)
		}
		content += "\nhttps://www.twitch.tv/" + a.login
		if _, err := s.poster.PostAs(ctx, idOf(a.channelID), "Twitch", content); err != nil {
			return err
		}
	}
	return nil
}
