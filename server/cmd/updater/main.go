// Command updater pulls, rebuilds and restarts the Datrope compose stack for the system
// dashboard. It runs in its own container with the Docker socket and the repo mounted:
//
//	DATROPE_UPDATER_TOKEN   shared with the server; empty disables the updater
//	DATROPE_UPDATER_ADDR    listen address (default :8090)
//
// "updater deploy" starts an update through the running updater and prints its log.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

const (
	repoMount    = "/repo"
	jobsDir      = "/state/jobs"
	deployedFile = "/state/deployed" // the commit the running containers were built from
	switchDir    = "/switch"         // the switch volume: live slot and Caddy snippets
	socket       = "/var/run/docker.sock"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	run := runServer
	if len(os.Args) > 1 && os.Args[1] == "deploy" {
		run = deploy
	}
	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

// deploy starts an update through the running updater and prints its log until it ends
// (docker compose exec updater /updater deploy): the same job, lock and dashboard record as the
// Update button.
func deploy() error {
	token := os.Getenv("DATROPE_UPDATER_TOKEN")
	if token == "" {
		return errors.New("DATROPE_UPDATER_TOKEN is not set")
	}
	addr := os.Getenv("DATROPE_UPDATER_ADDR")
	if addr == "" {
		addr = ":8090"
	}
	base := "http://" + addr
	if strings.HasPrefix(addr, ":") {
		base = "http://127.0.0.1" + addr
	}
	call := func(method, path string, out any) error {
		req, err := http.NewRequest(method, base+path, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 {
			b, _ := io.ReadAll(res.Body)
			return fmt.Errorf("%s %s: %s %s", method, path, res.Status, strings.TrimSpace(string(b)))
		}
		return json.NewDecoder(res.Body).Decode(out)
	}
	var started struct {
		JobID string `json:"job_id"`
	}
	if err := call(http.MethodPost, "/update", &started); err != nil {
		return err
	}
	next := 0
	for {
		var l updater.UpdateJobLog
		if err := call(http.MethodGet, fmt.Sprintf("/jobs/%s?after=%d", started.JobID, next), &l); err != nil {
			return err
		}
		for _, line := range l.Lines {
			fmt.Println(line)
		}
		next = l.Next
		switch l.Job.Status {
		case updater.StatusSucceeded:
			return nil // the updater replaces itself next; that ends this exec too
		case updater.StatusFailed:
			return errors.New(l.Job.Error)
		}
		time.Sleep(time.Second)
	}
}

func runServer() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	token := os.Getenv("DATROPE_UPDATER_TOKEN")
	if token == "" {
		// Idle rather than exit: restart: unless-stopped would restart us forever.
		slog.Info("updater disabled: DATROPE_UPDATER_TOKEN is not set")
		<-ctx.Done()
		return nil
	}
	addr := os.Getenv("DATROPE_UPDATER_ADDR")
	if addr == "" {
		addr = ":8090"
	}

	docker := updater.NewDocker(socket)
	self, err := os.Hostname() // Docker sets the hostname to the container's short ID
	if err != nil {
		return err
	}
	info, err := docker.Self(ctx, self, repoMount)
	if err != nil {
		return err
	}
	repo, project := info.HostRepo, info.Project
	if err := updater.LinkRepo(repoMount, repo); err != nil {
		return err
	}
	as, err := updater.RunAs(repoMount)
	if err != nil {
		return err
	}
	jobs, err := updater.OpenJobs(jobsDir)
	if err != nil {
		return err
	}
	jobs.Handover = 3 * time.Second // deploy polls every second
	git := &updater.Git{Dir: repo, As: as, Run: updater.ExecCmd, DeployedFile: deployedFile}
	go git.RunDaily(ctx)

	compose := updater.Compose{Dir: path.Join(repo, "deploy"), Project: project, Image: info.Image, Run: updater.ExecCmd, Switch: updater.Switch{Dir: switchDir}}
	// Use the compose files the stack was started with (overrides included). Only paths inside the
	// repo are reachable here, through LinkRepo; compose could not read the others.
	for _, f := range info.ConfigFiles {
		if inside(repo, f) {
			compose.Files = append(compose.Files, f)
		} else {
			slog.Warn("updater: ignoring a compose file outside the repo", "file", f)
		}
	}
	if inside(repo, info.WorkingDir) {
		compose.WorkingDir = info.WorkingDir
	} else if info.WorkingDir != "" {
		slog.Warn("updater: ignoring a compose project directory outside the repo", "dir", info.WorkingDir)
	}
	s := &updater.Server{Token: token, Git: git, Jobs: jobs, Docker: docker, Compose: compose}
	srv := &http.Server{Addr: addr, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	slog.Info("updater listening", "addr", addr, "repo", repo, "project", project, "compose_files", compose.Files)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// inside reports whether the host path p is repo or below it.
func inside(repo, p string) bool {
	return p == repo || strings.HasPrefix(p, repo+"/")
}
