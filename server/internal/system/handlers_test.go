package system_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/datrope/datrope/server/internal/app"
	"github.com/datrope/datrope/server/internal/apptest"
	"github.com/datrope/datrope/server/internal/system"
	"github.com/datrope/datrope/server/internal/updater"
)

// fakeUpdater answers like the updater container, checking the token.
func fakeUpdater(t *testing.T) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /containers", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode([]updater.ContainerInfo{{Service: "server", State: "running", Status: "Up 1 hour"}})
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(updater.GitStatus{Current: "aaa", Latest: "bbb", Behind: 1, Commits: []updater.GitCommit{{SHA: "bbb", Subject: "Fix"}}})
	})
	mux.HandleFunc("POST /update", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"job_id":"00000000000000000042"}`))
	})
	mux.HandleFunc("GET /jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "00000000000000000042" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no such job"}`))
			return
		}
		_ = json.NewEncoder(w).Encode(updater.UpdateJobLog{Job: updater.UpdateJob{ID: "00000000000000000042", Status: "running"}, Lines: []string{"x"}, Next: 4})
	})
	mux.HandleFunc("POST /containers/{service}/restart", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("service") != "server" {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no such service"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func withUpdater(url string) func(*app.Config) {
	return func(c *app.Config) { c.UpdaterURL, c.UpdaterToken = url, "tok" }
}

func TestSystemAdminOnly(t *testing.T) {
	env := apptest.New(t)
	env.Register("admin")
	bob := env.Register("bob")
	bob.Fail(http.MethodGet, "/api/admin/system/stats", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodGet, "/api/admin/system/updates", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/updates/ytdlp", nil, http.StatusForbidden, "MISSING_PERMISSION")
	bob.Fail(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusForbidden, "MISSING_PERMISSION")
}

func TestSystemWithoutUpdater(t *testing.T) {
	env := apptest.New(t)
	admin := env.Register("admin")
	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.False(t, st.UpdaterConfigured)
	require.NotNil(t, st.Containers)

	var up system.SystemUpdates
	admin.Do(http.MethodGet, "/api/admin/system/updates", nil, http.StatusOK, &up)
	require.False(t, up.Server.Configured)
	admin.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED")
	admin.Fail(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusServiceUnavailable, "UPDATER_NOT_CONFIGURED")
}

func TestSystemWithUpdater(t *testing.T) {
	up := fakeUpdater(t)
	env := apptest.NewWithConfig(t, withUpdater(up.URL))
	admin := env.Register("admin")

	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.True(t, st.UpdaterConfigured)
	require.Empty(t, st.UpdaterError)
	require.Equal(t, "server", st.Containers[0].Service)

	var u system.SystemUpdates
	admin.Do(http.MethodGet, "/api/admin/system/updates", nil, http.StatusOK, &u)
	require.Equal(t, 1, u.Server.Status.Behind)

	var started system.UpdateStarted
	admin.Do(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusAccepted, &started)
	require.Equal(t, "00000000000000000042", started.JobID)

	var log updater.UpdateJobLog
	admin.Do(http.MethodGet, "/api/admin/system/jobs/00000000000000000042?after=3", nil, http.StatusOK, &log)
	require.Equal(t, 4, log.Next)
	admin.Fail(http.MethodGet, "/api/admin/system/jobs/00000000000000000043", nil, http.StatusNotFound, "NOT_FOUND")

	admin.Do(http.MethodPost, "/api/admin/system/containers/server/restart", nil, http.StatusNoContent, nil)
	admin.Fail(http.MethodPost, "/api/admin/system/containers/nope/restart", nil, http.StatusNotFound, "NOT_FOUND")
}

func TestSystemUpdaterDown(t *testing.T) {
	up := fakeUpdater(t)
	url := up.URL
	up.Close()
	env := apptest.NewWithConfig(t, withUpdater(url))
	admin := env.Register("admin")

	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.NotEmpty(t, st.UpdaterError, "host metrics still load")
	admin.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusServiceUnavailable, "UPDATER_UNREACHABLE")
}

func TestSystemSlowUpdater(t *testing.T) {
	old := system.ReadTimeout
	system.ReadTimeout = 100 * time.Millisecond
	t.Cleanup(func() { system.ReadTimeout = old })
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-done:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() { close(done); srv.Close() })
	env := apptest.NewWithConfig(t, withUpdater(srv.URL))
	admin := env.Register("admin")

	start := time.Now()
	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.Less(t, time.Since(start), 5*time.Second)
	require.NotEmpty(t, st.UpdaterError, "host metrics still load")
	require.True(t, st.UpdaterConfigured)
	admin.Fail(http.MethodGet, "/api/admin/system/jobs/1", nil, http.StatusServiceUnavailable, "UPDATER_UNREACHABLE")
}

func TestSystemBadToken(t *testing.T) {
	up := fakeUpdater(t)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.UpdaterURL, c.UpdaterToken = up.URL, "wrong" })
	admin := env.Register("admin")
	var st system.SystemStats
	admin.Do(http.MethodGet, "/api/admin/system/stats", nil, http.StatusOK, &st)
	require.Contains(t, st.UpdaterError, "DATROPE_UPDATER_TOKEN")
}

func TestSystemUpdateAlreadyRunning(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/update" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if calls.Add(1) > 1 {
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"an update is already running"}`))
			return
		}
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"job_id":"1"}`))
	}))
	t.Cleanup(srv.Close)
	env := apptest.NewWithConfig(t, func(c *app.Config) { c.UpdaterURL, c.UpdaterToken = srv.URL, "tok" })
	admin := env.Register("admin")
	admin.Do(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusAccepted, nil)
	admin.Fail(http.MethodPost, "/api/admin/system/updates/server", nil, http.StatusConflict, "UPDATE_RUNNING")
}
