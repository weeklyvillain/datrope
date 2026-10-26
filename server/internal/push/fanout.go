package push

import (
	"context"
	"encoding/json"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
)

const (
	queueSize = 1024
	workers   = 4
	capWindow = 10 * time.Second
	sendLimit = 15 * time.Second
)

type fanout struct {
	s     *Service
	queue chan *messages.Message
	done  chan struct{}
	stop  sync.Once
	wg    sync.WaitGroup

	capMu sync.Mutex
	last  map[capKey]capEntry
}

type capKey struct{ sub, channel id.ID }

// capEntry remembers when a slot was taken and whether an urgent (mention) push took it.
type capEntry struct {
	at     time.Time
	urgent bool
}

func newFanout(s *Service) *fanout {
	return &fanout{s: s, queue: make(chan *messages.Message, queueSize), done: make(chan struct{}), last: map[capKey]capEntry{}}
}

func (f *fanout) start() {
	if f.s.o.Inline {
		return
	}
	for range workers {
		f.wg.Add(1)
		go func() {
			defer f.wg.Done()
			for {
				select {
				case m := <-f.queue:
					f.handle(context.Background(), m)
				case <-f.done:
					return
				}
			}
		}()
	}
}

func (f *fanout) close() {
	f.stop.Do(func() { close(f.done) })
	f.wg.Wait()
}

// onEvent runs inside Bus.Publish, so it only enqueues.
func (f *fanout) onEvent(e events.Event) {
	if e.Type != "MESSAGE_CREATE" {
		return
	}
	var m *messages.Message
	switch d := e.Data.(type) {
	case *messages.Message:
		m = d
	case messages.Message:
		m = &d
	default:
		return
	}
	if (m.Kind != "" && m.Kind != messages.KindReminder) || m.Deleted { // "X left the group" is not worth a push
		return
	}
	if f.s.o.Inline {
		f.handle(context.Background(), m)
		return
	}
	select {
	case f.queue <- m:
	default:
		slog.Warn("push: queue full, dropping message", "message_id", m.ID)
	}
}

func (f *fanout) handle(ctx context.Context, m *messages.Message) {
	if err := f.deliver(ctx, m); err != nil {
		slog.Error("push: deliver", "message_id", m.ID, "err", err)
	}
}

func (f *fanout) deliver(ctx context.Context, m *messages.Message) error {
	s := f.s
	ch, err := s.d.Channels.Get(ctx, m.ChannelID)
	if err != nil {
		return err
	}
	users, err := s.d.Audience.Resolve(ctx, events.Scope{ChannelID: m.ChannelID})
	if err != nil {
		return err
	}
	var authorID id.ID
	if m.Author != nil {
		authorID = m.Author.ID
	}
	users = slices.DeleteFunc(users, func(u id.ID) bool { return u == authorID || s.active(u) })
	if len(users) == 0 {
		return nil
	}
	subs, err := s.subscriptionsOf(ctx, users)
	if err != nil || len(subs) == 0 {
		return err
	}

	var parent *channels.Channel
	if ch.ParentChannelID != nil {
		parent, _ = s.d.Channels.Get(ctx, *ch.ParentChannelID) // only for the title; a missing parent falls back to the thread's name
	}
	author, webhook := "Someone", false
	switch {
	case m.Webhook != nil:
		author, webhook = m.Webhook.Name, true
	case m.Author != nil && m.Author.DisplayName != "":
		author = m.Author.DisplayName
	case m.Author != nil:
		author = m.Author.Username
	}
	url, tag := target(ch)
	icon := ""
	if sv, err := s.d.Server.Server(ctx); err == nil && sv != nil && sv.IconURL != nil {
		icon = "/api/server/icon/192.png" + iconVersion(*sv.IconURL)
	}
	isDM := ch.Type == "dm"
	key := m.ChannelID // a thread follows its channel's setting
	if ch.Type == channels.TypeThread && ch.ParentChannelID != nil {
		key = *ch.ParentChannelID
	}
	prefs, err := s.channelNotify(ctx, key, users)
	if err != nil {
		return err
	}

	roles := map[id.ID][]id.ID{} // per recipient, loaded only when a role was pinged
	for _, sub := range subs {
		level := effectiveLevel(sub.Level, prefs[sub.UserID])
		if level == "nothing" {
			continue
		}
		mentioned := isDM || m.MentionEveryone || slices.Contains(m.Mentions, sub.UserID)
		if !mentioned && len(m.MentionRoles) > 0 {
			r, ok := roles[sub.UserID]
			if !ok {
				if r, err = s.roleIDs(ctx, sub.UserID); err != nil {
					return err
				}
				roles[sub.UserID] = r
			}
			mentioned = slices.ContainsFunc(m.MentionRoles, func(x id.ID) bool { return slices.Contains(r, x) })
		}
		if level == "mentions" && !mentioned {
			continue
		}
		if !f.allow(sub.ID, m.ChannelID, time.Now(), mentioned) {
			continue
		}
		payload, _ := json.Marshal(Payload{Title: title(author, webhook, ch, parent), Body: body(m.Content, len(m.Attachments)), URL: url, Tag: tag, Icon: icon})
		f.send(ctx, sub, payload, mentioned)
	}
	return nil
}

// allow applies the per-subscription, per-channel cap. A mention may still go
// out when the slot in the window was taken by a plain message.
func (f *fanout) allow(sub, channel id.ID, now time.Time, urgent bool) bool {
	f.capMu.Lock()
	defer f.capMu.Unlock()
	k := capKey{sub, channel}
	if e, ok := f.last[k]; ok && now.Sub(e.at) < capWindow && (e.urgent || !urgent) {
		return false
	}
	f.last[k] = capEntry{now, urgent}
	if len(f.last) > 10_000 { // forget expired entries now and then
		for k, e := range f.last {
			if now.Sub(e.at) >= capWindow {
				delete(f.last, k)
			}
		}
	}
	return true
}

func (f *fanout) send(ctx context.Context, sub Subscription, payload []byte, urgent bool) {
	ctx, cancel := context.WithTimeout(ctx, sendLimit)
	defer cancel()
	status, err := f.s.sender.Send(ctx, sub, payload, urgent)
	switch {
	case err != nil:
		slog.Warn("push: send", "subscription", sub.ID, "err", err)
	case gone(status):
		if err := f.s.removeByID(ctx, sub.ID); err != nil {
			slog.Error("push: prune", "subscription", sub.ID, "err", err)
		}
	case status >= 300:
		slog.Warn("push: rejected", "subscription", sub.ID, "status", status)
	default:
		if err := f.s.touch(ctx, sub.ID); err != nil {
			slog.Warn("push: touch", "subscription", sub.ID, "err", err)
		}
	}
}
