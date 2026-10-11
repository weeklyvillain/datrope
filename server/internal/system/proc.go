package system

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Parsers for /proc files. Inside a container without lxcfs they describe the host,
// which is what the dashboard shows.

type cpuTimes struct{ idle, total uint64 }

// parseCPU reads the aggregate "cpu" line of /proc/stat.
func parseCPU(stat []byte) (cpuTimes, error) {
	line, _, _ := bytes.Cut(stat, []byte("\n"))
	f := strings.Fields(string(line))
	if len(f) < 5 || f[0] != "cpu" {
		return cpuTimes{}, errors.New("system: no cpu line in /proc/stat")
	}
	var t cpuTimes
	for i, s := range f[1:] {
		if i >= 8 { // guest and guest_nice are already counted in user and nice
			break
		}
		n, err := strconv.ParseUint(s, 10, 64)
		if err != nil {
			return cpuTimes{}, fmt.Errorf("system: /proc/stat: %w", err)
		}
		t.total += n
		if i == 3 || i == 4 { // idle, iowait
			t.idle += n
		}
	}
	return t, nil
}

// cpuPercent is the busy share of the time between two readings.
func cpuPercent(prev, cur cpuTimes) float64 {
	if cur.total <= prev.total || cur.idle < prev.idle {
		return 0
	}
	dt, di := cur.total-prev.total, cur.idle-prev.idle
	if di > dt {
		return 0
	}
	return float64(dt-di) / float64(dt) * 100
}

type memInfo struct{ total, available uint64 } // bytes

func parseMeminfo(b []byte) (memInfo, error) {
	var m memInfo
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(v)
		if len(f) == 0 {
			continue
		}
		n, err := strconv.ParseUint(f[0], 10, 64)
		if err != nil {
			continue
		}
		switch k {
		case "MemTotal":
			m.total = n * 1024
		case "MemAvailable":
			m.available = n * 1024
		}
	}
	if m.total == 0 {
		return m, errors.New("system: no MemTotal in /proc/meminfo")
	}
	return m, nil
}

func parseUptime(b []byte) (time.Duration, error) {
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return 0, errors.New("system: empty /proc/uptime")
	}
	s, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return 0, fmt.Errorf("system: /proc/uptime: %w", err)
	}
	return time.Duration(s * float64(time.Second)), nil
}
