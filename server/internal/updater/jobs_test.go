package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func say(title, out string, err error) Step {
	return Step{Title: title, Run: func(_ context.Context, w io.Writer) error {
		fmt.Fprintln(w, out)
		return err
	}}
}

func TestJobRunsStepsInOrder(t *testing.T) {
	j, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	var order []string
	rec := func(name string) Step {
		return Step{Title: name, Run: func(context.Context, io.Writer) error { order = append(order, name); return nil }}
	}
	final := rec("self")
	id, err := j.Start([]Step{rec("pull"), rec("build"), rec("up")}, &final)
	require.NoError(t, err)
	j.Wait()
	require.Equal(t, []string{"pull", "build", "up", "self"}, order)
	log, err := j.Log(id, 0)
	require.NoError(t, err)
	require.Equal(t, StatusSucceeded, log.Job.Status)
	require.Contains(t, log.Lines, "==> pull")
}

func TestJobStopsAtFirstFailure(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	ran := false
	final := Step{Title: "self", Run: func(context.Context, io.Writer) error { ran = true; return nil }}
	id, _ := j.Start([]Step{say("pull", "Already up to date.", nil), say("build", "boom", errors.New("exit status 1")), say("up", "never", nil)}, &final)
	j.Wait()
	log, _ := j.Log(id, 0)
	require.Equal(t, StatusFailed, log.Job.Status)
	require.Contains(t, log.Job.Error, "build")
	require.NotContains(t, log.Lines, "never")
	require.False(t, ran, "the updater does not replace itself after a failed update")
}

func TestJobFinalStepRunsAfterSuccessIsRecorded(t *testing.T) {
	dir := t.TempDir()
	j, _ := OpenJobs(dir)
	var statusDuringFinal string
	ids := make(chan string, 1)
	final := Step{Title: "self", Run: func(context.Context, io.Writer) error {
		id := <-ids
		var job UpdateJob
		b, _ := os.ReadFile(filepath.Join(dir, id+".json"))
		_ = json.Unmarshal(b, &job)
		statusDuringFinal = job.Status
		return nil
	}}
	id, _ := j.Start([]Step{say("pull", "ok", nil)}, &final)
	ids <- id
	j.Wait()
	require.Equal(t, StatusSucceeded, statusDuringFinal, "a self-update that ends the process must already be recorded as succeeded")
}

func TestJobLogOffsets(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	id, _ := j.Start([]Step{say("a", "one\ntwo", nil)}, nil)
	j.Wait()
	all, _ := j.Log(id, 0)
	require.Equal(t, []string{"==> a", "one", "two"}, all.Lines)
	rest, _ := j.Log(id, 2)
	require.Equal(t, []string{"two"}, rest.Lines)
	require.Equal(t, 3, rest.Next)
	past, _ := j.Log(id, 1000)
	require.Empty(t, past.Lines)
	require.Equal(t, 3, past.Next)
}

func TestJobBusy(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	release := make(chan struct{})
	_, err := j.Start([]Step{{Title: "slow", Run: func(context.Context, io.Writer) error { <-release; return nil }}}, nil)
	require.NoError(t, err)
	_, err = j.Start([]Step{say("b", "", nil)}, nil)
	require.ErrorIs(t, err, ErrBusy)
	close(release)
	j.Wait()
}

func TestJobInterruptedOnRestart(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "00000000000000000001.json"), []byte(`{"id":"00000000000000000001","status":"running"}`), 0o644))
	j, err := OpenJobs(dir)
	require.NoError(t, err)
	log, err := j.Log("00000000000000000001", 0)
	require.NoError(t, err)
	require.Equal(t, StatusFailed, log.Job.Status)
	require.Equal(t, "interrupted", log.Job.Error)
}

func TestJobRejectsBadIDs(t *testing.T) {
	j, _ := OpenJobs(t.TempDir())
	for _, id := range []string{"", "../etc/passwd", "12a", "999"} {
		_, err := j.Log(id, 0)
		require.ErrorIs(t, err, ErrNoJob, id)
	}
}

func TestJobsKeepTen(t *testing.T) {
	dir := t.TempDir()
	j, _ := OpenJobs(dir)
	for i := 0; i < 12; i++ {
		_, err := j.Start([]Step{say("a", "x", nil)}, nil)
		require.NoError(t, err)
		j.Wait()
	}
	m, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	require.Len(t, m, keepJobs)
	logs, _ := filepath.Glob(filepath.Join(dir, "*.log"))
	require.Len(t, logs, keepJobs)
}

func TestJobIDsStayAboveStoredOnes(t *testing.T) {
	dir := t.TempDir()
	const old = "09000000000000000000"
	require.NoError(t, os.WriteFile(filepath.Join(dir, old+".json"), []byte(`{"id":"`+old+`","status":"succeeded"}`), 0o644))
	j, err := OpenJobs(dir)
	require.NoError(t, err)
	id, err := j.Start([]Step{say("a", "x", nil)}, nil)
	require.NoError(t, err)
	j.Wait()
	require.Greater(t, id, old)
	log, err := j.Log(id, 0)
	require.NoError(t, err)
	require.Equal(t, StatusSucceeded, log.Job.Status)
}

func TestJobStages(t *testing.T) {
	j, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	var id string
	seen := []UpdateJob{}
	gate := make(chan struct{})
	look := func(context.Context, io.Writer) error {
		<-gate
		l, err := j.Log(id, 0)
		if err != nil {
			return err
		}
		seen = append(seen, l.Job)
		return nil
	}
	final := &Step{Title: "last", Run: func(context.Context, io.Writer) error { return nil }}
	id, err = j.Start([]Step{{Title: "one", Run: look}, {Title: "two", Run: look}}, final)
	require.NoError(t, err)
	close(gate)
	j.Wait()
	require.Len(t, seen, 2)
	require.Equal(t, 1, seen[0].Stage)
	require.Equal(t, "one", seen[0].StageTitle)
	require.Equal(t, 2, seen[1].Stage)
	require.Equal(t, 3, seen[1].Stages)
	l, err := j.Log(id, 0)
	require.NoError(t, err)
	require.Equal(t, StatusSucceeded, l.Job.Status)
	require.Equal(t, 3, l.Job.Stage)
	require.Equal(t, "last", l.Job.StageTitle)
}

// The final step replaces the updater, which ends `updater deploy` sessions following the job.
// Handover leaves them time to read "succeeded" first.
func TestJobHandoverBeforeFinal(t *testing.T) {
	j, err := OpenJobs(t.TempDir())
	require.NoError(t, err)
	j.Handover = 80 * time.Millisecond
	var id string
	var waited time.Duration
	final := &Step{Title: "last", Run: func(context.Context, io.Writer) error {
		l, err := j.Log(id, 0)
		if err != nil {
			return err
		}
		waited = time.Since(*l.Job.FinishedAt)
		return nil
	}}
	id, err = j.Start([]Step{{Title: "one", Run: func(context.Context, io.Writer) error { return nil }}}, final)
	require.NoError(t, err)
	j.Wait()
	require.GreaterOrEqual(t, waited, j.Handover)
}
