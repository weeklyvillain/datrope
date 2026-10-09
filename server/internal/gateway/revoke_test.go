package gateway_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/id"
)

// These tests use fakes so a revocation can be placed exactly inside the
// IDENTIFY handshake.

const (
	userID     id.ID = 1
	authSessID id.ID = 2
	syncUser   id.ID = 999 // audience marker: the gateway reached this event
)

type fakes struct {
	bus    *events.Bus
	synced chan struct{}

	mu      sync.Mutex
	revoked bool
	calls   int

	onFirstAuth func() // runs inside the first (successful) Authenticate
	onBuild     func() // runs inside Ready.Build
}

func (f *fakes) Authenticate(ctx context.Context, token string) (*auth.Principal, error) {
	f.mu.Lock()
	f.calls++
	first, revoked := f.calls == 1, f.revoked
	f.mu.Unlock()
	if revoked {
		return nil, auth.ErrInvalidSession
	}
	if first && f.onFirstAuth != nil {
		f.onFirstAuth() // the session row was read before this revocation
	}
	return &auth.Principal{User: &auth.User{ID: userID}, SessionID: authSessID}, nil
}

func (f *fakes) Resolve(ctx context.Context, s events.Scope) ([]id.ID, error) {
	if slices.Contains(s.UserIDs, syncUser) {
		f.synced <- struct{}{}
		return nil, nil
	}
	return s.UserIDs, nil
}

func (f *fakes) Build(ctx context.Context, u *auth.User, sessionID string, status func(id.ID) string) (any, error) {
	if f.onBuild != nil {
		f.onBuild()
	}
	return map[string]string{"session_id": sessionID}, nil
}

// revoke does what auth does on logout (delete the row, then publish) and
// waits until the gateway has processed the event.
func (f *fakes) revoke() {
	f.mu.Lock()
	f.revoked = true
	f.mu.Unlock()
	f.bus.Publish(events.Event{Type: events.SessionsRevoked,
		Data: events.SessionsRevokedData{UserID: userID, SessionIDs: []id.ID{authSessID}}})
	f.bus.Publish(events.Event{Type: "SYNC", Scope: events.Scope{UserIDs: []id.ID{syncUser}}})
	select {
	case <-f.synced:
	case <-time.After(5 * time.Second):
		panic("gateway did not process the revocation")
	}
}

func newFakeGateway(t *testing.T, f *fakes) string {
	f.bus = &events.Bus{}
	f.synced = make(chan struct{}, 1)
	g := gateway.New(gateway.Deps{Auth: f, Audience: f, Ready: f, Bus: f.bus}, gateway.Options{})
	srv := httptest.NewServer(g)
	t.Cleanup(func() {
		srv.Close()
		g.Close()
	})
	return "ws" + strings.TrimPrefix(srv.URL, "http")
}

// identify connects, sends IDENTIFY (and then a HEARTBEAT), and returns the
// non-DISPATCH ops received until the connection closes or 2s pass without a frame.
func identify(t *testing.T, url string) (ops []string, code websocket.StatusCode) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, nil)
	require.NoError(t, err)
	defer ws.CloseNow()
	send := func(op string) {
		b, _ := json.Marshal(gateway.Frame{Op: op, D: json.RawMessage(`{"token":"t"}`)})
		_ = ws.Write(ctx, websocket.MessageText, b)
	}
	send(gateway.OpIdentify)
	sentHeartbeat := false
	for {
		rctx, rcancel := context.WithTimeout(ctx, 2*time.Second)
		_, b, err := ws.Read(rctx)
		rcancel()
		if err != nil {
			return ops, websocket.CloseStatus(err)
		}
		var f gateway.Frame
		require.NoError(t, json.Unmarshal(b, &f))
		if f.Op == gateway.OpDispatch {
			continue // presence updates arrive asynchronously
		}
		ops = append(ops, f.Op)
		if f.Op == gateway.OpReady && !sentHeartbeat {
			sentHeartbeat = true
			send(gateway.OpHeartbeat)
		}
		if f.Op == gateway.OpHeartbeatAck {
			return ops, -1 // still open and serving
		}
	}
}

func TestIdentifyWithoutRevocation(t *testing.T) {
	url := newFakeGateway(t, &fakes{})
	ops, _ := identify(t, url)
	require.Equal(t, []string{gateway.OpHello, gateway.OpReady, gateway.OpHeartbeatAck}, ops)
}

func TestRevokedDuringReadyBuildCloses4001(t *testing.T) {
	f := &fakes{}
	f.onBuild = f.revoke
	ops, code := identify(t, newFakeGateway(t, f))
	require.Equal(t, gateway.CloseSessionInvalid, code, "ops: %v", ops)
	require.NotContains(t, ops, gateway.OpReady)
}

func TestRevokedBeforeRegistrationCloses4001(t *testing.T) {
	f := &fakes{}
	f.onFirstAuth = f.revoke
	ops, code := identify(t, newFakeGateway(t, f))
	require.Equal(t, gateway.CloseSessionInvalid, code, "ops: %v", ops)
	require.NotContains(t, ops, gateway.OpReady)
}
