// Package gateway is the realtime WebSocket (spec section 5.2). It subscribes
// to the event bus and delivers each event to the users allowed to see it.
//
// Protocol (frames are JSON text messages {"op", "d", "s", "t"}):
//
//	S->C HELLO            {heartbeat_interval} (ms), sent on connect
//	C->S IDENTIFY         {token?, status?}; browsers omit token (cookie used)
//	S->C READY            session ID, user, server, DMs, presences, read states
//	C->S RESUME           {session_id, seq, token?}
//	S->C RESUMED          then every missed DISPATCH with s > seq
//	S->C INVALID_SESSION  the client must IDENTIFY again on the same connection
//	S->C DISPATCH         t = event type, s = sequence number, d = payload
//	C->S HEARTBEAT        every heartbeat_interval; answered with HEARTBEAT_ACK
//	C->S PRESENCE_SET     {status: "online"|"idle"|"invisible"}
package gateway

import (
	"encoding/json"

	"github.com/coder/websocket"

	"github.com/datrope/datrope/server/internal/id"
)

const (
	OpHello          = "HELLO"
	OpIdentify       = "IDENTIFY"
	OpResume         = "RESUME"
	OpReady          = "READY"
	OpResumed        = "RESUMED"
	OpDispatch       = "DISPATCH"
	OpHeartbeat      = "HEARTBEAT"
	OpHeartbeatAck   = "HEARTBEAT_ACK"
	OpInvalidSession = "INVALID_SESSION"
	OpPresenceSet    = "PRESENCE_SET"
)

// Close codes. 4001 means "sign in again", 4008 "back off"; for anything
// else the client reconnects with backoff and tries RESUME.
const (
	CloseUnknown        websocket.StatusCode = 4000
	CloseSessionInvalid websocket.StatusCode = 4001
	CloseNotIdentified  websocket.StatusCode = 4002
	CloseDecodeError    websocket.StatusCode = 4003
	CloseRateLimited    websocket.StatusCode = 4008
	CloseReplaced       websocket.StatusCode = 4010
)

const (
	StatusOnline    = "online"
	StatusIdle      = "idle"
	StatusInvisible = "invisible" // shown to others as offline
	StatusOffline   = "offline"
)

type Frame struct {
	Op string          `json:"op"`
	D  json.RawMessage `json:"d,omitempty"`
	S  uint64          `json:"s,omitempty"`
	T  string          `json:"t,omitempty"`
}

type Hello struct {
	HeartbeatInterval int64 `json:"heartbeat_interval" doc:"Milliseconds between client HEARTBEATs"`
}

type Identify struct {
	Token  string `json:"token,omitempty"`
	Status string `json:"status,omitempty"`
}

type Resume struct {
	SessionID string `json:"session_id"`
	Seq       uint64 `json:"seq"`
	Token     string `json:"token,omitempty"`
}

type PresenceSet struct {
	Status string `json:"status"`
}

type PresenceUpdate struct {
	UserID id.ID  `json:"user_id"`
	Status string `json:"status" enum:"online,idle,offline"`
}

func normalStatus(s string) string {
	switch s {
	case StatusIdle, StatusInvisible:
		return s
	default:
		return StatusOnline
	}
}
