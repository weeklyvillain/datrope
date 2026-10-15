package updater

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Probe fetches a server's /healthz and returns the build it reports.
type Probe func(ctx context.Context, url string) (string, error)

func HTTPProbe(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("healthz: %s", res.Status)
	}
	var b struct {
		Build string `json:"build"`
	}
	if err := json.NewDecoder(res.Body).Decode(&b); err != nil {
		return "", fmt.Errorf("healthz: %w", err)
	}
	return b.Build, nil
}

// WaitHealthy waits until service's container is healthy and its /healthz reports build: being
// healthy alone could be the previous image if the container was not recreated.
func (c Compose) WaitHealthy(ctx context.Context, w io.Writer, service, build string, probe Probe, timeout, every time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	last := ""
	for {
		state := c.healthState(ctx, service, build, probe)
		if state == "ready" {
			fmt.Fprintf(w, "%s is healthy and runs %s\n", service, build)
			return nil
		}
		if state != last {
			fmt.Fprintf(w, "%s: %s\n", service, state)
			last = state
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s not ready after %s: %s", service, timeout, last)
		case <-time.After(every):
		}
	}
}

func (c Compose) healthState(ctx context.Context, service, build string, probe Probe) string {
	var b bytes.Buffer
	if err := c.cmd(ctx, &b, "ps", "-q", service); err != nil || strings.TrimSpace(b.String()) == "" {
		return "no container"
	}
	id := strings.TrimSpace(b.String())
	b.Reset()
	if err := c.Run(ctx, &b, "docker", "inspect", "--format", "{{.State.Health.Status}}", id); err != nil {
		return "inspect failed"
	}
	if h := strings.TrimSpace(b.String()); h != "healthy" {
		return h
	}
	got, err := probe(ctx, "http://"+service+":8080/healthz")
	if err != nil {
		return err.Error()
	}
	if got != build {
		return "healthy but runs " + got
	}
	return "ready"
}
