package system

import (
	"context"
	"io/fs"
	"log/slog"
	"path/filepath"
	"sync"
	"time"
)

const (
	sampleEvery = 5 * time.Second
	keepSamples = 120 // 10 minutes
	slowEvery   = 5 * time.Minute
)

// SystemSample is one reading of the host.
type SystemSample struct {
	At          time.Time `json:"at"`
	CPUPercent  float64   `json:"cpu_percent"`
	MemUsed     uint64    `json:"mem_used"`
	MemTotal    uint64    `json:"mem_total"`
	DiskUsed    uint64    `json:"disk_used"`
	DiskTotal   uint64    `json:"disk_total"`
	Connections int       `json:"connections" doc:"Open gateway WebSockets"`
	InVoice     int       `json:"in_voice" doc:"People in voice channels"`
}

// HostStats is what the dashboard shows about the machine.
type HostStats struct {
	Latest               *SystemSample  `json:"latest"`
	Series               []SystemSample `json:"series" doc:"Oldest first, every 5 s, up to 10 minutes"`
	HostUptimeSeconds    int64          `json:"host_uptime_seconds"`
	ProcessUptimeSeconds int64          `json:"process_uptime_seconds"`
	DatabaseBytes        int64          `json:"database_bytes"`
	FilesBytes           int64          `json:"files_bytes"`
}

// Sources are where the sampler reads from; tests replace them.
type Sources struct {
	Proc         fs.FS // /proc; nil off Linux
	DataDir      string
	Disk         func(path string) (used, total uint64, err error) // nil: diskUsage
	Connections  func() int
	InVoice      func() int
	DatabaseSize func(ctx context.Context) (int64, error)
}

// Sampler keeps the last ten minutes of host readings in memory.
type Sampler struct {
	src     Sources
	started time.Time

	mu         sync.Mutex
	prev       cpuTimes
	havePrev   bool
	ring       []SystemSample
	hostUptime time.Duration
	dbBytes    int64
	filesBytes int64
}

func NewSampler(src Sources, started time.Time) *Sampler {
	if src.Disk == nil {
		src.Disk = diskUsage
	}
	return &Sampler{src: src, started: started}
}

// Sample takes one reading. Sources that fail leave their fields zero.
func (s *Sampler) Sample(now time.Time) {
	x := SystemSample{At: now}
	var cpu cpuTimes
	cpuOK := false
	var up time.Duration
	if s.src.Proc != nil {
		if b, err := fs.ReadFile(s.src.Proc, "stat"); err == nil {
			cpu, err = parseCPU(b)
			cpuOK = err == nil
		}
		if b, err := fs.ReadFile(s.src.Proc, "meminfo"); err == nil {
			if m, err := parseMeminfo(b); err == nil {
				x.MemTotal, x.MemUsed = m.total, m.total-min(m.available, m.total)
			}
		}
		if b, err := fs.ReadFile(s.src.Proc, "uptime"); err == nil {
			up, _ = parseUptime(b)
		}
	}
	if used, total, err := s.src.Disk(s.src.DataDir); err == nil {
		x.DiskUsed, x.DiskTotal = used, total
	}
	if s.src.Connections != nil {
		x.Connections = s.src.Connections()
	}
	if s.src.InVoice != nil {
		x.InVoice = s.src.InVoice()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if cpuOK {
		if s.havePrev {
			x.CPUPercent = cpuPercent(s.prev, cpu)
		}
		s.prev, s.havePrev = cpu, true
	}
	if up > 0 {
		s.hostUptime = up
	}
	s.ring = append(s.ring, x)
	if len(s.ring) > keepSamples {
		s.ring = append(s.ring[:0], s.ring[len(s.ring)-keepSamples:]...)
	}
}

// SampleSlow measures the database and the stored files.
func (s *Sampler) SampleSlow(ctx context.Context) {
	var db int64
	if s.src.DatabaseSize != nil {
		n, err := s.src.DatabaseSize(ctx)
		if err != nil {
			slog.Warn("system: database size", "err", err)
		}
		db = n
	}
	var files int64
	if s.src.DataDir != "" {
		_ = filepath.WalkDir(filepath.Join(s.src.DataDir, "files"), func(_ string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // removed while walking, or no files dir yet
			}
			if d.Type().IsRegular() {
				if info, err := d.Info(); err == nil {
					files += info.Size()
				}
			}
			return nil
		})
	}
	s.mu.Lock()
	s.dbBytes, s.filesBytes = db, files
	s.mu.Unlock()
}

func (s *Sampler) Snapshot(now time.Time) HostStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := HostStats{
		Series:               append([]SystemSample{}, s.ring...),
		HostUptimeSeconds:    int64(s.hostUptime / time.Second),
		ProcessUptimeSeconds: int64(now.Sub(s.started) / time.Second),
		DatabaseBytes:        s.dbBytes,
		FilesBytes:           s.filesBytes,
	}
	if n := len(h.Series); n > 0 {
		last := h.Series[n-1]
		h.Latest = &last
	}
	return h
}

// Run samples until ctx ends.
func (s *Sampler) Run(ctx context.Context) {
	s.Sample(time.Now())
	s.SampleSlow(ctx)
	fast, slow := time.NewTicker(sampleEvery), time.NewTicker(slowEvery)
	defer fast.Stop()
	defer slow.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-fast.C:
			s.Sample(now)
		case <-slow.C:
			s.SampleSlow(ctx)
		}
	}
}
