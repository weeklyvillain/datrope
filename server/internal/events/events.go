// Package events is the in-process event bus. Packages publish; the
// gateway subscribes and delivers to WebSocket clients (spec section 2.1).
package events

import (
	"sync"

	"github.com/datrope/datrope/server/internal/id"
)

// Scope says who receives an event. The gateway delivers to the union.
type Scope struct {
	CommunityID id.ID   // every member of this community
	ChannelID   id.ID   // everyone who can view this channel
	CoMembersOf id.ID   // everyone who shares the server with this user
	UserIDs     []id.ID // these users
}

type Event struct {
	Type  string // e.g. "MESSAGE_CREATE"; "internal." prefix = never sent to clients
	Data  any    // JSON-encoded as the event payload
	Scope Scope
}

// SessionsRevoked tells the gateway to close connections using these sessions.
const SessionsRevoked = "internal.SESSIONS_REVOKED"

type SessionsRevokedData struct {
	UserID     id.ID
	SessionIDs []id.ID // nil means every session of the user
}

type Bus struct {
	mu   sync.RWMutex
	subs []func(Event)
}

func (b *Bus) Subscribe(fn func(Event)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.subs = append(b.subs, fn)
}

// Publish calls every subscriber synchronously, in subscription order.
func (b *Bus) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, fn := range b.subs {
		fn(e)
	}
}
