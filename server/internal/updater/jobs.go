// Package updater pulls, rebuilds and restarts the compose stack for the system dashboard.
// It runs in its own container, the only one with the Docker socket.
package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	keepJobs        = 10
)

var (
	ErrBusy  = errors.New("an update is already running")
	ErrNoJob = errors.New("no such job")
)

// Step is one stage of a job; it writes its output to w.
type Step struct {
	Title string
	Run   func(ctx context.Context, w io.Writer) error
}

type UpdateJob struct {
	ID         string     `json:"id"`
	Status     string     `json:"status" enum:"running,succeeded,failed"`
	Error      string     `json:"error,omitempty"`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	Stage      int        `json:"stage" doc:"1-based index of the running (or last) step"`
	Stages     int        `json:"stages" doc:"How many steps the job has, the updater's restart included"`
	StageTitle string     `json:"stage_title,omitempty"`
}

type UpdateJobLog struct {
	Job   UpdateJob `json:"job"`
	Lines []string  `json:"lines"`
	Next  int       `json:"next" doc:"Pass as after to get the lines that follow"`
}

// Jobs runs one job at a time and keeps each job's status (<id>.json) and output (<id>.log) in
// dir, so a restarted updater can still report how the last update ended.
type Jobs struct {
	dir string
	wg  sync.WaitGroup

	mu      sync.Mutex
	running bool
	last    int64 // the last ID handed out, so IDs stay unique and ordered
}

func OpenJobs(dir string) (*Jobs, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	j := &Jobs{dir: dir}
	for _, id := range j.ids() { // stay above stored IDs even if the clock stepped back
		if n, err := strconv.ParseInt(id, 10, 64); err == nil {
			j.last = max(j.last, n)
		}
	}
	for _, id := range j.ids() {
		job, err := j.read(id)
		if err != nil || job.Status != StatusRunning {
			continue
		}
		now := time.Now()
		job.Status, job.Error, job.FinishedAt = StatusFailed, "interrupted", &now
		if err := j.write(job); err != nil {
			return nil, err
		}
	}
	j.prune()
	return j, nil
}

// validID: IDs are zero-padded nanosecond times, so anything else (like "../x") is refused.
func validID(id string) bool {
	if id == "" || len(id) > 20 {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// ids lists the stored jobs, oldest first.
func (j *Jobs) ids() []string {
	m, _ := filepath.Glob(filepath.Join(j.dir, "*.json"))
	ids := make([]string, 0, len(m))
	for _, p := range m {
		if id := strings.TrimSuffix(filepath.Base(p), ".json"); validID(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

func (j *Jobs) prune() {
	ids := j.ids()
	for len(ids) > keepJobs {
		_ = os.Remove(filepath.Join(j.dir, ids[0]+".json"))
		_ = os.Remove(filepath.Join(j.dir, ids[0]+".log"))
		ids = ids[1:]
	}
}

func (j *Jobs) read(id string) (UpdateJob, error) {
	var job UpdateJob
	b, err := os.ReadFile(filepath.Join(j.dir, id+".json"))
	if err != nil {
		return job, err
	}
	return job, json.Unmarshal(b, &job)
}

// write replaces <id>.json atomically.
func (j *Jobs) write(job UpdateJob) error {
	b, err := json.Marshal(job)
	if err != nil {
		return err
	}
	tmp := filepath.Join(j.dir, job.ID+".json.tmp")
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(j.dir, job.ID+".json"))
}

// Start runs steps in the background, stopping at the first error. When all succeed the job is
// recorded as succeeded and only then final runs: final may end this process (the updater
// replacing itself), and the record must not be left saying "running".
func (j *Jobs) Start(steps []Step, final *Step) (string, error) {
	j.mu.Lock()
	if j.running {
		j.mu.Unlock()
		return "", ErrBusy
	}
	n := time.Now().UnixNano()
	if n <= j.last {
		n = j.last + 1
	}
	j.last, j.running = n, true
	j.mu.Unlock()

	job := UpdateJob{ID: fmt.Sprintf("%020d", n), Status: StatusRunning, StartedAt: time.Now(), Stages: len(steps)}
	if final != nil {
		job.Stages++
	}
	if err := j.write(job); err != nil {
		j.mu.Lock()
		j.running = false
		j.mu.Unlock()
		return "", err
	}
	j.prune()
	j.wg.Add(1)
	go j.run(job, steps, final)
	return job.ID, nil
}

func (j *Jobs) run(job UpdateJob, steps []Step, final *Step) {
	defer j.wg.Done()
	defer func() {
		j.mu.Lock()
		j.running = false
		j.mu.Unlock()
	}()
	f, err := os.OpenFile(filepath.Join(j.dir, job.ID+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		j.finish(job, fmt.Errorf("log: %w", err))
		return
	}
	defer f.Close()
	w := &syncWriter{w: f} // compose writes stdout and stderr from two goroutines
	ctx := context.Background()
	for i, s := range steps {
		job.Stage, job.StageTitle = i+1, s.Title
		_ = j.write(job)
		fmt.Fprintf(w, "==> %s\n", s.Title)
		if err := s.Run(ctx, w); err != nil {
			fmt.Fprintf(w, "!! %s failed: %v\n", s.Title, err)
			j.finish(job, fmt.Errorf("%s: %w", s.Title, err))
			return
		}
	}
	job = j.finish(job, nil)
	if final != nil {
		job.Stage, job.StageTitle = job.Stages, final.Title
		_ = j.write(job)
		fmt.Fprintf(w, "==> %s\n", final.Title)
		if err := final.Run(ctx, w); err != nil {
			fmt.Fprintf(w, "!! %s failed: %v (the rest of the update is done)\n", final.Title, err)
		}
	}
}

func (j *Jobs) finish(job UpdateJob, err error) UpdateJob {
	now := time.Now()
	job.FinishedAt, job.Status = &now, StatusSucceeded
	if err != nil {
		job.Status, job.Error = StatusFailed, err.Error()
	}
	_ = j.write(job)
	return job
}

// Log returns the job and its complete output lines from index after on. A line still being
// written is left for the next call.
func (j *Jobs) Log(id string, after int) (UpdateJobLog, error) {
	if !validID(id) {
		return UpdateJobLog{}, ErrNoJob
	}
	job, err := j.read(id)
	if err != nil {
		return UpdateJobLog{}, ErrNoJob
	}
	b, _ := os.ReadFile(filepath.Join(j.dir, id+".log"))
	text := string(b)
	if i := strings.LastIndexByte(text, '\n'); i >= 0 {
		text = text[:i] // drop the trailing newline and any unfinished line
	} else {
		text = ""
	}
	lines := []string{}
	if text != "" {
		lines = strings.Split(text, "\n")
	}
	after = max(0, min(after, len(lines)))
	return UpdateJobLog{Job: job, Lines: lines[after:], Next: len(lines)}, nil
}

// Wait blocks until the running job, if any, is done.
func (j *Jobs) Wait() { j.wg.Wait() }

type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}
