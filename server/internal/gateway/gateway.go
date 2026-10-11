package gateway

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/time/rate"

	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/events"
	"github.com/datrope/datrope/server/internal/id"
)

type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*auth.Principal, error)
}

// Audience turns an event scope into user IDs.
type Audience interface {
	Resolve(ctx context.Context, s events.Scope) ([]id.ID, error)
}

// ReadyBuilder builds the READY payload. status reports other users'
// current presence.
type ReadyBuilder interface {
	Build(ctx context.Context, user *auth.User, sessionID string, status func(id.ID) string) (any, error)
}

type Deps struct {
	Auth     Authenticator
	Audience Audience
	Ready    ReadyBuilder
	Bus      *events.Bus
	// PublicOrigin is the web app's origin. The session cookie is only
	// accepted from it, which blocks cross-site WebSocket hijacking.
	PublicOrigin string
}

type Options struct {
	HeartbeatInterval time.Duration
	HeartbeatTimeout  time.Duration
	ResumeWindow      time.Duration
	MaxBuffer         int // replayable events kept per session
}

func (o *Options) defaults() {
	if o.HeartbeatInterval == 0 {
		o.HeartbeatInterval = 30 * time.Second
	}
	if o.HeartbeatTimeout == 0 {
		o.HeartbeatTimeout = 45 * time.Second
	}
	if o.ResumeWindow == 0 {
		o.ResumeWindow = 2 * time.Minute
	}
	if o.MaxBuffer == 0 {
		o.MaxBuffer = 1000
	}
}

type Gateway struct {
	d         Deps
	o         Options
	queue     chan events.Event
	done      chan struct{}
	closeOnce sync.Once

	mu       sync.Mutex
	sessions map[string]*session
	byUser   map[id.ID]map[*session]struct{}
}

// session survives disconnects for ResumeWindow so the client can resume.
type session struct {
	id     string
	userID id.ID
	authID id.ID // the auth session (for revocation)
	status string
	seq    uint64
	buf    []stamped
	conn   *conn // nil while disconnected
	goneAt time.Time
}

type stamped struct {
	f  Frame
	at time.Time
}

func (s *session) canReplayFrom(seq uint64) bool {
	if seq > s.seq {
		return false
	}
	if seq == s.seq {
		return true
	}
	return len(s.buf) > 0 && s.buf[0].f.S <= seq+1
}

type conn struct {
	ws   *websocket.Conn
	out  chan Frame
	once sync.Once
}

func (c *conn) send(f Frame) bool {
	select {
	case c.out <- f:
		return true
	default:
		return false
	}
}

// kill closes the connection. Safe to call repeatedly and while holding the
// gateway lock.
func (c *conn) kill(code websocket.StatusCode, reason string) {
	c.once.Do(func() { go c.ws.Close(code, reason) })
}

var errSessionInvalid = errors.New("session invalid")

func New(d Deps, o Options) *Gateway {
	o.defaults()
	g := &Gateway{
		d: d, o: o,
		queue:    make(chan events.Event, 4096),
		done:     make(chan struct{}),
		sessions: map[string]*session{},
		byUser:   map[id.ID]map[*session]struct{}{},
	}
	d.Bus.Subscribe(func(e events.Event) {
		select {
		case g.queue <- e:
		case <-g.done:
		}
	})
	go g.run()
	go g.janitor()
	return g
}

func (g *Gateway) Close() {
	g.closeOnce.Do(func() {
		close(g.done)
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, s := range g.sessions {
			if s.conn != nil {
				s.conn.kill(websocket.StatusGoingAway, "server shutting down")
			}
		}
	})
}

// StatusOf is the presence others see for a user.
func (g *Gateway) StatusOf(userID id.ID) string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.displayedLocked(userID)
}

// Connections counts sessions with an open WebSocket (not those waiting to be resumed).
func (g *Gateway) Connections() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	n := 0
	for _, s := range g.sessions {
		if s.conn != nil {
			n++
		}
	}
	return n
}

var statusRank = map[string]int{StatusInvisible: 1, StatusIdle: 2, StatusOnline: 3}

func (g *Gateway) displayedLocked(userID id.ID) string {
	best := ""
	for s := range g.byUser[userID] {
		if s.conn != nil && statusRank[s.status] > statusRank[best] {
			best = s.status
		}
	}
	if best == "" || best == StatusInvisible {
		return StatusOffline
	}
	return best
}

// publishPresence must not be called from the run loop (it would block on
// the loop's own queue).
func (g *Gateway) publishPresence(userID id.ID, status string) {
	g.d.Bus.Publish(events.Event{Type: "PRESENCE_UPDATE", Data: PresenceUpdate{UserID: userID, Status: status},
		Scope: events.Scope{CoMembersOf: userID, UserIDs: []id.ID{userID}}})
}

// --- event delivery ---------------------------------------------------

func (g *Gateway) run() {
	ctx := context.Background()
	for {
		select {
		case <-g.done:
			return
		case e := <-g.queue:
			g.dispatch(ctx, e)
		}
	}
}

func (g *Gateway) dispatch(ctx context.Context, e events.Event) {
	if e.Type == events.SessionsRevoked {
		g.revoke(e.Data.(events.SessionsRevokedData))
		return
	}
	if strings.HasPrefix(e.Type, "internal.") {
		return // never sent to clients
	}
	users, err := g.d.Audience.Resolve(ctx, e.Scope)
	if err != nil {
		slog.Error("resolve event audience", "type", e.Type, "err", err)
		return
	}
	data, err := json.Marshal(e.Data)
	if err != nil {
		slog.Error("encode event", "type", e.Type, "err", err)
		return
	}
	now := time.Now()
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, u := range users {
		for s := range g.byUser[u] {
			g.pushLocked(s, e.Type, data, now)
		}
	}
}

func (g *Gateway) pushLocked(s *session, typ string, data json.RawMessage, now time.Time) {
	s.seq++
	f := Frame{Op: OpDispatch, T: typ, S: s.seq, D: data}
	s.buf = append(s.buf, stamped{f: f, at: now})
	cut := 0
	for cut < len(s.buf) && (now.Sub(s.buf[cut].at) > g.o.ResumeWindow || len(s.buf)-cut > g.o.MaxBuffer) {
		cut++
	}
	s.buf = s.buf[cut:]
	if s.conn != nil && !s.conn.send(f) {
		s.conn.kill(CloseUnknown, "client too slow") // it can resume
	}
}

func (g *Gateway) revoke(d events.SessionsRevokedData) {
	g.mu.Lock()
	before := g.displayedLocked(d.UserID)
	for s := range g.byUser[d.UserID] {
		if d.SessionIDs == nil || slices.Contains(d.SessionIDs, s.authID) {
			if s.conn != nil {
				s.conn.kill(CloseSessionInvalid, "session revoked")
			}
			g.removeLocked(s)
		}
	}
	now := g.displayedLocked(d.UserID)
	g.mu.Unlock()
	if now != before {
		go g.publishPresence(d.UserID, now)
	}
}

func (g *Gateway) removeLocked(s *session) {
	delete(g.sessions, s.id)
	if set := g.byUser[s.userID]; set != nil {
		delete(set, s)
		if len(set) == 0 {
			delete(g.byUser, s.userID)
		}
	}
}

func (g *Gateway) janitor() {
	t := time.NewTicker(g.o.ResumeWindow / 4)
	defer t.Stop()
	for {
		select {
		case <-g.done:
			return
		case now := <-t.C:
			g.mu.Lock()
			for _, s := range g.sessions {
				if s.conn == nil && !s.goneAt.IsZero() && now.Sub(s.goneAt) > g.o.ResumeWindow {
					g.removeLocked(s)
				}
			}
			g.mu.Unlock()
		}
	}
}

// --- connections --------------------------------------------------------

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Native apps connect from other origins. Cookies are only honoured
		// from our own origin (below), which is what prevents hijacking.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(64 << 10)
	cookie := ""
	if g.d.PublicOrigin != "" && r.Header.Get("Origin") == g.d.PublicOrigin {
		if ck, err := r.Cookie(auth.CookieName); err == nil {
			cookie = ck.Value
		}
	}
	c := &conn{ws: ws, out: make(chan Frame, g.o.MaxBuffer+64)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go g.write(ctx, c)
	g.serve(ctx, c, cookie)
	c.kill(websocket.StatusNormalClosure, "")
}

func (g *Gateway) write(ctx context.Context, c *conn) {
	for {
		select {
		case <-ctx.Done():
			return
		case f := <-c.out:
			b, err := json.Marshal(f)
			if err != nil {
				continue
			}
			// Not derived from ctx: cancelling an in-flight write makes the
			// library drop the connection, losing a close frame being sent.
			wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err = c.ws.Write(wctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				c.kill(CloseUnknown, "write failed")
				return
			}
		}
	}
}

func (g *Gateway) read(ctx context.Context, c *conn) (Frame, error) {
	rctx, cancel := context.WithTimeout(ctx, g.o.HeartbeatTimeout)
	defer cancel()
	_, b, err := c.ws.Read(rctx) // on timeout the library closes the connection
	if err != nil {
		return Frame{}, err
	}
	var f Frame
	if err := json.Unmarshal(b, &f); err != nil {
		c.kill(CloseDecodeError, "invalid JSON")
		return Frame{}, err
	}
	return f, nil
}

func (g *Gateway) serve(ctx context.Context, c *conn, cookie string) {
	hello, _ := json.Marshal(Hello{HeartbeatInterval: g.o.HeartbeatInterval.Milliseconds()})
	c.send(Frame{Op: OpHello, D: hello})
	limiter := rate.NewLimiter(rate.Every(time.Second), 30)
	var s *session
	defer func() {
		if s != nil {
			g.detach(s, c)
		}
	}()
	for {
		f, err := g.read(ctx, c)
		if err != nil {
			return
		}
		if !limiter.Allow() {
			c.kill(CloseRateLimited, "rate limited")
			return
		}
		switch {
		case f.Op == OpHeartbeat:
			c.send(Frame{Op: OpHeartbeatAck})
		case s == nil && f.Op == OpIdentify:
			s, err = g.identify(ctx, c, f.D, cookie)
		case s == nil && f.Op == OpResume:
			s, err = g.resume(ctx, c, f.D, cookie)
		case s == nil:
			c.kill(CloseNotIdentified, "send IDENTIFY or RESUME first")
			return
		case f.Op == OpPresenceSet:
			var p PresenceSet
			_ = json.Unmarshal(f.D, &p)
			g.setStatus(s, p.Status)
		}
		if errors.Is(err, errSessionInvalid) {
			c.kill(CloseSessionInvalid, "session invalid")
			return
		}
		if err != nil {
			slog.Error("gateway", "err", err)
			c.kill(websocket.StatusInternalError, "internal error")
			return
		}
	}
}

func (g *Gateway) authenticate(ctx context.Context, token, cookie string) (*auth.Principal, error) {
	if token == "" {
		token = cookie
	}
	p, err := g.d.Auth.Authenticate(ctx, token)
	if errors.Is(err, auth.ErrInvalidSession) {
		return nil, errSessionInvalid
	}
	return p, err
}

func (g *Gateway) identify(ctx context.Context, c *conn, raw json.RawMessage, cookie string) (*session, error) {
	var d Identify
	_ = json.Unmarshal(raw, &d)
	p, err := g.authenticate(ctx, d.Token, cookie)
	if err != nil {
		return nil, err
	}
	s := &session{id: rand.Text(), userID: p.User.ID, authID: p.SessionID, status: normalStatus(d.Status)}
	// Register first (with no connection) so events that happen while READY
	// is being built are buffered, then flushed after READY.
	g.mu.Lock()
	g.sessions[s.id] = s
	if g.byUser[s.userID] == nil {
		g.byUser[s.userID] = map[*session]struct{}{}
	}
	g.byUser[s.userID][s] = struct{}{}
	g.mu.Unlock()

	// A revocation processed between the first check and registering found
	// nothing to close. Auth deletes the session before publishing the
	// revocation, so if it is still valid now, any later revocation will see
	// the registered session.
	if _, err := g.authenticate(ctx, d.Token, cookie); err != nil {
		g.mu.Lock()
		g.removeLocked(s)
		g.mu.Unlock()
		return nil, err
	}

	ready, err := g.d.Ready.Build(ctx, p.User, s.id, g.StatusOf)
	var b []byte
	if err == nil {
		b, err = json.Marshal(ready)
	}
	g.mu.Lock()
	if err != nil {
		g.removeLocked(s)
		g.mu.Unlock()
		return nil, err
	}
	if g.sessions[s.id] != s { // revoked while READY was being built
		g.mu.Unlock()
		return nil, errSessionInvalid
	}
	before := g.displayedLocked(s.userID)
	c.send(Frame{Op: OpReady, D: b})
	g.attachLocked(s, c, 0)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
	return s, nil
}

// resume reattaches a session. If it cannot be resumed the client gets
// INVALID_SESSION and may IDENTIFY on the same connection (nil, nil).
func (g *Gateway) resume(ctx context.Context, c *conn, raw json.RawMessage, cookie string) (*session, error) {
	var d Resume
	_ = json.Unmarshal(raw, &d)
	p, err := g.authenticate(ctx, d.Token, cookie)
	if err != nil {
		return nil, err
	}
	g.mu.Lock()
	s := g.sessions[d.SessionID]
	if s == nil || s.userID != p.User.ID || s.authID != p.SessionID || !s.canReplayFrom(d.Seq) {
		g.mu.Unlock()
		c.send(Frame{Op: OpInvalidSession})
		return nil, nil
	}
	before := g.displayedLocked(s.userID)
	c.send(Frame{Op: OpResumed})
	g.attachLocked(s, c, d.Seq)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
	return s, nil
}

// attachLocked makes c the session's connection, first replaying buffered
// events after seq `after`.
func (g *Gateway) attachLocked(s *session, c *conn, after uint64) {
	if s.conn != nil && s.conn != c {
		s.conn.kill(CloseReplaced, "session resumed elsewhere")
	}
	for _, st := range s.buf {
		if st.f.S > after {
			c.send(st.f)
		}
	}
	s.conn = c
	s.goneAt = time.Time{}
}

func (g *Gateway) detach(s *session, c *conn) {
	g.mu.Lock()
	before := g.displayedLocked(s.userID)
	if s.conn == c {
		s.conn = nil
		s.goneAt = time.Now()
	}
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
}

func (g *Gateway) setStatus(s *session, status string) {
	g.mu.Lock()
	before := g.displayedLocked(s.userID)
	s.status = normalStatus(status)
	now := g.displayedLocked(s.userID)
	g.mu.Unlock()
	if now != before {
		g.publishPresence(s.userID, now)
	}
}
