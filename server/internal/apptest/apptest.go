// Package apptest runs the whole app against a fresh database for
// end-to-end HTTP and WebSocket tests.
package apptest

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/auth"
	"github.com/datrope/datrope/server/internal/channels"
	"github.com/datrope/datrope/server/internal/communities"
	"github.com/datrope/datrope/server/internal/files"
	"github.com/datrope/datrope/server/internal/gateway"
	"github.com/datrope/datrope/server/internal/httpx"
	"github.com/datrope/datrope/server/internal/id"
	"github.com/datrope/datrope/server/internal/messages"
	"github.com/datrope/datrope/server/internal/perms"
	"github.com/datrope/datrope/server/internal/pgtest"
)

// PublicURL is the origin the tests pretend browsers use.
const PublicURL = "http://datrope.test"

type Env struct {
	T       *testing.T
	App     *app.App
	Pool    *pgxpool.Pool
	Server  *httptest.Server
	DataDir string
	owner   *Client // the first user to register: the server's owner
}

func New(t *testing.T) *Env { return NewWithConfig(t, nil) }

func NewWithConfig(t *testing.T, mutate func(*app.Config)) *Env {
	t.Helper()
	pool := pgtest.New(t)
	cfg := app.Config{PublicURL: PublicURL, DataDir: t.TempDir()}
	if mutate != nil {
		mutate(&cfg)
	}
	a := app.New(pool, cfg)
	srv := httptest.NewServer(a.Handler)
	t.Cleanup(func() {
		srv.Close()
		a.Close()
	})
	env := &Env{T: t, App: a, Pool: pool, Server: srv, DataDir: cfg.DataDir}
	// Tests create users freely; tests about registration modes change this.
	env.SetRegistrationMode(auth.ModeOpen)
	return env
}

// Client sends JSON requests, optionally as a signed-in user.
type Client struct {
	env    *Env
	Token  string      // sent as a bearer token when set
	Header http.Header // extra headers for every request
	User   *auth.User  // set by Register
}

func (e *Env) Anon() *Client { return &Client{env: e, Header: http.Header{}} }

// Do sends a request and fails the test unless the status is want. If out
// is non-nil the JSON response is decoded into it.
func (c *Client) Do(method, path string, body any, want int, out any) *http.Response {
	t := c.env.T
	t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		require.NoError(t, err)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.env.Server.URL+path, r)
	require.NoError(t, err)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range c.Header {
		req.Header[k] = v
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	if out != nil {
		require.NoError(t, json.Unmarshal(raw, out), string(raw))
	}
	return resp
}

// Fail sends a request that must fail with the given status and error code.
func (c *Client) Fail(method, path string, body any, wantStatus int, wantCode string) {
	c.env.T.Helper()
	var e httpx.Error
	c.Do(method, path, body, wantStatus, &e)
	require.Equal(c.env.T, wantCode, e.Code)
}

func (e *Env) SetRegistrationMode(mode string) {
	e.T.Helper()
	_, err := e.Pool.Exec(context.Background(), `UPDATE instance_settings SET registration_mode = $1`, mode)
	require.NoError(e.T, err)
}

// Register signs up a user (see RegisterWithInvite). The first user of an
// Env becomes the server's owner.
func (e *Env) Register(username string) *Client { return e.RegisterWithInvite(username, "") }

// RegisterWithInvite signs up with an invite code ("" for none) and password
// "password123", and returns a client signed in as the new user.
func (e *Env) RegisterWithInvite(username, code string) *Client {
	e.T.Helper()
	c := e.Anon()
	var res auth.AuthResult
	body := map[string]any{"username": username, "password": "password123", "device_name": "test", "client": "native"}
	if code != "" {
		body["invite_code"] = code
	}
	c.Do(http.MethodPost, "/api/auth/register", body, http.StatusOK, &res)
	c.Token, c.User = res.Token, res.User
	if e.owner == nil {
		e.owner = c
	}
	return c
}

// Outsider is a registered user who is not a member: the owner kicked them.
func (e *Env) Outsider(username string) *Client {
	e.T.Helper()
	c := e.Register(username)
	e.owner.Do(http.MethodDelete, "/api/server/members/"+c.User.ID.String(), nil, http.StatusNoContent, nil)
	return c
}

func (c *Client) Server() communities.ServerWithRoles {
	c.env.T.Helper()
	var out communities.ServerWithRoles
	c.Do(http.MethodGet, "/api/server", nil, http.StatusOK, &out)
	return out
}

// Invite creates an unlimited invite and returns its code.
func (c *Client) Invite() string {
	c.env.T.Helper()
	var inv communities.Invite
	c.Do(http.MethodPost, "/api/server/invites", map[string]any{}, http.StatusCreated, &inv)
	return inv.Code
}

// GuestInvite creates an unlimited guest invite whose guests stay ttl seconds.
func (c *Client) GuestInvite(ttl int) string {
	c.env.T.Helper()
	var inv communities.Invite
	c.Do(http.MethodPost, "/api/server/invites", map[string]any{"guest_ttl_seconds": ttl}, http.StatusCreated, &inv)
	return inv.Code
}

// GuestBody is the request body for POST /api/invites/{code}/guest.
func GuestBody(nick string) map[string]any {
	return map[string]any{"nick": nick, "device_name": "test", "client": "native"}
}

// JoinAsGuest joins with a guest invite and returns a client signed in as the guest.
func (e *Env) JoinAsGuest(code, nick string) *Client {
	e.T.Helper()
	c := e.Anon()
	var res auth.AuthResult
	c.Do(http.MethodPost, "/api/invites/"+code+"/guest", GuestBody(nick), http.StatusOK, &res)
	c.Token, c.User = res.Token, res.User
	return c
}

func (c *Client) Join(code string) {
	c.env.T.Helper()
	c.Do(http.MethodPost, "/api/invites/"+code+"/accept", nil, http.StatusNoContent, nil)
}

// Channels lists the channels c can see.
func (c *Client) Channels() []channels.Channel {
	c.env.T.Helper()
	var out []channels.Channel
	c.Do(http.MethodGet, "/api/server/channels", nil, http.StatusOK, &out)
	return out
}

// General returns the ID of the default #general channel.
func (c *Client) General() id.ID {
	c.env.T.Helper()
	for _, ch := range c.Channels() {
		if ch.Name == "general" {
			return ch.ID
		}
	}
	c.env.T.Fatal("no #general channel")
	return 0
}

func (c *Client) Send(channelID id.ID, content string) messages.Message {
	c.env.T.Helper()
	var m messages.Message
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages", map[string]any{"content": content}, http.StatusCreated, &m)
	return m
}

// WS is a gateway connection for tests. A goroutine reads frames into a
// channel so reads with timeouts never close the connection.
type WS struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan gateway.Frame
	closed chan websocket.StatusCode
	Seq    uint64 // sequence number of the last DISPATCH read
}

func (e *Env) Dial(h http.Header) *WS {
	e.T.Helper()
	url := "ws" + strings.TrimPrefix(e.Server.URL, "http") + "/ws"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: h})
	require.NoError(e.T, err)
	w := &WS{t: e.T, conn: conn, frames: make(chan gateway.Frame, 256), closed: make(chan websocket.StatusCode, 1)}
	go w.pump()
	e.T.Cleanup(func() { _ = conn.CloseNow() })
	w.Expect(gateway.OpHello)
	return w
}

// Connect dials, identifies as c, and returns the READY payload.
func (c *Client) Connect() (*WS, app.Ready) {
	c.env.T.Helper()
	w := c.env.Dial(nil)
	w.Send(gateway.OpIdentify, gateway.Identify{Token: c.Token})
	var r app.Ready
	require.NoError(c.env.T, json.Unmarshal(w.Expect(gateway.OpReady).D, &r))
	return w, r
}

func (w *WS) pump() {
	for {
		_, b, err := w.conn.Read(context.Background())
		if err != nil {
			w.closed <- websocket.CloseStatus(err)
			close(w.frames)
			return
		}
		var f gateway.Frame
		if json.Unmarshal(b, &f) == nil {
			w.frames <- f
		}
	}
}

func (w *WS) Send(op string, d any) {
	w.t.Helper()
	require.NoError(w.t, w.TrySend(op, d))
}

// TrySend is Send for when the server may close the connection mid-test.
func (w *WS) TrySend(op string, d any) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	b, err := json.Marshal(gateway.Frame{Op: op, D: raw})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return w.conn.Write(ctx, websocket.MessageText, b)
}

func (w *WS) next(timeout time.Duration) (gateway.Frame, bool) {
	select {
	case f, ok := <-w.frames:
		if ok && f.Op == gateway.OpDispatch {
			w.Seq = f.S
		}
		return f, ok
	case <-time.After(timeout):
		return gateway.Frame{}, false
	}
}

// Expect returns the next non-DISPATCH frame, which must have the given op.
// Dispatches arrive asynchronously (e.g. presence) and are skipped.
func (w *WS) Expect(op string) gateway.Frame {
	w.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := w.next(time.Until(deadline))
		require.True(w.t, ok, "waiting for %s: connection closed or timed out", op)
		if f.Op == gateway.OpDispatch && op != gateway.OpDispatch {
			continue
		}
		require.Equal(w.t, op, f.Op, "frame: %+v", f)
		return f
	}
}

// ExpectDispatch waits for a DISPATCH of type t, skipping everything else.
func (w *WS) ExpectDispatch(t string, out any) {
	w.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := w.next(time.Until(deadline))
		require.True(w.t, ok, "waiting for %s: connection closed or timed out", t)
		if f.Op == gateway.OpDispatch && f.T == t {
			if out != nil {
				require.NoError(w.t, json.Unmarshal(f.D, out))
			}
			return
		}
	}
}

// ExpectNoDispatch fails if a DISPATCH of type t arrives within wait.
func (w *WS) ExpectNoDispatch(t string, wait time.Duration) {
	w.t.Helper()
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		f, ok := w.next(time.Until(deadline))
		if !ok {
			return
		}
		require.False(w.t, f.Op == gateway.OpDispatch && f.T == t, "unexpected %s: %s", t, f.D)
	}
}

// ExpectClose waits for the server to close the connection.
func (w *WS) ExpectClose() websocket.StatusCode {
	w.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case code := <-w.closed:
			return code
		case <-w.frames: // drain so the reader can finish
		case <-deadline:
			w.t.Fatal("connection was not closed")
			return 0
		}
	}
}

func (w *WS) Close() { _ = w.conn.Close(websocket.StatusNormalClosure, "") }

// Raw sends a request with any body and returns the response and its body,
// failing the test unless the status is want.
func (c *Client) Raw(method, path string, body io.Reader, contentType string, want int) (*http.Response, []byte) {
	t := c.env.T
	t.Helper()
	req, err := http.NewRequest(method, c.env.Server.URL+path, body)
	require.NoError(t, err)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range c.Header {
		req.Header[k] = v
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	if resp.StatusCode != want {
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.StatusCode, want, raw)
	}
	return resp, raw
}

func multipartFile(t *testing.T, filename string, content []byte) (io.Reader, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = fw.Write(content)
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	return &buf, mw.FormDataContentType()
}

// Upload sends a file to POST /api/attachments.
func (c *Client) Upload(channelID id.ID, filename string, content []byte, want int) files.Attachment {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(http.MethodPost, "/api/attachments?channel_id="+channelID.String(), body, ct, want)
	var a files.Attachment
	if want == http.StatusCreated {
		require.NoError(c.env.T, json.Unmarshal(raw, &a), string(raw))
	}
	return a
}

// UploadTo sends content as the multipart "file" field to any path.
func (c *Client) UploadTo(method, path, filename string, content []byte, want int) []byte {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(method, path, body, ct, want)
	return raw
}

// UploadForm sends content as the multipart "file" field plus extra form fields to any path.
func (c *Client) UploadForm(method, path, filename string, content []byte, fields map[string]string, want int) []byte {
	t := c.env.T
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for k, v := range fields {
		require.NoError(t, mw.WriteField(k, v))
	}
	fw, err := mw.CreateFormFile("file", filename)
	require.NoError(t, err)
	_, err = fw.Write(content)
	require.NoError(t, err)
	require.NoError(t, mw.Close())
	_, raw := c.Raw(method, path, &buf, mw.FormDataContentType(), want)
	return raw
}

// UploadFail sends a file that must be rejected with the given status and code.
func (c *Client) UploadFail(channelID id.ID, filename string, content []byte, wantStatus int, wantCode string) {
	c.env.T.Helper()
	body, ct := multipartFile(c.env.T, filename, content)
	_, raw := c.Raw(http.MethodPost, "/api/attachments?channel_id="+channelID.String(), body, ct, wantStatus)
	var e httpx.Error
	require.NoError(c.env.T, json.Unmarshal(raw, &e), string(raw))
	require.Equal(c.env.T, wantCode, e.Code)
}

// SendWith sends a message with attachments.
func (c *Client) SendWith(channelID id.ID, content string, attachmentIDs ...id.ID) messages.Message {
	c.env.T.Helper()
	ids := make([]string, len(attachmentIDs))
	for i, a := range attachmentIDs {
		ids[i] = a.String()
	}
	var m messages.Message
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages",
		map[string]any{"content": content, "attachment_ids": ids}, http.StatusCreated, &m)
	return m
}

// CreateTextChannel creates a text channel and returns its ID.
func (c *Client) CreateTextChannel(name string) id.ID {
	c.env.T.Helper()
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/server/channels", map[string]any{"name": name, "type": "text"}, http.StatusCreated, &ch)
	return ch.ID
}

// CreatePrivateChannel creates a text channel that @everyone cannot see.
func (c *Client) CreatePrivateChannel(name string) id.ID {
	c.env.T.Helper()
	ch := c.CreateTextChannel(name)
	c.Do(http.MethodPut, "/api/channels/"+ch.String()+"/overrides/role/"+c.Server().ID.String(),
		map[string]any{"allow": 0, "deny": uint64(perms.ViewChannel)}, http.StatusOK, nil)
	return ch
}

// OpenDM opens (or finds) the direct message with another user.
func (c *Client) OpenDM(other id.ID) id.ID {
	c.env.T.Helper()
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/dms", map[string]any{"recipient_ids": []string{other.String()}}, http.StatusOK, &ch)
	return ch.ID
}

// CreateThread starts a named thread on a message and returns its channel ID.
func (c *Client) CreateThread(channelID, messageID id.ID, name string) id.ID {
	c.env.T.Helper()
	var ch channels.Channel
	c.Do(http.MethodPost, "/api/channels/"+channelID.String()+"/messages/"+messageID.String()+"/thread", map[string]any{"name": name}, http.StatusCreated, &ch)
	return ch.ID
}
