package updater

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"time"
)

// Compose runs docker compose for the stack. Dir is the deploy directory's host path (reachable
// in this container through LinkRepo), so relative paths in docker-compose.yml mean the same to
// compose here as to the Docker daemon on the host.
type Compose struct {
	Dir     string
	Project string
	Image   string // this container's own image, for the helper that replaces it
	Run     Cmd
	// Files and WorkingDir are the stack's compose files and project directory as it was started
	// (host paths); empty means <Dir>/docker-compose.yml and Dir.
	Files      []string
	WorkingDir string
	// Switch is the switch volume (live slot, Caddy snippets). Probe reads a server's build
	// (nil: HTTPProbe). HealthTimeout bounds the wait for the new slot (0: two minutes).
	Switch        Switch
	Probe         Probe
	HealthTimeout time.Duration
}

func (c Compose) args(args ...string) []string {
	dir, files := c.Dir, c.Files
	if c.WorkingDir != "" {
		dir = c.WorkingDir
	}
	if len(files) == 0 {
		files = []string{path.Join(c.Dir, "docker-compose.yml")}
	}
	a := []string{"compose", "-p", c.Project, "--project-directory", dir}
	for _, f := range files {
		a = append(a, "-f", f)
	}
	return append(a, args...)
}

func (c Compose) cmd(ctx context.Context, w io.Writer, args ...string) error {
	return c.Run(ctx, w, "docker", c.args(args...)...)
}

func (c Compose) services(ctx context.Context) ([]string, error) {
	var b bytes.Buffer
	if err := c.cmd(ctx, &b, "config", "--services"); err != nil {
		return nil, fmt.Errorf("compose config: %w: %s", err, strings.TrimSpace(b.String()))
	}
	return strings.Fields(b.String()), nil
}

// caddyReload makes Caddy re-read the Caddyfile and the switch files it imports. --force: Caddy
// skips a reload when the Caddyfile text is unchanged, and the imported files are what changed.
func (c Compose) caddyReload(ctx context.Context, w io.Writer) error {
	return c.cmd(ctx, w, "exec", "-T", "caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--force")
}

// alignCaddy reloads Caddy when its running config does not send traffic to server-<live>.
// When the admin API cannot be read it says so and goes on: the check is a safety net.
func (c Compose) alignCaddy(ctx context.Context, w io.Writer, live string) error {
	var b bytes.Buffer
	if err := c.cmd(ctx, &b, "exec", "-T", "caddy", "wget", "-qO-", "http://127.0.0.1:2019/config/"); err != nil {
		fmt.Fprintf(w, "could not read Caddy's config: %v\n", err)
		return nil
	}
	if strings.Contains(b.String(), `"dial":"server-`+live+`:8080"`) {
		return nil
	}
	fmt.Fprintf(w, "Caddy does not route to server-%s as the switch files say: reloading it\n", live)
	return c.caddyReload(ctx, w)
}

// UpdateSteps pulls and builds, starts the idle server slot next to the live one, switches Caddy
// and the servers to it once it is healthy, then stops the old slot. final replaces the updater
// itself, which ends this process. The live slot serves throughout; a failure before the switch
// leaves it untouched.
func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step) {
	probe, timeout := c.Probe, c.HealthTimeout
	if probe == nil {
		probe = HTTPProbe
	}
	if timeout == 0 {
		timeout = 2 * time.Minute
	}
	var build, live, next string // set as the steps run
	stopNext := func(ctx context.Context, w io.Writer) {
		if err := c.cmd(ctx, w, "stop", "server-"+next); err != nil {
			fmt.Fprintf(w, "could not stop server-%s: %v\n", next, err)
		}
	}
	steps = []Step{
		g.PullStep(),
		{Title: "build", Run: func(ctx context.Context, w io.Writer) error {
			sha, err := g.output(ctx, "rev-parse", "HEAD")
			if err != nil {
				return err
			}
			build = sha
			// Every service, read after the pull (an update may add some), and both slots by
			// name: compose skips services in inactive profiles otherwise, and `up` would then
			// build the slot itself, without the build arg.
			svcs, err := c.services(ctx)
			if err != nil {
				return err
			}
			for _, s := range []string{"server-blue", "server-green"} {
				if !slices.Contains(svcs, s) {
					svcs = append(svcs, s)
				}
			}
			return c.cmd(ctx, w, append([]string{"build", "--build-arg", "DATROPE_BUILD=" + build}, svcs...)...)
		}},
		{Title: "publish web app", Run: func(ctx context.Context, w io.Writer) error {
			return c.cmd(ctx, w, "run", "--rm", "-e", "WEB_SWITCH=0", "web") // the switch step points Caddy at it
		}},
		{Title: "start new server", Run: func(ctx context.Context, w io.Writer) error {
			var err error
			if live, err = c.Switch.Active(); err != nil {
				return err
			}
			next = Other(live)
			// An update that died between writing the switch files and reloading Caddy leaves
			// Caddy on the other slot. Bring Caddy in line first, or the slot about to be
			// recreated could be the one taking the traffic.
			if err := c.alignCaddy(ctx, w, live); err != nil {
				return err
			}
			// The services besides the slots, Caddy and the updater: normally a no-op. Picks up
			// changed images or config, and removes containers of services an update dropped.
			if err := c.cmd(ctx, w, "up", "-d", "--no-deps", "--remove-orphans", "postgres", "imgproxy", "livekit"); err != nil {
				return err
			}
			return c.cmd(ctx, w, "up", "-d", "--no-deps", "server-"+next)
		}},
		{Title: "wait until healthy", Run: func(ctx context.Context, w io.Writer) error {
			if err := c.WaitHealthy(ctx, w, "server-"+next, build, probe, timeout, 2*time.Second); err != nil {
				stopNext(ctx, w)
				return err
			}
			return nil
		}},
		{Title: "switch traffic", Run: func(ctx context.Context, w io.Writer) error {
			restore, err := c.Switch.Write(next, build)
			if err != nil {
				stopNext(ctx, w)
				return err
			}
			// A Caddyfile edit in the pull is picked up here too.
			if err := c.caddyReload(ctx, w); err != nil {
				if rerr := restore(); rerr != nil {
					fmt.Fprintf(w, "could not restore the switch files: %v\n", rerr)
				}
				stopNext(ctx, w)
				return err
			}
			fmt.Fprintf(w, "traffic now goes to server-%s\n", next)
			return nil
		}},
		{Title: "stop old server", Run: func(ctx context.Context, w io.Writer) error {
			if err := c.cmd(ctx, w, "stop", "server-"+live); err != nil {
				return err
			}
			// The live slot now runs HEAD. Failing to record that does not undo the update.
			if err := g.markDeployed(ctx); err != nil {
				fmt.Fprintf(w, "could not record the deployed commit: %v\n", err)
			}
			return nil
		}},
	}
	final = &Step{Title: "restart the updater", Run: func(ctx context.Context, w io.Writer) error {
		// Recreating this container stops the compose process running in it, which could leave
		// the new updater created but never started. A detached helper from our own image
		// does the recreate instead and outlives us. The repo is mounted at its host path so
		// the helper's compose sees the same paths as ours.
		repo := path.Dir(c.Dir)
		args := append([]string{"run", "-d", "--rm",
			"-v", "/var/run/docker.sock:/var/run/docker.sock",
			"-v", repo + ":" + repo,
			"--entrypoint", "docker", c.Image}, c.args("up", "-d", "--no-deps", "updater")...)
		return c.Run(ctx, w, "docker", args...)
	}}
	return steps, final
}
