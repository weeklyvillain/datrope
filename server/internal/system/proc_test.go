package system

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestParseCPU(t *testing.T) {
	// user nice system idle iowait irq softirq steal guest guest_nice
	stat := "cpu  100 0 50 800 50 0 0 0 30 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1\n"
	c, err := parseCPU([]byte(stat))
	require.NoError(t, err)
	require.Equal(t, cpuTimes{idle: 850, total: 1000}, c, "guest is already in user; idle includes iowait")

	_, err = parseCPU([]byte("intr 1\n"))
	require.Error(t, err)
}

func TestCPUPercent(t *testing.T) {
	require.InDelta(t, 25.0, cpuPercent(cpuTimes{idle: 850, total: 1000}, cpuTimes{idle: 1000, total: 1200}), 0.001)
	require.Zero(t, cpuPercent(cpuTimes{idle: 1, total: 10}, cpuTimes{idle: 1, total: 10}), "no time passed")
	require.Zero(t, cpuPercent(cpuTimes{idle: 5, total: 10}, cpuTimes{idle: 1, total: 4}), "counters reset")
}

func TestParseMeminfo(t *testing.T) {
	m, err := parseMeminfo([]byte("MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    4000000 kB\n"))
	require.NoError(t, err)
	require.Equal(t, memInfo{total: 16000000 * 1024, available: 4000000 * 1024}, m)

	_, err = parseMeminfo([]byte("MemFree: 1 kB\n"))
	require.Error(t, err)
}

func TestParseUptime(t *testing.T) {
	d, err := parseUptime([]byte("3600.50 7000.00\n"))
	require.NoError(t, err)
	require.Equal(t, 3600*time.Second+500*time.Millisecond, d)
}
