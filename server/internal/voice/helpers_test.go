package voice_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/lktest"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/voice"
)

// liveKitEnv runs the app against the shared test LiveKit server.
func liveKitEnv(t *testing.T) (*apptest.Env, voice.Config) {
	t.Helper()
	cfg := lktest.New(t)
	return apptest.NewWithConfig(t, func(c *app.Config) { c.LiveKit = cfg }), cfg
}

// stubLiveKit is a LiveKit API that answers Twirp calls from memory, for
// tests of webhooks and sync that need no media. Joining fails with
// VOICE_UNAVAILABLE unless createOK, because CreateRoom answers 503.
type stubLiveKit struct {
	cfg      voice.Config
	createOK bool

	mu    sync.Mutex
	rooms map[string][]*livekit.ParticipantInfo
	// onParticipants runs while a ListParticipants call is being answered,
	// to let a test make something happen in the middle of a sync.
	onParticipants func()
	listed         int // ListRooms calls so far
}

func newStubLiveKit(t *testing.T, createOK bool) *stubLiveKit {
	t.Helper()
	st := &stubLiveKit{createOK: createOK, rooms: map[string][]*livekit.ParticipantInfo{}}
	srv := httptest.NewServer(http.HandlerFunc(st.serve))
	t.Cleanup(srv.Close)
	st.cfg = voice.Config{URL: srv.URL, PublicURL: "ws" + strings.TrimPrefix(srv.URL, "http"),
		APIKey: lktest.APIKey, APISecret: lktest.APISecret}
	return st
}

// offline is a LiveKit that is up but refuses to create rooms.
func offline(t *testing.T) voice.Config { return newStubLiveKit(t, false).cfg }

// awaitStartupSync waits for the app's own first sync (it runs in the
// background right after startup) so it cannot interleave with a test.
func (st *stubLiveKit) awaitStartupSync(t *testing.T) {
	t.Helper()
	require.Eventually(t, func() bool {
		st.mu.Lock()
		defer st.mu.Unlock()
		return st.listed > 0
	}, settle, poll)
	time.Sleep(50 * time.Millisecond) // let it finish
}

func (st *stubLiveKit) setRoom(channelID id.ID, ps ...*livekit.ParticipantInfo) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.rooms[channelID.String()] = ps
}

func (st *stubLiveKit) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var out proto.Message = &livekit.Room{}
	switch path.Base(r.URL.Path) {
	case "CreateRoom":
		if !st.createOK {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
	case "ListRooms":
		res := &livekit.ListRoomsResponse{}
		st.mu.Lock()
		st.listed++
		for name := range st.rooms {
			res.Rooms = append(res.Rooms, &livekit.Room{Name: name})
		}
		st.mu.Unlock()
		out = res
	case "ListParticipants":
		var req livekit.ListParticipantsRequest
		_ = proto.Unmarshal(body, &req)
		st.mu.Lock()
		hook := st.onParticipants
		st.mu.Unlock()
		if hook != nil {
			hook()
		}
		st.mu.Lock()
		out = &livekit.ListParticipantsResponse{Participants: st.rooms[req.Room]}
		st.mu.Unlock()
	}
	b, _ := proto.Marshal(out)
	w.Header().Set("Content-Type", "application/protobuf")
	_, _ = w.Write(b)
}

// club is the server with its owner (also the instance admin), a member,
// #general, and a voice channel.
type club struct {
	owner, member *apptest.Client
	community     communities.ServerWithRoles
	voiceID       id.ID
	textID        id.ID
}

func newClub(t *testing.T, env *apptest.Env) club {
	t.Helper()
	alice := env.Register("alice")
	bob := env.Register("bob")
	return club{owner: alice, member: bob, community: alice.Server(), voiceID: createVoice(alice, "Lounge"), textID: alice.General()}
}

func createVoice(owner *apptest.Client, name string) id.ID {
	var ch channels.Channel
	owner.Do(http.MethodPost, "/api/server/channels",
		map[string]any{"name": name, "type": "voice"}, http.StatusCreated, &ch)
	return ch.ID
}

func joinPath(channelID id.ID) string { return "/api/voice/" + channelID.String() + "/join" }

func join(c *apptest.Client, channelID id.ID) voice.JoinResponse {
	var res voice.JoinResponse
	c.Do(http.MethodPost, joinPath(channelID), map[string]any{}, http.StatusOK, &res)
	return res
}

// setEveryone sets the @everyone role's permissions (its ID is the server's).
func setEveryone(owner *apptest.Client, serverID id.ID, p perms.Perms) {
	owner.Do(http.MethodPatch, "/api/server/roles/"+serverID.String(),
		map[string]any{"permissions": p}, http.StatusOK, nil)
}

// deny puts an @everyone override denying p on a channel.
func deny(owner *apptest.Client, channelID, serverID id.ID, p perms.Perms) {
	owner.Do(http.MethodPut, "/api/channels/"+channelID.String()+"/overrides/role/"+serverID.String(),
		map[string]any{"allow": 0, "deny": p}, http.StatusOK, nil)
}
