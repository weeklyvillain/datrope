// Package system is the instance admin's dashboard: host metrics, and updates of the server
// (through the updater container) and of yt-dlp.
package system

import (
	"context"
	"sync"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

type Deps struct {
	Sources      Sources
	YtDlp        YtDlpOptions
	UpdaterURL   string
	UpdaterToken string // empty: no updater; server updates and restarts are off
}

type Service struct {
	sampler *Sampler
	yt      *YtDlp
	up      *updaterClient // nil when not configured

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func NewService(d Deps) *Service {
	ctx, cancel := context.WithCancel(context.Background())
	return &Service{
		sampler: NewSampler(d.Sources, time.Now()),
		yt:      NewYtDlp(d.YtDlp),
		up:      newUpdaterClient(d.UpdaterURL, d.UpdaterToken),
		ctx:     ctx, cancel: cancel,
	}
}

// Start samples the host and checks yt-dlp daily until Close.
func (s *Service) Start() {
	s.wg.Add(2)
	go func() { defer s.wg.Done(); s.sampler.Run(s.ctx) }()
	go func() { defer s.wg.Done(); s.yt.RunDaily(s.ctx) }()
}

func (s *Service) Close() {
	s.cancel()
	s.wg.Wait()
}

type SystemStats struct {
	Host              HostStats               `json:"host"`
	Containers        []updater.ContainerInfo `json:"containers"`
	UpdaterConfigured bool                    `json:"updater_configured"`
	UpdaterError      string                  `json:"updater_error,omitempty"`
}

type ServerUpdate struct {
	Configured bool               `json:"configured" doc:"DATROPE_UPDATER_TOKEN is set"`
	Error      string             `json:"error,omitempty"`
	Status     *updater.GitStatus `json:"status,omitempty"`
}

type SystemUpdates struct {
	Server ServerUpdate `json:"server"`
	YtDlp  YtDlpStatus  `json:"ytdlp"`
}

type UpdateStarted struct {
	JobID string `json:"job_id"`
}

func (s *Service) stats(ctx context.Context) SystemStats {
	st := SystemStats{Host: s.sampler.Snapshot(time.Now()), Containers: []updater.ContainerInfo{}, UpdaterConfigured: s.up != nil}
	if s.up != nil {
		cs, err := s.up.containers(ctx)
		switch {
		case err != nil:
			st.UpdaterError = err.Error()
		case cs != nil:
			st.Containers = cs
		}
	}
	return st
}

func (s *Service) serverUpdate(ctx context.Context, check bool) ServerUpdate {
	u := ServerUpdate{Configured: s.up != nil}
	if s.up == nil {
		return u
	}
	get := s.up.status
	if check {
		get = s.up.check
	}
	st, err := get(ctx)
	if err != nil {
		u.Error = err.Error()
		return u
	}
	u.Status = &st
	return u
}

// updates reports both; check first asks GitHub and the updater for news (in parallel).
func (s *Service) updates(ctx context.Context, check bool) SystemUpdates {
	var u SystemUpdates
	if check {
		done := make(chan struct{})
		go func() { defer close(done); _ = s.yt.Check(ctx) }()
		u.Server = s.serverUpdate(ctx, true)
		<-done
	} else {
		u.Server = s.serverUpdate(ctx, false)
	}
	u.YtDlp = s.yt.Status()
	return u
}
