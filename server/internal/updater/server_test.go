package updater

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeLister []ContainerInfo

func (f fakeLister) Containers(context.Context, string) ([]ContainerInfo, error) { return f, nil }

func newTestServer(t *testing.T) (*httptest.Server, *fakeCmd, *Jobs) {
	f := &fakeCmd{out: map[string]string{"config --services": "server\n", "rev-list --count HEAD..origin/main": "0\n"}}
	jobs, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	s := &Server{
		Token:   "secret",
		Git:     &Git{Dir: "/r", Run: f.run},
		Jobs:    jobs,
		Docker:  fakeLister{{Service: "server"}, {Service: "updater"}},
		Compose: Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run},
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv, f, jobs
}

func call(t *testing.T, srv *httptest.Server, method, path, token string) *http.Response {
	req, _ := http.NewRequest(method, srv.URL+path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func TestServerNeedsToken(t *testing.T) {
	srv, _, _ := newTestServer(t)
	require.Equal(t, http.StatusUnauthorized, call(t, srv, "GET", "/status", "").StatusCode)
	require.Equal(t, http.StatusUnauthorized, call(t, srv, "GET", "/status", "wrong").StatusCode)
	require.Equal(t, http.StatusOK, call(t, srv, "GET", "/status", "secret").StatusCode)
}

func TestServerUpdateAndJobLog(t *testing.T) {
	srv, _, jobs := newTestServer(t)
	res := call(t, srv, "POST", "/update", "secret")
	require.Equal(t, http.StatusAccepted, res.StatusCode)
	var started struct {
		JobID string `json:"job_id"`
	}
	require.NoError(t, json.NewDecoder(res.Body).Decode(&started))
	jobs.Wait()

	res = call(t, srv, "GET", "/jobs/"+started.JobID+"?after=0", "secret")
	require.Equal(t, http.StatusOK, res.StatusCode)
	var log UpdateJobLog
	require.NoError(t, json.NewDecoder(res.Body).Decode(&log))
	require.Equal(t, StatusSucceeded, log.Job.Status)

	require.Equal(t, http.StatusNotFound, call(t, srv, "GET", "/jobs/12a?after=0", "secret").StatusCode)
}

func TestServerRestartWhitelist(t *testing.T) {
	srv, f, _ := newTestServer(t)
	require.Equal(t, http.StatusNoContent, call(t, srv, "POST", "/containers/server/restart", "secret").StatusCode)
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], "restart server"))
	n := len(f.calls)
	require.Equal(t, http.StatusNotFound, call(t, srv, "POST", "/containers/updater/restart", "secret").StatusCode)
	require.Equal(t, http.StatusNotFound, call(t, srv, "POST", "/containers/nope/restart", "secret").StatusCode)
	require.Len(t, f.calls, n, "rejected names never reach docker compose")
}

func TestServerEmptyTokenRejectsEverything(t *testing.T) {
	s := &Server{Token: "", Git: &Git{Dir: "/r", Run: (&fakeCmd{}).run}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	require.Equal(t, http.StatusUnauthorized, call(t, srv, "GET", "/status", "").StatusCode)
	req, _ := http.NewRequest("GET", srv.URL+"/status", nil)
	req.Header.Set("Authorization", "Bearer ")
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer res.Body.Close()
	require.Equal(t, http.StatusUnauthorized, res.StatusCode)
}

// The restart must survive the caller hanging up (restarting the server drops its connection).
func TestServerRestartSurvivesCallerCancel(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var ctxErr error
	done := make(chan struct{})
	run := func(ctx context.Context, _ io.Writer, _ string, _ ...string) error {
		close(started)
		<-cancelled
		select { // give the server time to notice the dropped connection
		case <-ctx.Done():
		case <-time.After(300 * time.Millisecond):
		}
		ctxErr = ctx.Err()
		close(done)
		return nil
	}
	jobs, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	s := &Server{Token: "secret", Git: &Git{Dir: "/r", Run: run}, Jobs: jobs,
		Docker: fakeLister{{Service: "server"}}, Compose: Compose{Dir: "/r/deploy", Project: "datrope", Run: run}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+"/containers/server/restart", nil)
	req.Header.Set("Authorization", "Bearer secret")
	go func() { _, _ = http.DefaultClient.Do(req) }()
	<-started
	cancel()
	close(cancelled)
	<-done
	require.NoError(t, ctxErr, "compose must not be cancelled when the caller hangs up")
}

// A client hanging up must not kill git mid-fetch (it would leave stale .lock files).
func TestServerCheckSurvivesCallerCancel(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var fetchErr error
	done := make(chan struct{})
	run := func(ctx context.Context, _ io.Writer, _ string, args ...string) error {
		if !slices.Contains(args, "fetch") {
			return nil
		}
		close(started)
		<-cancelled
		select { // give the server time to notice the dropped connection
		case <-ctx.Done():
		case <-time.After(300 * time.Millisecond):
		}
		fetchErr = ctx.Err()
		close(done)
		return nil
	}
	s := &Server{Token: "secret", Git: &Git{Dir: "/r", Run: run}}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", srv.URL+"/check", nil)
	req.Header.Set("Authorization", "Bearer secret")
	go func() { _, _ = http.DefaultClient.Do(req) }()
	<-started
	cancel()
	close(cancelled)
	<-done
	require.NoError(t, fetchErr, "git must not be cancelled when the caller hangs up")
}
