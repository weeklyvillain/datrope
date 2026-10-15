package updater

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func updateFake() *fakeCmd {
	return &fakeCmd{out: map[string]string{
		"config --services":                  "postgres\nweb\nserver-blue\nupdater\ncaddy\n", // server-green: in an inactive profile
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

// slotFake answers the extra commands the slot steps run, with server-green healthy.
func slotFake(health string) *fakeCmd {
	f := updateFake()
	f.out["ps -q server-green"] = "g1\n"
	f.out["{{.State.Health.Status}} g1"] = health + "\n"
	f.out["http://127.0.0.1:2019/config/"] = `{"apps":{"http":{"servers":{"srv0":{"routes":[{"handle":[{"upstreams":[{"dial":"server-blue:8080"}]}]}]}}}}}`
	return f
}

func liveBlue(t *testing.T) Switch {
	sw := Switch{Dir: t.TempDir()}
	_, err := sw.Write("blue", "aaa")
	require.NoError(t, err)
	return sw
}

func probeBuild(b string) Probe {
	return func(context.Context, string) (string, error) { return b, nil }
}

// runUntilFail runs steps in order and returns the title of the one that failed, if any.
func runUntilFail(steps []Step) (string, error) {
	for _, s := range steps {
		if err := s.Run(context.Background(), io.Discard); err != nil {
			return s.Title, err
		}
	}
	return "", nil
}

func TestUpdateSteps(t *testing.T) {
	f := slotFake("healthy")
	sw := liveBlue(t)
	c := Compose{Dir: "/home/f/datrope/deploy", Project: "datrope", Image: "sha256:abc", Run: f.run, Switch: sw, Probe: probeBuild("ccc")}
	deployed := filepath.Join(t.TempDir(), "deployed")
	g := &Git{Dir: "/home/f/datrope", Run: f.run, DeployedFile: deployed}
	steps, final := UpdateSteps(g, c)
	titles := []string{}
	for _, s := range steps {
		titles = append(titles, s.Title)
	}
	require.Equal(t, []string{"git pull", "build", "publish web app", "start new server", "wait until healthy", "switch traffic", "stop old server"}, titles)
	failed, err := runUntilFail(steps)
	require.NoError(t, err, failed)
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml "
	require.Equal(t, append(append([]string{}, gitAfterPull...),
		"git -C /home/f/datrope rev-parse HEAD",
		base+"config --services",
		base+"build --build-arg DATROPE_BUILD=ccc postgres web server-blue updater caddy server-green",
		base+"run --rm -e WEB_SWITCH=0 web",
		base+"exec -T caddy wget -qO- http://127.0.0.1:2019/config/",
		base+"up -d --no-deps --remove-orphans postgres imgproxy livekit",
		base+"up -d --no-deps server-green",
		base+"ps -q server-green",
		"docker inspect --format {{.State.Health.Status}} g1",
		base+"exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force",
		base+"stop server-blue",
		"git -C /home/f/datrope rev-parse HEAD",
		"docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock -v /home/f/datrope:/home/f/datrope --entrypoint docker sha256:abc "+strings.TrimPrefix(base, "docker ")+"up -d --no-deps updater",
	), f.calls)
	slot, err := sw.Active()
	require.NoError(t, err)
	require.Equal(t, "green", slot)
	require.Equal(t, "root * /web/ccc\n", read(t, filepath.Join(sw.Dir, "root.caddy")))
	require.Equal(t, "ccc\n", read(t, deployed), "the commit the containers run")
	require.Equal(t, "ccc", g.Status().Deployed)
}

func TestUpdateStepsUnhealthyKeepsOldSlot(t *testing.T) {
	f := slotFake("unhealthy")
	sw := liveBlue(t)
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw, Probe: probeBuild("ccc"), HealthTimeout: 20 * time.Millisecond}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	failed, err := runUntilFail(steps)
	require.Error(t, err)
	require.Equal(t, "wait until healthy", failed)
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], "stop server-green"), "the failed slot is stopped")
	slot, _ := sw.Active()
	require.Equal(t, "blue", slot)
}

func TestUpdateStepsReloadFailureRestores(t *testing.T) {
	f := slotFake("healthy")
	f.fail = map[string]bool{"--force": true}
	sw := liveBlue(t)
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw, Probe: probeBuild("ccc")}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	failed, err := runUntilFail(steps)
	require.Error(t, err)
	require.Equal(t, "switch traffic", failed)
	slot, _ := sw.Active()
	require.Equal(t, "blue", slot)
	require.Equal(t, "root * /web/aaa\n", read(t, filepath.Join(sw.Dir, "root.caddy")))
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], "stop server-green"))
}

func TestUpdateStepsFromGreen(t *testing.T) {
	f := updateFake()
	f.out["ps -q server-blue"] = "b1\n"
	f.out["{{.State.Health.Status}} b1"] = "healthy\n"
	sw := Switch{Dir: t.TempDir()}
	_, err := sw.Write("green", "aaa")
	require.NoError(t, err)
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw, Probe: probeBuild("ccc")}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	failed, err := runUntilFail(steps)
	require.NoError(t, err, failed)
	slot, _ := sw.Active()
	require.Equal(t, "blue", slot)
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], "stop server-green"))
}

func TestUpdateStepsFailedBuildKeepsDeployed(t *testing.T) {
	f := updateFake()
	f.fail = map[string]bool{"caddy server-green": true}
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
	f := slotFake("healthy")
	c := Compose{
		Dir: "/home/f/datrope/deploy", Project: "datrope", Image: "sha256:abc", Run: f.run, Switch: liveBlue(t), Probe: probeBuild("ccc"),
		Files:      []string{"/home/f/datrope/deploy/docker-compose.yml", "/home/f/datrope/deploy/docker-compose.override.yml"},
		WorkingDir: "/home/f/datrope/deploy",
	}
	g := &Git{Dir: "/home/f/datrope", Run: f.run}
	steps, final := UpdateSteps(g, c)
	failed, err := runUntilFail(steps)
	require.NoError(t, err, failed)
	require.NoError(t, final.Run(context.Background(), io.Discard))
	base := "docker compose -p datrope --project-directory /home/f/datrope/deploy -f /home/f/datrope/deploy/docker-compose.yml -f /home/f/datrope/deploy/docker-compose.override.yml "
	n := len(gitAfterPull)
	require.Equal(t, base+"build --build-arg DATROPE_BUILD=ccc postgres web server-blue updater caddy server-green", f.calls[n+2])
	require.Equal(t, base+"up -d --no-deps server-green", f.calls[n+6])
	require.True(t, strings.HasSuffix(f.calls[len(f.calls)-1], strings.TrimPrefix(base, "docker ")+"up -d --no-deps updater"), f.calls[len(f.calls)-1])
}

// The updater died after writing the switch files but before Caddy reloaded: Caddy still sends
// traffic to blue though slot says green. The next update must not pick blue as the idle slot
// before Caddy agrees with the files.
func TestUpdateStepsRepairsInterruptedSwitch(t *testing.T) {
	f := updateFake()
	f.out["ps -q server-blue"] = "b1\n"
	f.out["{{.State.Health.Status}} b1"] = "healthy\n"
	f.out["http://127.0.0.1:2019/config/"] = `{"upstreams":[{"dial":"server-blue:8080"}]}`
	sw := Switch{Dir: t.TempDir()}
	_, err := sw.Write("green", "aaa")
	require.NoError(t, err)
	c := Compose{Dir: "/r/deploy", Project: "datrope", Run: f.run, Switch: sw, Probe: probeBuild("ccc")}
	steps, _ := UpdateSteps(&Git{Dir: "/r", Run: f.run}, c)
	failed, err := runUntilFail(steps)
	require.NoError(t, err, failed)
	reload, start := -1, -1
	for i, call := range f.calls {
		if strings.HasSuffix(call, "caddy reload --config /etc/caddy/Caddyfile --force") && reload < 0 {
			reload = i
		}
		if strings.HasSuffix(call, "up -d --no-deps server-blue") {
			start = i
		}
	}
	require.GreaterOrEqual(t, reload, 0, "Caddy is reloaded to match the files")
	require.Less(t, reload, start, "before blue is recreated")
}
