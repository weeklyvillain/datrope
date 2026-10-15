package updater

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func healthFake(status string) *fakeCmd {
	return &fakeCmd{out: map[string]string{
		"ps -q server-green":              "abc123\n",
		"{{.State.Health.Status}} abc123": status + "\n",
	}}
}

func TestWaitHealthy(t *testing.T) {
	f := healthFake("healthy")
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run}
	probe := func(_ context.Context, url string) (string, error) {
		require.Equal(t, "http://server-green:8080/healthz", url)
		return "bbb", nil
	}
	require.NoError(t, c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, time.Second, time.Millisecond))
}

func TestWaitHealthyWrongBuildTimesOut(t *testing.T) {
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: healthFake("healthy").run}
	probe := func(context.Context, string) (string, error) { return "aaa", nil }
	err := c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, 50*time.Millisecond, time.Millisecond)
	require.ErrorContains(t, err, "aaa")
}

func TestWaitHealthyUnhealthyTimesOut(t *testing.T) {
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: healthFake("starting").run}
	probe := func(context.Context, string) (string, error) {
		t.Error("probed before healthy")
		return "", nil
	}
	err := c.WaitHealthy(context.Background(), io.Discard, "server-green", "bbb", probe, 50*time.Millisecond, time.Millisecond)
	require.ErrorContains(t, err, "starting")
}

func TestHTTPProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"build":"abc"}`))
	}))
	defer srv.Close()
	b, err := HTTPProbe(context.Background(), srv.URL)
	require.NoError(t, err)
	require.Equal(t, "abc", b)
}
