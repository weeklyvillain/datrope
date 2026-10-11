package updater

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeCmd answers commands by the end of their joined arguments and records every call.
type fakeCmd struct {
	out   map[string]string
	fail  map[string]bool
	calls []string
}

func (f *fakeCmd) run(_ context.Context, w io.Writer, name string, args ...string) error {
	line := strings.Join(append([]string{name}, args...), " ")
	f.calls = append(f.calls, line)
	for k, v := range f.out {
		if strings.HasSuffix(line, k) {
			fmt.Fprint(w, v)
		}
	}
	for k := range f.fail {
		if strings.HasSuffix(line, k) {
			return errors.New("exit status 1")
		}
	}
	return nil
}

func TestGitCheck(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"rev-parse HEAD":                                    "aaa\n",
		"rev-parse origin/main":                             "ccc\n",
		"rev-list --count HEAD..origin/main":                "2\n",
		"--format=%H%x1f%s%x1f%an%x1f%cI HEAD..origin/main": "ccc\x1fFix voice\x1fFilip\x1f2026-10-11T10:00:00+02:00\nbbb\x1fAdd polls\x1fFilip\x1f2026-10-10T09:00:00Z\n",
	}}
	g := &Git{Dir: "/home/f/datrope", As: []string{"su-exec", "1000:1000"}, Run: f.run}
	st := g.Check(context.Background())
	require.Empty(t, st.Error)
	require.Equal(t, "aaa", st.Current)
	require.Equal(t, "ccc", st.Latest)
	require.Equal(t, 2, st.Behind)
	require.Len(t, st.Commits, 2)
	c := st.Commits[0]
	require.Equal(t, "ccc", c.SHA)
	require.Equal(t, "Fix voice", c.Subject)
	require.True(t, c.Date.Equal(time.Date(2026, 10, 11, 8, 0, 0, 0, time.UTC)))
	require.NotNil(t, st.CheckedAt)
	require.Equal(t, "su-exec 1000:1000 git -C /home/f/datrope fetch origin main", f.calls[0])
	require.Equal(t, st, g.Status())
}

func TestGitCheckFetchFails(t *testing.T) {
	f := &fakeCmd{fail: map[string]bool{"fetch origin main": true}}
	g := &Git{Dir: "/r", Run: f.run}
	st := g.Check(context.Background())
	require.Contains(t, st.Error, "fetch")
	require.NotNil(t, st.Commits, "commits is [] in JSON, not null")
}

func TestGitPullStep(t *testing.T) {
	f := &fakeCmd{fail: map[string]bool{"pull --ff-only origin main": true}}
	g := &Git{Dir: "/r", Run: f.run}
	require.Error(t, g.PullStep().Run(context.Background(), io.Discard))
	require.Equal(t, []string{"git -C /r pull --ff-only origin main"}, f.calls, "a failed pull refreshes nothing")
}

func TestGitPullStepRefreshesStatus(t *testing.T) {
	f := &fakeCmd{out: map[string]string{
		"rev-parse HEAD":                                    "aaa\n",
		"rev-parse origin/main":                             "ccc\n",
		"rev-list --count HEAD..origin/main":                "1\n",
		"--format=%H%x1f%s%x1f%an%x1f%cI HEAD..origin/main": "ccc\x1fFix voice\x1fFilip\x1f2026-10-11T10:00:00Z\n",
	}}
	g := &Git{Dir: "/r", Run: f.run}
	require.Equal(t, 1, g.Check(context.Background()).Behind)

	// The pull moves HEAD to origin/main.
	f.out = map[string]string{"rev-parse HEAD": "ccc\n", "rev-parse origin/main": "ccc\n", "rev-list --count HEAD..origin/main": "0\n"}
	f.calls = nil
	require.NoError(t, g.PullStep().Run(context.Background(), io.Discard))
	st := g.Status()
	require.Empty(t, st.Error)
	require.Equal(t, "ccc", st.Current)
	require.Equal(t, "ccc", st.Latest)
	require.Equal(t, 0, st.Behind)
	require.Empty(t, st.Commits)
	require.NotNil(t, st.CheckedAt)
	require.Equal(t, "git -C /r pull --ff-only origin main", f.calls[0])
	for _, c := range f.calls {
		require.NotContains(t, c, "fetch", "the pull just fetched")
	}
}

func TestGitCommandsHaveATimeout(t *testing.T) {
	var deadline time.Time
	run := func(ctx context.Context, _ io.Writer, _ string, _ ...string) error {
		deadline, _ = ctx.Deadline()
		return nil
	}
	g := &Git{Dir: "/r", Run: run}
	require.NoError(t, g.PullStep().Run(context.Background(), io.Discard))
	require.False(t, deadline.IsZero(), "a blackholed fetch must not hold the run lock forever")
	require.WithinDuration(t, time.Now().Add(gitTimeout), deadline, time.Minute)
}

func TestGitDeployed(t *testing.T) {
	f := &fakeCmd{out: map[string]string{"rev-parse HEAD": "ccc\n"}}
	file := filepath.Join(t.TempDir(), "deployed")
	g := &Git{Dir: "/r", Run: f.run, DeployedFile: file}
	require.Empty(t, g.Status().Deployed, "unknown before the first update")
	require.NoError(t, os.WriteFile(file, []byte("bbb\n"), 0o644))
	require.Equal(t, "bbb", g.Status().Deployed)
	require.Equal(t, "bbb", g.Check(context.Background()).Deployed)
}

func TestLinkRepo(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows; the updater runs on Linux")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "repo")
	require.NoError(t, os.Mkdir(target, 0o755))
	at := filepath.Join(dir, "home", "f", "datrope")
	require.NoError(t, LinkRepo(target, at))
	require.NoError(t, LinkRepo(target, at), "idempotent")
	require.NoError(t, LinkRepo(target, target), "same path: nothing to do")
	got, err := os.Readlink(at)
	require.NoError(t, err)
	require.Equal(t, target, got)
}

func TestGitStatusBeforeCheckHasEmptyCommits(t *testing.T) {
	c := (&Git{}).Status().Commits
	require.NotNil(t, c)
	require.Empty(t, c)
}

func TestGitCheckWaitsForPull(t *testing.T) {
	var mu sync.Mutex
	var fetched bool
	release := make(chan struct{})
	started := make(chan struct{})
	run := func(_ context.Context, _ io.Writer, name string, args ...string) error {
		line := strings.Join(append([]string{name}, args...), " ")
		if strings.Contains(line, " pull ") {
			close(started)
			<-release
			return nil
		}
		if strings.Contains(line, " fetch ") {
			mu.Lock()
			fetched = true
			mu.Unlock()
		}
		return nil
	}
	g := &Git{Dir: "/r", Run: run}
	pullDone := make(chan error, 1)
	go func() { pullDone <- g.PullStep().Run(context.Background(), io.Discard) }()
	<-started
	checkDone := make(chan struct{})
	go func() { g.Check(context.Background()); close(checkDone) }()
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	require.False(t, fetched, "fetch must wait for the pull")
	mu.Unlock()
	close(release)
	require.NoError(t, <-pullDone)
	<-checkDone
	mu.Lock()
	require.True(t, fetched)
	mu.Unlock()
}
