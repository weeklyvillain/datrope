package updater

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cmd runs a program and writes its stdout and stderr to w.
type Cmd func(ctx context.Context, w io.Writer, name string, args ...string) error

func ExecCmd(ctx context.Context, w io.Writer, name string, args ...string) error {
	c := exec.CommandContext(ctx, name, args...)
	c.Stdout, c.Stderr = w, w
	return c.Run()
}

// gitTimeout bounds each git command, so a fetch from an unreachable remote cannot hold the
// run lock forever.
const gitTimeout = 5 * time.Minute

type GitCommit struct {
	SHA     string    `json:"sha"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	Date    time.Time `json:"date"`
}

type GitStatus struct {
	Current   string      `json:"current" doc:"The commit the checkout is at"`
	Latest    string      `json:"latest" doc:"origin/main at the last check"`
	Behind    int         `json:"behind"`
	Commits   []GitCommit `json:"commits" doc:"Newest first, at most 100"`
	CheckedAt *time.Time  `json:"checked_at,omitempty"`
	Error     string      `json:"error,omitempty"`
	Deployed  string      `json:"deployed,omitempty" doc:"The commit the running containers were built from, if known"`
}

// Git checks and pulls the checkout the stack is built from. As prefixes every git command
// (su-exec to the checkout's owner) so pulled files are not owned by root. DeployedFile holds
// the commit the running containers were built from (empty: not tracked).
type Git struct {
	Dir          string
	As           []string
	Run          Cmd
	DeployedFile string

	run    sync.Mutex // serializes git commands that touch refs: a fetch must not overlap a pull
	mu     sync.Mutex // guards status
	status GitStatus
}

func (g *Git) cmd(ctx context.Context, w io.Writer, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	full := append(append(append([]string{}, g.As...), "git", "-C", g.Dir), args...)
	return g.Run(ctx, w, full[0], full[1:]...)
}

func (g *Git) output(ctx context.Context, args ...string) (string, error) {
	var b bytes.Buffer
	if err := g.cmd(ctx, &b, args...); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(b.String()))
	}
	return strings.TrimSpace(b.String()), nil
}

// Check fetches origin/main and compares it with HEAD.
func (g *Git) Check(ctx context.Context) GitStatus {
	g.run.Lock()
	defer g.run.Unlock()
	return g.refresh(ctx, true)
}

// refresh compares HEAD with origin/main, fetching it first if fetch, and stores the result.
// The caller holds g.run.
func (g *Git) refresh(ctx context.Context, fetch bool) GitStatus {
	now := time.Now()
	st := GitStatus{Commits: []GitCommit{}, CheckedAt: &now}
	if err := g.check(ctx, &st, fetch); err != nil {
		st.Error = err.Error()
	}
	g.mu.Lock()
	g.status = st
	g.mu.Unlock()
	return g.Status()
}

func (g *Git) check(ctx context.Context, st *GitStatus, fetch bool) error {
	if fetch {
		if _, err := g.output(ctx, "fetch", "origin", "main"); err != nil {
			return err
		}
	}
	var err error
	if st.Current, err = g.output(ctx, "rev-parse", "HEAD"); err != nil {
		return err
	}
	if st.Latest, err = g.output(ctx, "rev-parse", "origin/main"); err != nil {
		return err
	}
	n, err := g.output(ctx, "rev-list", "--count", "HEAD..origin/main")
	if err != nil {
		return err
	}
	if st.Behind, err = strconv.Atoi(n); err != nil {
		return fmt.Errorf("git rev-list: %w", err)
	}
	out, err := g.output(ctx, "log", "-n", "100", "--format=%H%x1f%s%x1f%an%x1f%cI", "HEAD..origin/main")
	if err != nil {
		return err
	}
	commits, err := parseLog(out)
	if err != nil {
		return err
	}
	st.Commits = commits
	return nil
}

func parseLog(out string) ([]GitCommit, error) {
	commits := []GitCommit{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		f := strings.Split(line, "\x1f")
		if len(f) != 4 {
			return nil, fmt.Errorf("git log: unexpected line %q", line)
		}
		d, err := time.Parse(time.RFC3339, f[3])
		if err != nil {
			return nil, fmt.Errorf("git log: %w", err)
		}
		commits = append(commits, GitCommit{SHA: f[0], Subject: f[1], Author: f[2], Date: d})
	}
	return commits, nil
}

func (g *Git) Status() GitStatus {
	g.mu.Lock()
	defer g.mu.Unlock()
	st := g.status
	if st.Commits == nil {
		st.Commits = []GitCommit{}
	}
	st.Deployed = g.deployed()
	return st
}

func (g *Git) deployed() string {
	if g.DeployedFile == "" {
		return ""
	}
	b, _ := os.ReadFile(g.DeployedFile) // missing until the first update from here
	return strings.TrimSpace(string(b))
}

// markDeployed records HEAD as the commit the running containers were built from.
func (g *Git) markDeployed(ctx context.Context) error {
	if g.DeployedFile == "" {
		return nil
	}
	sha, err := g.output(ctx, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	return os.WriteFile(g.DeployedFile, []byte(sha+"\n"), 0o644)
}

func (g *Git) PullStep() Step {
	return Step{Title: "git pull", Run: func(ctx context.Context, w io.Writer) error {
		g.run.Lock()
		defer g.run.Unlock()
		if err := g.cmd(ctx, w, "pull", "--ff-only", "origin", "main"); err != nil {
			return err
		}
		g.refresh(ctx, false) // the pull just fetched origin/main
		return nil
	}}
}

// RunDaily checks at start and then every 24 hours.
func (g *Git) RunDaily(ctx context.Context) {
	for {
		if st := g.Check(ctx); st.Error != "" {
			slog.Warn("updater: git check", "err", st.Error)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

// LinkRepo makes the checkout, mounted at target, reachable at its host path (at) inside the
// container. Compose then resolves relative paths to host paths the Docker daemon can use.
func LinkRepo(target, at string) error {
	if at == target {
		return nil
	}
	if _, err := os.Lstat(at); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(at), 0o755); err != nil {
		return err
	}
	return os.Symlink(target, at)
}
