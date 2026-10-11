package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"
)

// Docker talks to the Docker Engine API over its unix socket (three endpoints, so no SDK).
type Docker struct {
	hc   *http.Client
	base string
}

func NewDocker(socket string) *Docker {
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", socket)
	}}
	return &Docker{hc: &http.Client{Transport: tr, Timeout: 30 * time.Second}, base: "http://docker"}
}

func (d *Docker) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, d.base+path, nil)
	if err != nil {
		return err
	}
	res, err := d.hc.Do(req)
	if err != nil {
		return fmt.Errorf("docker: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("docker: GET %s: %s", path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type ContainerInfo struct {
	Service    string  `json:"service"`
	Name       string  `json:"name"`
	State      string  `json:"state" doc:"running, exited, restarting, ..."`
	Status     string  `json:"status" doc:"Docker's description, e.g. Up 3 hours (healthy)"`
	CPUPercent float64 `json:"cpu_percent" doc:"100 = one core"`
	MemBytes   uint64  `json:"mem_bytes"`
	MemLimit   uint64  `json:"mem_limit"`
}

type listed struct {
	ID     string            `json:"Id"`
	Names  []string          `json:"Names"`
	State  string            `json:"State"`
	Status string            `json:"Status"`
	Labels map[string]string `json:"Labels"`
}

type cpuStats struct {
	Usage struct {
		Total uint64 `json:"total_usage"`
	} `json:"cpu_usage"`
	System uint64 `json:"system_cpu_usage"`
	Online uint32 `json:"online_cpus"`
}

type statsJSON struct {
	CPU    cpuStats `json:"cpu_stats"`
	PreCPU cpuStats `json:"precpu_stats"`
	Memory struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

// Containers lists the project's containers, with CPU and memory for the running ones.
func (d *Docker) Containers(ctx context.Context, project string) ([]ContainerInfo, error) {
	filters, _ := json.Marshal(map[string][]string{"label": {"com.docker.compose.project=" + project}})
	var ls []listed
	if err := d.get(ctx, "/containers/json?all=true&filters="+url.QueryEscape(string(filters)), &ls); err != nil {
		return nil, err
	}
	out := make([]ContainerInfo, len(ls))
	var g errgroup.Group
	for i, c := range ls {
		out[i] = ContainerInfo{Service: c.Labels["com.docker.compose.service"], State: c.State, Status: c.Status}
		if len(c.Names) > 0 {
			out[i].Name = strings.TrimPrefix(c.Names[0], "/")
		}
		if c.State != "running" {
			continue
		}
		g.Go(func() error {
			var s statsJSON
			if err := d.get(ctx, "/containers/"+url.PathEscape(c.ID)+"/stats?stream=false", &s); err != nil {
				return nil // it just stopped: show it without numbers
			}
			out[i].CPUPercent = cpuPercentOf(s)
			out[i].MemBytes, out[i].MemLimit = memOf(s), s.Memory.Limit
			return nil
		})
	}
	_ = g.Wait()
	sort.Slice(out, func(a, b int) bool {
		if out[a].Service != out[b].Service {
			return out[a].Service < out[b].Service
		}
		return out[a].Name < out[b].Name
	})
	return out, nil
}

func cpuPercentOf(s statsJSON) float64 {
	if s.CPU.Usage.Total < s.PreCPU.Usage.Total || s.CPU.System <= s.PreCPU.System {
		return 0
	}
	cpus := float64(s.CPU.Online)
	if cpus == 0 {
		cpus = 1
	}
	return float64(s.CPU.Usage.Total-s.PreCPU.Usage.Total) / float64(s.CPU.System-s.PreCPU.System) * cpus * 100
}

// memOf is what `docker stats` shows: usage minus page cache that can be dropped.
func memOf(s statsJSON) uint64 {
	inactive := s.Memory.Stats["inactive_file"]             // cgroup v2
	if v, ok := s.Memory.Stats["total_inactive_file"]; ok { // cgroup v1
		inactive = v
	}
	if inactive > s.Memory.Usage {
		return s.Memory.Usage
	}
	return s.Memory.Usage - inactive
}

// SelfInfo describes the updater's own container.
type SelfInfo struct {
	HostRepo string // host path of the dir mounted at mountedAt
	Project  string // com.docker.compose.project label
	Image    string // the image ID this container runs, e.g. "sha256:..."
	// ConfigFiles and WorkingDir are the compose files (host paths) and project directory the
	// stack was started with, from compose's labels; empty when unknown.
	ConfigFiles []string
	WorkingDir  string
}

// Self finds the host directory mounted at mountedAt in this container, the compose project this
// container belongs to, and its image.
func (d *Docker) Self(ctx context.Context, containerID, mountedAt string) (SelfInfo, error) {
	var c struct {
		Image  string `json:"Image"`
		Mounts []struct {
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := d.get(ctx, "/containers/"+url.PathEscape(containerID)+"/json", &c); err != nil {
		return SelfInfo{}, err
	}
	l := c.Config.Labels
	info := SelfInfo{Project: l["com.docker.compose.project"], Image: c.Image, WorkingDir: l["com.docker.compose.project.working_dir"]}
	for _, f := range strings.Split(l["com.docker.compose.project.config_files"], ",") {
		if f = strings.TrimSpace(f); f != "" {
			info.ConfigFiles = append(info.ConfigFiles, f)
		}
	}
	for _, m := range c.Mounts {
		if m.Destination == mountedAt {
			info.HostRepo = m.Source
		}
	}
	if info.HostRepo == "" || info.Project == "" || info.Image == "" {
		return SelfInfo{}, fmt.Errorf("updater: run me with docker compose and the repo mounted at %s", mountedAt)
	}
	return info, nil
}
