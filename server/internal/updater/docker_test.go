package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func fakeDocker(t *testing.T) *Docker {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/containers/json":
			var f map[string][]string
			require.NoError(t, json.Unmarshal([]byte(r.URL.Query().Get("filters")), &f))
			require.Equal(t, []string{"com.docker.compose.project=datrope"}, f["label"])
			require.Equal(t, "true", r.URL.Query().Get("all"))
			_, _ = w.Write([]byte(`[
				{"Id":"s1","Names":["/datrope-server-1"],"State":"running","Status":"Up 2 hours (healthy)","Labels":{"com.docker.compose.service":"server"}},
				{"Id":"c1","Names":["/datrope-caddy-1"],"State":"exited","Status":"Exited (1) 3 minutes ago","Labels":{"com.docker.compose.service":"caddy"}}]`))
		case "/containers/s1/stats":
			require.Equal(t, "false", r.URL.Query().Get("stream"))
			_, _ = w.Write([]byte(`{
				"cpu_stats":{"cpu_usage":{"total_usage":3000},"system_cpu_usage":20000,"online_cpus":4},
				"precpu_stats":{"cpu_usage":{"total_usage":1000},"system_cpu_usage":10000,"online_cpus":4},
				"memory_stats":{"usage":5000,"limit":100000,"stats":{"inactive_file":1000}}}`))
		case "/containers/self/json":
			_, _ = w.Write([]byte(`{"Image":"sha256:abc","Mounts":[{"Source":"/var/run/docker.sock","Destination":"/var/run/docker.sock"},{"Source":"/home/f/datrope","Destination":"/repo"}],
				"Config":{"Labels":{"com.docker.compose.project":"datrope",
					"com.docker.compose.project.config_files":"/home/f/datrope/deploy/docker-compose.yml,/home/f/datrope/deploy/docker-compose.override.yml",
					"com.docker.compose.project.working_dir":"/home/f/datrope/deploy"}}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return &Docker{hc: srv.Client(), base: srv.URL}
}

func TestContainers(t *testing.T) {
	cs, err := fakeDocker(t).Containers(context.Background(), "datrope")
	require.NoError(t, err)
	// CPU: (3000-1000)/(20000-10000) * 4 cores * 100 = 80. Memory: 5000 - 1000 inactive_file.
	require.Equal(t, []ContainerInfo{
		{Service: "caddy", Name: "datrope-caddy-1", State: "exited", Status: "Exited (1) 3 minutes ago"},
		{Service: "server", Name: "datrope-server-1", State: "running", Status: "Up 2 hours (healthy)", CPUPercent: 80, MemBytes: 4000, MemLimit: 100000},
	}, cs)
}

func TestSelf(t *testing.T) {
	info, err := fakeDocker(t).Self(context.Background(), "self", "/repo")
	require.NoError(t, err)
	require.Equal(t, "/home/f/datrope", info.HostRepo)
	require.Equal(t, "datrope", info.Project)
	require.Equal(t, "sha256:abc", info.Image)
	require.Equal(t, []string{"/home/f/datrope/deploy/docker-compose.yml", "/home/f/datrope/deploy/docker-compose.override.yml"}, info.ConfigFiles)
	require.Equal(t, "/home/f/datrope/deploy", info.WorkingDir)

	_, err = fakeDocker(t).Self(context.Background(), "self", "/elsewhere")
	require.Error(t, err)
}
