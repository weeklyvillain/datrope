package updater

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
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

// UpdateSteps pulls, builds and restarts everything but the updater; final then replaces the
// updater itself, which ends this process.
func UpdateSteps(g *Git, c Compose) (steps []Step, final *Step) {
	steps = []Step{
		g.PullStep(),
		{Title: "docker compose build", Run: func(ctx context.Context, w io.Writer) error { return c.cmd(ctx, w, "build") }},
		{Title: "docker compose up", Run: func(ctx context.Context, w io.Writer) error {
			all, err := c.services(ctx) // read after the pull: an update may add services
			if err != nil {
				return err
			}
			others := slices.DeleteFunc(all, func(s string) bool { return s == "updater" })
			if err := c.cmd(ctx, w, append([]string{"up", "-d"}, others...)...); err != nil {
				return err
			}
			// The containers now run HEAD. Failing to record that does not undo the update.
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
