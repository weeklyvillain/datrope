package updater

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func updateFake() *fakeCmd {
	return &fakeCmd{out: map[string]string{
		"config --services":                  "postgres\nserver\nupdater\ncaddy\n",
		"rev-parse HEAD":                     "ccc\n",
		"rev-parse origin/main":              "ccc\n",
		"rev-list --count HEAD..origin/main": "0\n",
	}}
}

// gitAfterPull: PullStep refreshes the status from the fetched refs.
var gitAfterPull = []string{
	"git -C /home/f/datrope pull --ff-only origin main",
	"git -C /home/f/datrope rev-parse HEAD",
	"git -C /home/f/datrope rev-parse origin/main",
	"git -C /home/f/datrope rev-list --count HEAD..origin/main",
	"git -C /home/f/datrope log -n 100 --format=%H%x1f%s%x1f%an%x1f%cI HEAD..origin/main",
}

func TestUpdateSteps(t *testing.T) {
	f := updateFake()
	c := Compose{Dir: "/home/f/datrope/deploy", Project: "datrope", Image: "sha256:abc", Run: f.run}
	deployed := filepath.Join(t.TempDir(), "deployed")
	g := &Git{Dir: "/home/f/datrope", Run: f.run, DeployedFile: deployed}
	steps, final := UpdateSteps(g, c)
	for _, s := range steps {
		require.NoError(t, s.Run(context.Background(), io.Discard))
	}
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml "
	require.Equal(t, append(append([]string{}, gitAfterPull...),
		base+"build",
		base+"config --services",
		base+"up -d postgres server caddy",
		"git -C /home/f/datrope rev-parse HEAD",
		"docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v /home/f/datrope:/home/f/datrope --entrypoint docker sha256:abc "+strings.TrimPrefix(base, "docker ")+"up -d --no-deps updater",
	), f.calls)
	b, err := os.ReadFile(deployed)
	require.NoError(t, err)
	require.Equal(t, "ccc\n", string(b), "the up step records the commit the containers run")
	require.Equal(t, "ccc", g.Status().Deployed)
}

func TestUpdateStepsFailedBuildKeepsDeployed(t *testing.T) {
	f := updateFake()
	f.fail = map[string]bool{" build": true}
	deployed := filepath.Join(t.TempDir(), "deployed")
	require.NoError(t, os.WriteFile(deployed, []byte("aaa\n"), 0o644))
	g := &Git{Dir: "/r", Run: f.run, DeployedFile: deployed}
	steps, _ := UpdateSteps(g, Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run})
	require.NoError(t, steps[0].Run(context.Background(), io.Discard))
	require.Error(t, steps[1].Run(context.Background(), io.Discard))
	st := g.Status()
	require.Equal(t, "ccc", st.Current)
	require.Equal(t, "aaa", st.Deployed, "the old containers still run")
}

func TestUpdateStepsComposeFiles(t *testing.T) {
	f := updateFake()
	c := Compose{
		Dir: "/home/f/datrope/deploy", Project: "datrope", Image: "sha256:abc", Run: f.run,
		Files:      []string{"/home/f/datrope/deploy/docker-compose.yml", "/home/f/datrope/deploy/docker-compose.override.yml"},
		WorkingDir: "/home/f/datrope/deploy",
	}
	g := &Git{Dir: "/home/f/datrope", Run: f.run}
	steps, final := UpdateSteps(g, c)
	for _, s := range steps {
		require.NoError(t, s.Run(context.Background(), io.Discard))
	}
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml -f /home/f/datrope/deploy/docker-compose.override.yml "
	n := len(gitAfterPull)
	require.Equal(t, base+"build", f.calls[n])
	require.Equal(t, base+"up -d postgres server caddy", f.calls[n+2])
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], strings.TrimPrefix(base, "docker ")+"up -d --no-deps updater"), f.calls[len(f.calls)-1])
}
