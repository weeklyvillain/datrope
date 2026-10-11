package system

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/datrope/datrope/server/internal/updater"
)

var errUpdaterDown = errors.New("updater unreachable")

// ReadTimeout bounds the read-only calls (containers, status, job), so a hanging updater cannot
// stall the polled stats endpoint. A variable so tests can shorten it.
var ReadTimeout = 10 * time.Second

// upstreamError is an error status from the updater.
type upstreamError struct {
	status int
	msg    string
}

func (e *upstreamError) Error() string { return fmt.Sprintf("updater: %d %s", e.status, e.msg) }

// updaterClient calls the updater container with the shared token.
type updaterClient struct {
	base, token string
	hc          *http.Client
}

func newUpdaterClient(base, token string) *updaterClient {
	if token == "" || base == "" {
		return nil
	}
	// Long enough for git fetch (check) and a compose restart; stats answer in about a second.
	return &updaterClient{base: strings.TrimSuffix(base, "/"), token: token, hc: &http.Client{Timeout: 3 * time.Minute}}
}

func (c *updaterClient) do(ctx context.Context, method, path string, out any) error {
	if method == http.MethodGet {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, ReadTimeout)
		defer cancel()
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	res, err := c.hc.Do(req)
	if err != nil {
		return errUpdaterDown
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		b, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if json.Unmarshal(b, &e) != nil || e.Error == "" {
			e.Error = strings.TrimSpace(string(b))
		}
		if res.StatusCode == http.StatusUnauthorized {
			e.Error = "updater rejected the token (check DATROPE_UPDATER_TOKEN)"
		}
		return &upstreamError{status: res.StatusCode, msg: e.Error}
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		if ctx.Err() != nil {
			return errUpdaterDown
		}
		return err
	}
	return nil
}

func (c *updaterClient) status(ctx context.Context) (updater.GitStatus, error) {
	var s updater.GitStatus
	return s, c.do(ctx, http.MethodGet, "/status", &s)
}

func (c *updaterClient) check(ctx context.Context) (updater.GitStatus, error) {
	var s updater.GitStatus
	return s, c.do(ctx, http.MethodPost, "/check", &s)
}

func (c *updaterClient) update(ctx context.Context) (string, error) {
	var r struct {
		JobID string `json:"job_id"`
	}
	return r.JobID, c.do(ctx, http.MethodPost, "/update", &r)
}

func (c *updaterClient) job(ctx context.Context, id string, after int) (updater.UpdateJobLog, error) {
	var l updater.UpdateJobLog
	return l, c.do(ctx, http.MethodGet, "/jobs/"+url.PathEscape(id)+"?after="+strconv.Itoa(after), &l)
}

func (c *updaterClient) containers(ctx context.Context) ([]updater.ContainerInfo, error) {
	var cs []updater.ContainerInfo
	return cs, c.do(ctx, http.MethodGet, "/containers", &cs)
}

func (c *updaterClient) restart(ctx context.Context, service string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(service)+"/restart", nil)
}
