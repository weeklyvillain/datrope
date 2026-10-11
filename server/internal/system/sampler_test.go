package system

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/stretchr/testify/require"
)

func procFS(stat string) fstest.MapFS {
	return fstest.MapFS{
		"stat":    {Data: []byte(stat)},
		"meminfo": {Data: []byte("MemTotal: 1000 kB\nMemAvailable: 250 kB\n")},
		"uptime":  {Data: []byte("7200.00 1.00\n")},
	}
}

func TestSamplerSamples(t *testing.T) {
	proc := procFS("cpu  100 0 0 900 0 0 0 0\n")
	conns := 3
	s := NewSampler(Sources{
		Proc:        proc,
		DataDir:     t.TempDir(),
		Disk:        func(string) (uint64, uint64, error) { return 40, 100, nil },
		Connections: func() int { return conns },
		InVoice:     func() int { return 2 },
	}, time.Unix(1000, 0))

	s.Sample(time.Unix(1005, 0))
	proc["stat"] = &fstest.MapFile{Data: []byte("cpu  150 0 0 950 0 0 0 0\n")}
	conns = 4
	s.Sample(time.Unix(1010, 0))

	snap := s.Snapshot(time.Unix(1010, 0))
	require.Len(t, snap.Series, 2)
	require.Zero(t, snap.Series[0].CPUPercent, "the first sample has nothing to compare with")
	require.Equal(t, SystemSample{
		At: time.Unix(1010, 0), CPUPercent: 50, MemUsed: 750 * 1024, MemTotal: 1000 * 1024,
		DiskUsed: 40, DiskTotal: 100, Connections: 4, InVoice: 2,
	}, *snap.Latest)
	require.Equal(t, int64(7200), snap.HostUptimeSeconds)
	require.Equal(t, int64(10), snap.ProcessUptimeSeconds)
}

func TestSamplerKeepsTenMinutes(t *testing.T) {
	s := NewSampler(Sources{Proc: procFS("cpu  1 0 0 1 0 0 0 0\n"), Disk: func(string) (uint64, uint64, error) { return 0, 0, nil }}, time.Unix(0, 0))
	for i := 0; i < keepSamples+5; i++ {
		s.Sample(time.Unix(int64(i*5), 0))
	}
	snap := s.Snapshot(time.Unix(0, 0))
	require.Len(t, snap.Series, keepSamples)
	require.Equal(t, time.Unix(25, 0), snap.Series[0].At, "oldest five dropped")
}

func TestSamplerWithoutProc(t *testing.T) {
	s := NewSampler(Sources{Disk: func(string) (uint64, uint64, error) { return 1, 2, nil }}, time.Unix(0, 0))
	s.Sample(time.Unix(5, 0))
	snap := s.Snapshot(time.Unix(5, 0))
	require.Equal(t, uint64(2), snap.Latest.DiskTotal, "disk still works off Linux")
	require.Zero(t, snap.Latest.MemTotal)
}

func TestSamplerSlow(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "files", "ab"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "files", "a"), make([]byte, 10), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "files", "ab", "b"), make([]byte, 5), 0o644))
	s := NewSampler(Sources{DataDir: dir, DatabaseSize: func(context.Context) (int64, error) { return 1234, nil }}, time.Unix(0, 0))
	s.SampleSlow(context.Background())
	snap := s.Snapshot(time.Unix(0, 0))
	require.Equal(t, int64(1234), snap.DatabaseBytes)
	require.Equal(t, int64(15), snap.FilesBytes)
	require.Nil(t, snap.Latest)
	require.NotNil(t, snap.Series, "an empty series is [] in JSON, not null")
}
